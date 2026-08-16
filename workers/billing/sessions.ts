import type { SqlDb } from '../db/types.js';
import { id, now } from '../../src/util/ids.js';
import { debitSeconds } from './wallet.js';
import { retailCentsForSeconds } from './pricing.js';

/**
 * Activity-based metering, for integrations that never hand this platform the
 * live call.
 *
 * The precise meter lives in durable-objects/call-session.ts and charges by
 * the second off a WebSocket this platform owns. A number provisioned through
 * xAI's console never produces that WebSocket — no webhook, no call_id, and a
 * stateless MCP transport (measured: 32 `initialize` requests across 17 tool
 * calls, no mcp-session-id header) — so there is nothing whose lifetime maps
 * to the call.
 *
 * What remains observable is tool activity: which customer, and when. This
 * module turns that into billable sessions:
 *
 *   - Tool calls from one customer within SESSION_GAP_SECONDS are one session.
 *   - A new session charges MINIMUM_SESSION_SECONDS upfront, which also stops
 *     a caller from getting unlimited short calls for free.
 *   - As a session's observed span grows past what has been charged, the
 *     difference is charged, rounded up to the minute.
 *
 * The honest caveat, stated here because it is easy to forget once the numbers
 * look plausible: observed span is a LOWER BOUND on true call length. A caller
 * who talks for two minutes without prompting a tool call is invisible, and
 * time after the final tool call is never seen. This bills less than actual
 * usage, never more. That direction is deliberate — undercharging a customer
 * is a smaller failure than overcharging one for time nobody can evidence.
 * Precise billing needs the webhook path back (see docs/BILLING.md).
 */

const SESSION_GAP_SECONDS = 300; // 5 min of silence ends a session
const MINIMUM_SESSION_SECONDS = 120; // floor charged when a session opens

export interface CoachingSession {
  id: string;
  creator_id: string;
  customer_id: string;
  enrollment_id: string | null;
  started_at: number;
  last_activity_at: number;
  tool_calls: number;
  charged_seconds: number;
  observed_span_seconds: number;
  retail_cents: number;
  ended_reason: string | null;
}

export interface MeterResult {
  session: CoachingSession;
  /** False when the wallet could not cover this session's charge. */
  allowed: boolean;
  remainingSeconds: number;
  startedNewSession: boolean;
}

/**
 * Records activity for a customer and charges for it.
 *
 * Called on every identity-resolving tool call, so it must stay cheap and
 * idempotent-ish: repeated calls inside one session only extend it.
 */
export async function meterActivity(
  db: SqlDb,
  params: {
    creatorId: string;
    customerId: string;
    enrollmentId: string | null;
    centsPerMinute: number;
  },
): Promise<MeterResult> {
  const ts = now();

  const existing = await db
    .prepare(
      `SELECT * FROM coaching_sessions
        WHERE customer_id = ? AND creator_id = ? AND last_activity_at >= ?
        ORDER BY last_activity_at DESC LIMIT 1`,
    )
    .get<CoachingSession>(params.customerId, params.creatorId, ts - SESSION_GAP_SECONDS);

  if (!existing) {
    return startSession(db, params, ts);
  }

  // Extend the live session. Charge only the part of the observed span that
  // has not been paid for yet.
  const span = Math.max(0, ts - existing.started_at);
  const owed = Math.max(0, Math.ceil((span - existing.charged_seconds) / 60) * 60);

  let charged = existing.charged_seconds;
  let retail = existing.retail_cents;
  let remaining = 0;
  let allowed = true;

  if (owed > 0) {
    const debit = await debitSeconds(db, {
      customerId: params.customerId,
      creatorId: params.creatorId,
      seconds: owed,
      callId: existing.id,
      centsPerMinute: params.centsPerMinute,
    });
    charged += owed - debit.shortfall;
    retail += debit.retailCents;
    remaining = debit.remainingSeconds;
    // A shortfall means the wallet ran dry mid-session.
    allowed = debit.shortfall === 0;
  } else {
    remaining = await currentBalance(db, params.customerId, params.creatorId);
  }

  await db
    .prepare(
      `UPDATE coaching_sessions
          SET last_activity_at = ?, tool_calls = tool_calls + 1,
              charged_seconds = ?, observed_span_seconds = ?, retail_cents = ?,
              ended_reason = ?
        WHERE id = ?`,
    )
    .run(ts, charged, span, retail, allowed ? null : 'out_of_credit', existing.id);

  const session = (await db
    .prepare('SELECT * FROM coaching_sessions WHERE id = ?')
    .get<CoachingSession>(existing.id))!;

  return { session, allowed, remainingSeconds: remaining, startedNewSession: false };
}

async function startSession(
  db: SqlDb,
  params: { creatorId: string; customerId: string; enrollmentId: string | null; centsPerMinute: number },
  ts: number,
): Promise<MeterResult> {
  const debit = await debitSeconds(db, {
    customerId: params.customerId,
    creatorId: params.creatorId,
    seconds: MINIMUM_SESSION_SECONDS,
    callId: 'pending',
    centsPerMinute: params.centsPerMinute,
  });

  const allowed = debit.shortfall < MINIMUM_SESSION_SECONDS; // some credit was available
  const sessionId = id('sess');

  await db
    .prepare(
      `INSERT INTO coaching_sessions
         (id, creator_id, customer_id, enrollment_id, started_at, last_activity_at,
          tool_calls, charged_seconds, observed_span_seconds, retail_cents, ended_reason)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)`,
    )
    .run(
      sessionId,
      params.creatorId,
      params.customerId,
      params.enrollmentId,
      ts,
      ts,
      MINIMUM_SESSION_SECONDS - debit.shortfall,
      debit.retailCents,
      allowed ? null : 'out_of_credit',
    );

  const session = (await db
    .prepare('SELECT * FROM coaching_sessions WHERE id = ?')
    .get<CoachingSession>(sessionId))!;

  return { session, allowed, remainingSeconds: debit.remainingSeconds, startedNewSession: true };
}

async function currentBalance(db: SqlDb, customerId: string, creatorId: string): Promise<number> {
  const w = await db
    .prepare('SELECT paid_seconds + promotional_seconds AS s FROM wallets WHERE customer_id = ? AND creator_id = ?')
    .get<{ s: number }>(customerId, creatorId);
  return w?.s ?? 0;
}

export function retailForSession(session: CoachingSession, centsPerMinute: number): number {
  return retailCentsForSeconds(session.charged_seconds, centsPerMinute);
}
