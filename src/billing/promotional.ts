import type { DB } from '../db/index.js';
import { transact } from '../db/index.js';
import { id, now } from '../util/ids.js';
import { getWallet } from './wallet.js';

export interface PromotionalBudget {
  id: string;
  creator_id: string;
  name: string;
  funded_seconds: number;
  consumed_seconds: number;
  per_customer_seconds_cap: number;
  active: number;
  created_at: number;
}

export class NoPromotionalFundingError extends Error {
  constructor(creatorId: string) {
    super(
      `No funded promotional budget for creator ${creatorId}. ` +
        'Free trial minutes are only available when the creator has prepaid for them.',
    );
    this.name = 'NoPromotionalFundingError';
  }
}

export function createBudget(
  db: DB,
  params: { creatorId: string; name: string; fundedSeconds: number; perCustomerSecondsCap: number },
): PromotionalBudget {
  const budgetId = id('promo');
  db.prepare(
    `INSERT INTO promotional_budgets
       (id, creator_id, name, funded_seconds, consumed_seconds, per_customer_seconds_cap, active, created_at)
     VALUES (?, ?, ?, ?, 0, ?, 1, ?)`,
  ).run(
    budgetId,
    params.creatorId,
    params.name,
    params.fundedSeconds,
    params.perCustomerSecondsCap,
    now(),
  );
  return db.prepare('SELECT * FROM promotional_budgets WHERE id = ?').get(budgetId) as PromotionalBudget;
}

export function activeBudget(db: DB, creatorId: string): PromotionalBudget | null {
  return (
    (db
      .prepare(
        `SELECT * FROM promotional_budgets
          WHERE creator_id = ? AND active = 1 AND funded_seconds > consumed_seconds
          ORDER BY created_at LIMIT 1`,
      )
      .get(creatorId) as PromotionalBudget | undefined) ?? null
  );
}

export interface GrantResult {
  granted: number;
  budgetId: string | null;
  reason: 'granted' | 'already_granted' | 'no_funding' | 'budget_exhausted';
}

/**
 * Grants trial minutes to one verified account.
 *
 * Three invariants live here:
 *  - the grant draws only on the creator's own prepaid pool, never the platform's
 *    and never another creator's;
 *  - a pool with nothing left grants nothing, rather than going negative;
 *  - the cap binds to a customer account, so redialing does not mint more.
 */
export function grantTrialMinutes(
  db: DB,
  params: { creatorId: string; customerId: string; requestedSeconds?: number },
): GrantResult {
  return transact(db, () => {
    const budget = activeBudget(db, params.creatorId);
    if (!budget) return { granted: 0, budgetId: null, reason: 'no_funding' };

    const existing = db
      .prepare('SELECT * FROM promotional_grants WHERE budget_id = ? AND customer_id = ?')
      .get(budget.id, params.customerId) as { seconds: number } | undefined;
    if (existing) return { granted: 0, budgetId: budget.id, reason: 'already_granted' };

    const remainingInPool = budget.funded_seconds - budget.consumed_seconds;
    if (remainingInPool <= 0) return { granted: 0, budgetId: budget.id, reason: 'budget_exhausted' };

    // Reserved seconds are those already handed out but not yet spent; without
    // this the pool could be over-promised across many customers at once.
    const reserved = db
      .prepare('SELECT COALESCE(SUM(seconds), 0) AS s FROM promotional_grants WHERE budget_id = ?')
      .get(budget.id) as { s: number };
    const unreserved = budget.funded_seconds - Math.max(reserved.s, budget.consumed_seconds);
    if (unreserved <= 0) return { granted: 0, budgetId: budget.id, reason: 'budget_exhausted' };

    const seconds = Math.min(
      params.requestedSeconds ?? budget.per_customer_seconds_cap,
      budget.per_customer_seconds_cap,
      unreserved,
    );
    if (seconds <= 0) return { granted: 0, budgetId: budget.id, reason: 'budget_exhausted' };

    db.prepare(
      'INSERT INTO promotional_grants (id, budget_id, customer_id, seconds, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id('grant'), budget.id, params.customerId, seconds, now());

    const wallet = getWallet(db, params.customerId, params.creatorId);
    db.prepare(
      'UPDATE wallets SET promotional_seconds = promotional_seconds + ?, updated_at = ? WHERE id = ?',
    ).run(seconds, now(), wallet.id);

    db.prepare(
      `INSERT INTO ledger (id, wallet_id, creator_id, kind, bucket, seconds_delta, cents_delta, reason, created_at)
       VALUES (?, ?, ?, 'promotional_grant', 'promotional', ?, 0, ?, ?)`,
    ).run(id('led'), wallet.id, params.creatorId, seconds, `Trial from "${budget.name}"`, now());

    return { granted: seconds, budgetId: budget.id, reason: 'granted' };
  });
}
