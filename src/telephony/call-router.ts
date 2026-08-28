import type { DB } from '../db/index.js';
import { config } from '../config.js';
import { id, now } from '../util/ids.js';
import type { Course, Creator, Customer, PhoneNumber } from '../domain/types.js';
import { buildCoachInstructions, buildSeedContext } from '../coach/prompt.js';
import { getOrCreateEnrollment, describeProgress } from '../state/transitions.js';
import { balanceSeconds } from '../billing/wallet.js';
import { activeBudget, grantTrialMinutes } from '../billing/promotional.js';
import { mintCallToken } from '../mcp/auth.js';
import { CallSession } from './call-session.js';
import type { IncomingCallEvent } from '../xai/webhook.js';

/**
 * Hard ceilings for calls that are not backed by a wallet.
 *
 * Answering the phone costs money whoever is on the line, so an unrecognised
 * caller gets a short, bounded conversation rather than an open session. The
 * platform never funds an unbounded call.
 */
const ANON_SECONDS_WITH_TRIAL_FUNDING = 90;
const ANON_SECONDS_WITHOUT_FUNDING = 45;
const NO_CREDIT_SECONDS = 60;

export interface RouteResult {
  accepted: boolean;
  callId: string;
  reason: string;
}

export interface RouteDeps {
  db: DB;
  logger?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

export async function routeIncomingCall(deps: RouteDeps, event: IncomingCallEvent): Promise<RouteResult> {
  const { db } = deps;

  const number = event.to
    ? (db.prepare('SELECT * FROM phone_numbers WHERE e164 = ?').get(event.to) as PhoneNumber | undefined)
    : undefined;

  if (!number) {
    return { accepted: false, callId: '', reason: 'unknown_destination_number' };
  }

  const creator = db.prepare('SELECT * FROM creators WHERE id = ?').get(number.creator_id) as
    | Creator
    | undefined;
  if (!creator) return { accepted: false, callId: '', reason: 'creator_missing' };

  const course = db
    .prepare('SELECT * FROM courses WHERE creator_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(creator.id) as Course | undefined;
  if (!course) return { accepted: false, callId: '', reason: 'creator_has_no_course' };

  // Caller ID identifies the account; it never authenticates a claim made on
  // the call. An unverified row is treated as a stranger.
  const customer = event.from
    ? (db
        .prepare('SELECT * FROM customers WHERE creator_id = ? AND phone_e164 = ? AND verified_at IS NOT NULL')
        .get(creator.id, event.from) as Customer | undefined)
    : undefined;

  const callId = id('call');
  db.prepare(
    `INSERT INTO calls (id, xai_call_id, creator_id, customer_id, from_number, to_number, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ringing', ?)`,
  ).run(callId, event.callId, creator.id, customer?.id ?? null, event.from, event.to, now());

  const plan = customer
    ? planForKnownCaller(db, { creator, course, customer, callId })
    : planForUnknownCaller(db, { creator, course });

  const mcpToken = mintCallToken(db, {
    callId,
    creatorId: creator.id,
    customerId: customer?.id ?? null,
    enrollmentId: plan.enrollmentId,
    courseId: course.id,
  });

  const session = new CallSession({
    db,
    callId,
    xaiCallId: event.callId,
    creator,
    customerId: customer?.id ?? null,
    instructions: plan.instructions,
    seedText: plan.seedText,
    mcpToken,
    meterWallet: plan.meterWallet,
    initialBalanceSeconds: plan.allowedSeconds,
    reasoningEffort: 'none',
    logger: deps.logger,
  });

  await session.start();

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

function planForKnownCaller(
  db: DB,
  params: { creator: Creator; course: Course; customer: Customer; callId: string },
): CallPlan {
  const { creator, course, customer, callId } = params;
  const enrollment = getOrCreateEnrollment(db, customer.id, course.id);

  db.prepare('UPDATE calls SET enrollment_id = ?, entry_step_id = ? WHERE id = ?').run(
    enrollment.id,
    enrollment.current_step_id,
    callId,
  );

  let balance = balanceSeconds(db, customer.id, creator.id);
  let isTrial = false;

  // First-time callers draw on the creator's prepaid trial pool, if there is
  // one. No pool means no trial — the platform does not front it.
  if (balance <= 0 && activeBudget(db, creator.id)) {
    const grant = grantTrialMinutes(db, { creatorId: creator.id, customerId: customer.id });
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
        progressSummary: describeProgress(db, enrollment),
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
      progressSummary: describeProgress(db, enrollment),
      balanceMinutes: balance / 60,
      isTrial,
    }),
    allowedSeconds: Math.min(balance, config.call.maxSessionSeconds),
    meterWallet: true,
    enrollmentId: enrollment.id,
    reason: isTrial ? 'trial' : 'paid',
  };
}

function planForUnknownCaller(db: DB, params: { creator: Creator; course: Course }): CallPlan {
  const { creator, course } = params;
  const funded = Boolean(activeBudget(db, creator.id));

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
