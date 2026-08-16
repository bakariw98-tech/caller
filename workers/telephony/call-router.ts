import type { SqlDb } from '../db/types.js';
import type { Env } from '../env.js';
import { loadAppConfig } from '../env.js';
import { id, now } from '../../src/util/ids.js';
import type { Course, Creator, Customer, PhoneNumber } from '../../src/domain/types.js';
import { buildCoachInstructions, buildSeedContext } from '../../src/coach/prompt.js';
import { getOrCreateEnrollment, describeProgress } from '../state/transitions.js';
import { balanceSeconds } from '../billing/wallet.js';
import { activeBudget, grantTrialMinutes } from '../billing/promotional.js';
import { mintCallToken } from '../mcp/auth.js';
import type { StartCallParams } from '../durable-objects/call-session.js';
import type { IncomingCallEvent } from '../../src/xai/webhook.js';

const ANON_SECONDS_WITH_TRIAL_FUNDING = 90;
const ANON_SECONDS_WITHOUT_FUNDING = 45;
const NO_CREDIT_SECONDS = 60;

export interface RouteResult {
  accepted: boolean;
  callId: string;
  reason: string;
}

/**
 * Port of src/telephony/call-router.ts. Same decisions, same reasons — see
 * that file's comments for the "why". The one structural difference: instead
 * of constructing a CallSession in-process, this hands the fully-decided plan
 * to the call's Durable Object via a `/start` POST, since the object that
 * will hold the live WebSocket has to be the one xAI and later MCP-transfer
 * requests can address by name.
 */
export async function routeIncomingCall(db: SqlDb, env: Env, event: IncomingCallEvent): Promise<RouteResult> {
  const cfg = loadAppConfig(env);

  const number = event.to
    ? await db.prepare('SELECT * FROM phone_numbers WHERE e164 = ?').get<PhoneNumber>(event.to)
    : undefined;
  if (!number) return { accepted: false, callId: '', reason: 'unknown_destination_number' };

  const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(number.creator_id);
  if (!creator) return { accepted: false, callId: '', reason: 'creator_missing' };

  const course = await db
    .prepare('SELECT * FROM courses WHERE creator_id = ? ORDER BY created_at DESC LIMIT 1')
    .get<Course>(creator.id);
  if (!course) return { accepted: false, callId: '', reason: 'creator_has_no_course' };

  const customer = event.from
    ? await db
        .prepare('SELECT * FROM customers WHERE creator_id = ? AND phone_e164 = ? AND verified_at IS NOT NULL')
        .get<Customer>(creator.id, event.from)
    : undefined;

  const callId = id('call');
  await db
    .prepare(
      `INSERT INTO calls (id, xai_call_id, creator_id, customer_id, from_number, to_number, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ringing', ?)`,
    )
    .run(callId, event.callId, creator.id, customer?.id ?? null, event.from, event.to, now());

  const plan = customer
    ? await planForKnownCaller(db, { creator, course, customer, callId })
    : await planForUnknownCaller(db, { creator, course });

  const mcpToken = await mintCallToken(db, env.MCP_TOKEN_SECRET, 8000, {
    callId,
    creatorId: creator.id,
    customerId: customer?.id ?? null,
    enrollmentId: plan.enrollmentId,
    courseId: course.id,
  });

  const startParams: StartCallParams = {
    callId,
    xaiCallId: event.callId,
    creatorId: creator.id,
    creatorVoice: creator.coach_voice,
    customerId: customer?.id ?? null,
    instructions: plan.instructions,
    seedText: plan.seedText,
    mcpToken,
    meterWallet: plan.meterWallet,
    initialBalanceSeconds: plan.allowedSeconds,
    centsPerMinute: creator.price_per_minute_cents,
    audioCostPerMinuteCents: cfg.audioCostPerMinuteCents,
    maxSessionSeconds: cfg.maxSessionSeconds,
    lowBalanceWarningSeconds: cfg.lowBalanceWarningSeconds,
    finalWarningSeconds: cfg.finalWarningSeconds,
    idleTimeoutMs: cfg.idleTimeoutMs,
  };

  const stub = env.CALL_SESSION.get(env.CALL_SESSION.idFromName(callId));
  await stub.fetch('https://call-session/start', {
    method: 'POST',
    body: JSON.stringify(startParams),
    headers: { 'Content-Type': 'application/json' },
  });

  return { accepted: true, callId, reason: plan.reason };
}

interface CallPlan {
  instructions: string;
  seedText: string;
  allowedSeconds: number;
  meterWallet: boolean;
  enrollmentId: string | null;
  reason: string;
}

async function planForKnownCaller(
  db: SqlDb,
  params: { creator: Creator; course: Course; customer: Customer; callId: string },
): Promise<CallPlan> {
  const { creator, course, customer, callId } = params;
  const enrollment = await getOrCreateEnrollment(db, customer.id, course.id);

  await db
    .prepare('UPDATE calls SET enrollment_id = ?, entry_step_id = ? WHERE id = ?')
    .run(enrollment.id, enrollment.current_step_id, callId);

  let balance = await balanceSeconds(db, customer.id, creator.id);
  let isTrial = false;

  if (balance <= 0 && (await activeBudget(db, creator.id))) {
    const grant = await grantTrialMinutes(db, { creatorId: creator.id, customerId: customer.id });
    if (grant.granted > 0) {
      balance = grant.granted;
      isTrial = true;
    }
  }

  const instructions = buildCoachInstructions({
    creator,
    course,
    identified: true,
    callerFirstName: customer.name?.split(/\s+/)[0] ?? null,
  });

  if (balance <= 0) {
    return {
      instructions:
        instructions +
        '\n\nTHIS CALL: their credit has run out. Greet them warmly by name, tell them their minutes are ' +
        'used up and that they can top up whenever they like, offer one sentence of encouragement about ' +
        'where they are in the course, and say goodbye. Do not start coaching.',
      seedText: buildSeedContext({
        identified: true,
        callerName: customer.name,
        progressSummary: await describeProgress(db, enrollment),
        balanceMinutes: 0,
      }),
      allowedSeconds: NO_CREDIT_SECONDS,
      meterWallet: false,
      enrollmentId: enrollment.id,
      reason: 'no_credit',
    };
  }

  return {
    instructions,
    seedText: buildSeedContext({
      identified: true,
      callerName: customer.name,
      progressSummary: await describeProgress(db, enrollment),
      balanceMinutes: balance / 60,
      isTrial,
    }),
    allowedSeconds: balance,
    meterWallet: true,
    enrollmentId: enrollment.id,
    reason: isTrial ? 'trial' : 'paid',
  };
}

async function planForUnknownCaller(db: SqlDb, params: { creator: Creator; course: Course }): Promise<CallPlan> {
  const { creator, course } = params;
  const funded = Boolean(await activeBudget(db, creator.id));

  const instructions =
    buildCoachInstructions({ creator, course, identified: false }) +
    '\n\nTHIS CALL: you do not recognise this number, so there is no account behind it. Welcome them in ' +
    `one sentence, say that ${creator.business_name} sets each person up with their own account first, and ` +
    'point them to the sign-up link they were given. Do not coach, do not look anything up, and do not ' +
    'discuss anyone\'s progress. Keep it under thirty seconds.';

  return {
    instructions,
    seedText: buildSeedContext({ identified: false }),
    allowedSeconds: funded ? ANON_SECONDS_WITH_TRIAL_FUNDING : ANON_SECONDS_WITHOUT_FUNDING,
    meterWallet: false,
    enrollmentId: null,
    reason: 'unidentified_caller',
  };
}
