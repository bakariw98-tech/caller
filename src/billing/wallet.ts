import type { DB } from '../db/index.js';
import { transact } from '../db/index.js';
import { id, now } from '../util/ids.js';
import type { Wallet } from '../domain/types.js';
import { retailCentsForSeconds } from './pricing.js';

export class CrossCreatorCreditError extends Error {
  constructor() {
    super('Refusing to move credit between creators. Balances are scoped to one coach.');
    this.name = 'CrossCreatorCreditError';
  }
}

export function getWallet(db: DB, customerId: string, creatorId: string): Wallet {
  const existing = db
    .prepare('SELECT * FROM wallets WHERE customer_id = ? AND creator_id = ?')
    .get(customerId, creatorId) as Wallet | undefined;
  if (existing) return existing;

  const walletId = id('wal');
  db.prepare(
    `INSERT INTO wallets (id, customer_id, creator_id, paid_seconds, promotional_seconds, updated_at)
     VALUES (?, ?, ?, 0, 0, ?)`,
  ).run(walletId, customerId, creatorId, now());
  return db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId) as Wallet;
}

export function balanceSeconds(db: DB, customerId: string, creatorId: string): number {
  const w = getWallet(db, customerId, creatorId);
  return w.paid_seconds + w.promotional_seconds;
}

/**
 * Manual top-up. There is deliberately no auto-recharge anywhere in this
 * codebase: the product is credits a customer chooses to buy, not a
 * subscription that renews while they are not looking.
 */
export function topUp(
  db: DB,
  params: {
    customerId: string;
    creatorId: string;
    seconds: number;
    paidCents: number;
    reason?: string;
  },
): Wallet {
  if (params.seconds <= 0) throw new Error('Top-up must add a positive number of seconds');

  return transact(db, () => {
    const wallet = getWallet(db, params.customerId, params.creatorId);
    if (wallet.creator_id !== params.creatorId) throw new CrossCreatorCreditError();

    db.prepare('UPDATE wallets SET paid_seconds = paid_seconds + ?, updated_at = ? WHERE id = ?').run(
      params.seconds,
      now(),
      wallet.id,
    );
    db.prepare(
      `INSERT INTO ledger (id, wallet_id, creator_id, kind, bucket, seconds_delta, cents_delta, reason, created_at)
       VALUES (?, ?, ?, 'topup', 'paid', ?, ?, ?, ?)`,
    ).run(
      id('led'),
      wallet.id,
      params.creatorId,
      params.seconds,
      params.paidCents,
      params.reason ?? 'Credit purchase',
      now(),
    );

    return db.prepare('SELECT * FROM wallets WHERE id = ?').get(wallet.id) as Wallet;
  });
}

export interface DebitResult {
  fromPromotional: number;
  fromPaid: number;
  shortfall: number;
  remainingSeconds: number;
  retailCents: number;
}

/**
 * Draws `seconds` from a wallet, promotional credit first.
 *
 * Returns a shortfall rather than throwing when the balance runs out mid-call:
 * the caller is already talking, and the right response is to warn and wind the
 * call down, not to fail a database write.
 */
export function debitSeconds(
  db: DB,
  params: {
    customerId: string;
    creatorId: string;
    seconds: number;
    callId: string;
    centsPerMinute: number;
  },
): DebitResult {
  if (params.seconds <= 0) {
    const w = getWallet(db, params.customerId, params.creatorId);
    return {
      fromPromotional: 0,
      fromPaid: 0,
      shortfall: 0,
      remainingSeconds: w.paid_seconds + w.promotional_seconds,
      retailCents: 0,
    };
  }

  return transact(db, () => {
    const wallet = getWallet(db, params.customerId, params.creatorId);
    if (wallet.creator_id !== params.creatorId) throw new CrossCreatorCreditError();

    const fromPromotional = Math.min(wallet.promotional_seconds, params.seconds);
    const afterPromo = params.seconds - fromPromotional;
    const fromPaid = Math.min(wallet.paid_seconds, afterPromo);
    const shortfall = afterPromo - fromPaid;
    const ts = now();

    db.prepare(
      `UPDATE wallets
          SET promotional_seconds = promotional_seconds - ?,
              paid_seconds = paid_seconds - ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(fromPromotional, fromPaid, ts, wallet.id);

    // Promotional consumption is also charged against the creator's funded pool
    // so a trial can never outlive the money behind it.
    if (fromPromotional > 0) {
      db.prepare(
        `UPDATE promotional_budgets
            SET consumed_seconds = consumed_seconds + ?
          WHERE id = (
            SELECT budget_id FROM promotional_grants
             WHERE customer_id = ?
             ORDER BY created_at DESC LIMIT 1
          )`,
      ).run(fromPromotional, params.customerId);

      db.prepare(
        `INSERT INTO ledger (id, wallet_id, creator_id, kind, bucket, seconds_delta, cents_delta, reason, call_id, created_at)
         VALUES (?, ?, ?, 'usage', 'promotional', ?, 0, 'Coaching call (promotional)', ?, ?)`,
      ).run(id('led'), wallet.id, params.creatorId, -fromPromotional, params.callId, ts);
    }

    const retailCents = retailCentsForSeconds(fromPaid, params.centsPerMinute);
    if (fromPaid > 0) {
      db.prepare(
        `INSERT INTO ledger (id, wallet_id, creator_id, kind, bucket, seconds_delta, cents_delta, reason, call_id, created_at)
         VALUES (?, ?, ?, 'usage', 'paid', ?, ?, 'Coaching call', ?, ?)`,
      ).run(id('led'), wallet.id, params.creatorId, -fromPaid, retailCents, params.callId, ts);
    }

    const after = db.prepare('SELECT * FROM wallets WHERE id = ?').get(wallet.id) as Wallet;
    return {
      fromPromotional,
      fromPaid,
      shortfall,
      remainingSeconds: after.paid_seconds + after.promotional_seconds,
      retailCents,
    };
  });
}
