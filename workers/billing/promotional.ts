import type { SqlDb } from '../db/types.js';
import { id, now } from '../../src/util/ids.js';
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

export async function createBudget(
  db: SqlDb,
  params: { creatorId: string; name: string; fundedSeconds: number; perCustomerSecondsCap: number },
): Promise<PromotionalBudget> {
  const budgetId = id('promo');
  await db
    .prepare(
      `INSERT INTO promotional_budgets
         (id, creator_id, name, funded_seconds, consumed_seconds, per_customer_seconds_cap, active, created_at)
       VALUES (?, ?, ?, ?, 0, ?, 1, ?)`,
    )
    .run(budgetId, params.creatorId, params.name, params.fundedSeconds, params.perCustomerSecondsCap, now());
  return (await db.prepare('SELECT * FROM promotional_budgets WHERE id = ?').get<PromotionalBudget>(budgetId))!;
}

export async function activeBudget(db: SqlDb, creatorId: string): Promise<PromotionalBudget | null> {
  return (
    (await db
      .prepare(
        `SELECT * FROM promotional_budgets
          WHERE creator_id = ? AND active = 1 AND funded_seconds > consumed_seconds
          ORDER BY created_at LIMIT 1`,
      )
      .get<PromotionalBudget>(creatorId)) ?? null
  );
}

export interface GrantResult {
  granted: number;
  budgetId: string | null;
  reason: 'granted' | 'already_granted' | 'no_funding' | 'budget_exhausted';
}

export async function grantTrialMinutes(
  db: SqlDb,
  params: { creatorId: string; customerId: string; requestedSeconds?: number },
): Promise<GrantResult> {
  const budget = await activeBudget(db, params.creatorId);
  if (!budget) return { granted: 0, budgetId: null, reason: 'no_funding' };

  const existing = await db
    .prepare('SELECT seconds FROM promotional_grants WHERE budget_id = ? AND customer_id = ?')
    .get<{ seconds: number }>(budget.id, params.customerId);
  if (existing) return { granted: 0, budgetId: budget.id, reason: 'already_granted' };

  const reserved = await db
    .prepare('SELECT COALESCE(SUM(seconds), 0) AS s FROM promotional_grants WHERE budget_id = ?')
    .get<{ s: number }>(budget.id);
  const unreserved = budget.funded_seconds - Math.max(reserved?.s ?? 0, budget.consumed_seconds);
  if (unreserved <= 0) return { granted: 0, budgetId: budget.id, reason: 'budget_exhausted' };

  const seconds = Math.min(
    params.requestedSeconds ?? budget.per_customer_seconds_cap,
    budget.per_customer_seconds_cap,
    unreserved,
  );
  if (seconds <= 0) return { granted: 0, budgetId: budget.id, reason: 'budget_exhausted' };

  await db
    .prepare('INSERT INTO promotional_grants (id, budget_id, customer_id, seconds, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id('grant'), budget.id, params.customerId, seconds, now());

  const wallet = await getWallet(db, params.customerId, params.creatorId);
  await db
    .prepare('UPDATE wallets SET promotional_seconds = promotional_seconds + ?, updated_at = ? WHERE id = ?')
    .run(seconds, now(), wallet.id);

  await db
    .prepare(
      `INSERT INTO ledger (id, wallet_id, creator_id, kind, bucket, seconds_delta, cents_delta, reason, created_at)
       VALUES (?, ?, ?, 'promotional_grant', 'promotional', ?, 0, ?, ?)`,
    )
    .run(id('led'), wallet.id, params.creatorId, seconds, `Trial from "${budget.name}"`, now());

  return { granted: seconds, budgetId: budget.id, reason: 'granted' };
}
