import type { DB } from '../db/index.js';
import { now } from '../util/ids.js';

export interface CoachPerformance {
  activeCustomers: number;
  sessions: number;
  minutes: number;
  revenueCents: number;
  revenuePerCustomerCents: number;
  repeatCallers: number;
  trialCustomers: number;
  convertedCustomers: number;
  trialConversionPercent: number;
  costCents: number;
  marginCents: number;
  costPerHourDollars: number;
}

export interface StuckPoint {
  stepId: string;
  stepTitle: string;
  moduleSeq: number;
  moduleTitle: string;
  problemCount: number;
  sessionCount: number;
  sessionPercent: number;
  sampleProblems: string[];
}

export interface ClarificationTheme {
  term: string;
  occurrences: number;
}

function since(days: number): number {
  return now() - days * 86_400;
}

export function coachPerformance(db: DB, creatorId: string, days = 30): CoachPerformance {
  const from = since(days);

  const calls = db
    .prepare(
      `SELECT COUNT(*) AS sessions,
              COALESCE(SUM(billable_seconds), 0) AS seconds,
              COALESCE(SUM(retail_cents), 0) AS revenue,
              COALESCE(SUM(cost_cents_estimate), 0) AS cost,
              COUNT(DISTINCT customer_id) AS customers
         FROM calls
        WHERE creator_id = ? AND started_at >= ? AND customer_id IS NOT NULL`,
    )
    .get(creatorId, from) as {
    sessions: number;
    seconds: number;
    revenue: number;
    cost: number;
    customers: number;
  };

  const repeat = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT customer_id FROM calls
          WHERE creator_id = ? AND started_at >= ? AND customer_id IS NOT NULL
          GROUP BY customer_id HAVING COUNT(*) > 1
       )`,
    )
    .get(creatorId, from) as { n: number };

  // Conversion measured against people who actually received trial credit, so
  // it answers "did the free minutes work" rather than "did anyone sign up".
  const trials = db
    .prepare(
      `SELECT COUNT(DISTINCT g.customer_id) AS n
         FROM promotional_grants g
         JOIN promotional_budgets b ON b.id = g.budget_id
        WHERE b.creator_id = ?`,
    )
    .get(creatorId) as { n: number };

  const converted = db
    .prepare(
      `SELECT COUNT(DISTINCT l.wallet_id) AS n
         FROM ledger l
         JOIN wallets w ON w.id = l.wallet_id
        WHERE l.creator_id = ? AND l.kind = 'topup'
          AND w.customer_id IN (
            SELECT g.customer_id FROM promotional_grants g
              JOIN promotional_budgets b ON b.id = g.budget_id
             WHERE b.creator_id = ?
          )`,
    )
    .get(creatorId, creatorId) as { n: number };

  const minutes = Math.round(calls.seconds / 60);
  const hours = calls.seconds / 3600;

  return {
    activeCustomers: calls.customers,
    sessions: calls.sessions,
    minutes,
    revenueCents: calls.revenue,
    revenuePerCustomerCents: calls.customers > 0 ? Math.round(calls.revenue / calls.customers) : 0,
    repeatCallers: repeat.n,
    trialCustomers: trials.n,
    convertedCustomers: converted.n,
    trialConversionPercent: trials.n > 0 ? (converted.n / trials.n) * 100 : 0,
    costCents: calls.cost,
    marginCents: calls.revenue - calls.cost,
    costPerHourDollars: hours > 0 ? calls.cost / 100 / hours : 0,
  };
}

/**
 * Where this creator's customers get stuck.
 *
 * The second product: a coach that runs all day is also the only honest report
 * a creator has ever had on which part of their own material does not land.
 */
export function stuckPoints(db: DB, creatorId: string, days = 30, limit = 10): StuckPoint[] {
  const from = since(days);

  const totalSessions = (
    db
      .prepare('SELECT COUNT(*) AS n FROM calls WHERE creator_id = ? AND started_at >= ?')
      .get(creatorId, from) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT e.step_id AS stepId,
              s.title AS stepTitle,
              m.seq AS moduleSeq,
              m.title AS moduleTitle,
              COUNT(*) AS problemCount,
              COUNT(DISTINCT e.call_id) AS sessionCount
         FROM call_events e
         JOIN steps s ON s.id = e.step_id
         JOIN modules m ON m.id = s.module_id
        WHERE e.creator_id = ?
          AND e.created_at >= ?
          AND e.type IN ('problem_reported', 'problem_recorded')
          AND e.step_id IS NOT NULL
        GROUP BY e.step_id
        ORDER BY problemCount DESC
        LIMIT ?`,
    )
    .all(creatorId, from, limit) as {
    stepId: string;
    stepTitle: string;
    moduleSeq: number;
    moduleTitle: string;
    problemCount: number;
    sessionCount: number;
  }[];

  return rows.map((r) => ({
    ...r,
    sessionPercent: totalSessions > 0 ? (r.sessionCount / totalSessions) * 100 : 0,
    sampleProblems: db
      .prepare(
        `SELECT payload_json FROM call_events
          WHERE creator_id = ? AND step_id = ? AND type IN ('problem_reported', 'problem_recorded')
          ORDER BY created_at DESC LIMIT 3`,
      )
      .all(creatorId, r.stepId)
      .map((row) => {
        try {
          const p = JSON.parse((row as { payload_json: string }).payload_json);
          return String(p.symptom ?? p.problem ?? '');
        } catch {
          return '';
        }
      })
      .filter(Boolean),
  }));
}

/** Recurring words in what callers ask about — where the material is unclear. */
export function clarificationThemes(db: DB, creatorId: string, days = 30, limit = 12): ClarificationTheme[] {
  const rows = db
    .prepare(
      `SELECT payload_json FROM call_events
        WHERE creator_id = ? AND type = 'search' AND created_at >= ?`,
    )
    .all(creatorId, since(days)) as { payload_json: string }[];

  const counts = new Map<string, number>();
  for (const row of rows) {
    let query = '';
    try {
      query = String(JSON.parse(row.payload_json).query ?? '');
    } catch {
      continue;
    }
    for (const term of new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 3 && !COMMON.has(t)),
    )) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([term, occurrences]) => ({ term, occurrences }))
    .filter((t) => t.occurrences > 1)
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, limit);
}

const COMMON = new Set([
  'what', 'when', 'where', 'which', 'about', 'should', 'would', 'could', 'have', 'this', 'that',
  'with', 'from', 'they', 'them', 'there', 'here', 'been', 'does', 'doing', 'just', 'like',
  'work', 'working', 'help', 'need', 'want', 'know', 'right', 'wrong', 'thing', 'things',
]);

export interface EscalationSummary {
  id: string;
  reason: string;
  question: string | null;
  stepTitle: string | null;
  customerName: string | null;
  createdAt: number;
}

export function openEscalations(db: DB, creatorId: string, limit = 20): EscalationSummary[] {
  return db
    .prepare(
      `SELECT e.id, e.reason, e.question, s.title AS stepTitle, c.name AS customerName, e.created_at AS createdAt
         FROM escalations e
         LEFT JOIN steps s ON s.id = e.step_id
         LEFT JOIN customers c ON c.id = e.customer_id
        WHERE e.creator_id = ? AND e.status = 'open'
        ORDER BY e.created_at DESC LIMIT ?`,
    )
    .all(creatorId, limit) as EscalationSummary[];
}
