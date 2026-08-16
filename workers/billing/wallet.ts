import type { SqlDb } from '../db/types.js';
import { id, now } from '../../src/util/ids.js';
import type { Wallet } from '../../src/domain/types.js';
import { retailCentsForSeconds } from './pricing.js';

/**
 * NOTE on concurrency: unlike the Node build, which wraps every debit in a
 * `db.transaction(...).immediate()` (better-sqlite3's serialised
 * read-modify-write), D1's atomic primitive is `batch()` over a pre-built
 * array of statements — it doesn't fit a "read the balance, then decide what
 * to write" flow. A single caller debiting their own wallet every fifteen
 * seconds, which is this app's actual access pattern, will not race with
 * itself. Two concurrent calls against the *same* wallet at the *same*
 * instant could. Acceptable for a first deployment; if that ever becomes a
 * real pattern, move wallet state into the call's Durable Object (DO storage
 * transactions are properly serialised) or D1's Sessions API.
 */

export class CrossCreatorCreditError extends Error {
  constructor() {
    super('Refusing to move credit between creators. Balances are scoped to one coach.');
    this.name = 'CrossCreatorCreditError';
  }
}

export async function getWallet(db: SqlDb, customerId: string, creatorId: string): Promise<Wallet> {
  const existing = await db
    .prepare('SELECT * FROM wallets WHERE customer_id = ? AND creator_id = ?')
    .get<Wallet>(customerId, creatorId);
  if (existing) return existing;

  const walletId = id('wal');
  await db
    .prepare(
      `INSERT INTO wallets (id, customer_id, creator_id, paid_seconds, promotional_seconds, updated_at)
       VALUES (?, ?, ?, 0, 0, ?)`,
    )
    .run(walletId, customerId, creatorId, now());
  return (await db.prepare('SELECT * FROM wallets WHERE id = ?').get<Wallet>(walletId))!;
}

export async function balanceSeconds(db: SqlDb, customerId: string, creatorId: string): Promise<number> {
  const w = await getWallet(db, customerId, creatorId);
  return w.paid_seconds + w.promotional_seconds;
}

export async function topUp(
  db: SqlDb,
  params: { customerId: string; creatorId: string; seconds: number; paidCents: number; reason?: string },
): Promise<Wallet> {
  if (params.seconds <= 0) throw new Error('Top-up must add a positive number of seconds');

  const wallet = await getWallet(db, params.customerId, params.creatorId);
  if (wallet.creator_id !== params.creatorId) throw new CrossCreatorCreditError();

  await db
    .prepare('UPDATE wallets SET paid_seconds = paid_seconds + ?, updated_at = ? WHERE id = ?')
    .run(params.seconds, now(), wallet.id);
  await db
    .prepare(
      `INSERT INTO ledger (id, wallet_id, creator_id, kind, bucket, seconds_delta, cents_delta, reason, created_at)
       VALUES (?, ?, ?, 'topup', 'paid', ?, ?, ?, ?)`,
    )
    .run(id('led'), wallet.id, params.creatorId, params.seconds, params.paidCents, params.reason ?? 'Credit purchase', now());

  return (await db.prepare('SELECT * FROM wallets WHERE id = ?').get<Wallet>(wallet.id))!;
}

export interface DebitResult {
  fromPromotional: number;
  fromPaid: number;
  shortfall: number;
  remainingSeconds: number;
  retailCents: number;
}

export async function debitSeconds(
  db: SqlDb,
  params: { customerId: string; creatorId: string; seconds: number; callId: string; centsPerMinute: number },
): Promise<DebitResult> {
  const wallet = await getWallet(db, params.customerId, params.creatorId);
  if (wallet.creator_id !== params.creatorId) throw new CrossCreatorCreditError();

  if (params.seconds <= 0) {
    return {
      fromPromotional: 0,
      fromPaid: 0,
      shortfall: 0,
      remainingSeconds: wallet.paid_seconds + wallet.promotional_seconds,
      retailCents: 0,
    };
  }

  const fromPromotional = Math.min(wallet.promotional_seconds, params.seconds);
  const afterPromo = params.seconds - fromPromotional;
  const fromPaid = Math.min(wallet.paid_seconds, afterPromo);
  const shortfall = afterPromo - fromPaid;
  const ts = now();

  await db
    .prepare(
      `UPDATE wallets
          SET promotional_seconds = promotional_seconds - ?,
              paid_seconds = paid_seconds - ?,
              updated_at = ?
        WHERE id = ?`,
    )
    .run(fromPromotional, fromPaid, ts, wallet.id);

  if (fromPromotional > 0) {
    await db
      .prepare(
        `UPDATE promotional_budgets
            SET consumed_seconds = consumed_seconds + ?
          WHERE id = (
            SELECT budget_id FROM promotional_grants
             WHERE customer_id = ?
             ORDER BY created_at DESC LIMIT 1
          )`,
      )
      .run(fromPromotional, params.customerId);

    await db
      .prepare(
        `INSERT INTO ledger (id, wallet_id, creator_id, kind, bucket, seconds_delta, cents_delta, reason, call_id, created_at)
         VALUES (?, ?, ?, 'usage', 'promotional', ?, 0, 'Coaching call (promotional)', ?, ?)`,
      )
      .run(id('led'), wallet.id, params.creatorId, -fromPromotional, params.callId, ts);
  }

  const retailCents = retailCentsForSeconds(fromPaid, params.centsPerMinute);
  if (fromPaid > 0) {
    await db
      .prepare(
        `INSERT INTO ledger (id, wallet_id, creator_id, kind, bucket, seconds_delta, cents_delta, reason, call_id, created_at)
         VALUES (?, ?, ?, 'usage', 'paid', ?, ?, 'Coaching call', ?, ?)`,
      )
      .run(id('led'), wallet.id, params.creatorId, -fromPaid, retailCents, params.callId, ts);
  }

  const after = (await db.prepare('SELECT * FROM wallets WHERE id = ?').get<Wallet>(wallet.id))!;
  return {
    fromPromotional,
    fromPaid,
    shortfall,
    remainingSeconds: after.paid_seconds + after.promotional_seconds,
    retailCents,
  };
}
