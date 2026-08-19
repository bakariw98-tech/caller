import type { SqlDb } from '../db/types.js';
import type { Env } from '../env.js';
import { loadAppConfig } from '../env.js';
import { id, now } from '../../src/util/ids.js';
import type { Creator, PhoneNumber } from '../../src/domain/types.js';
import { buildQualCallInstructions } from '../leadgen/call-prompt.js';
import { loadFullOffers } from '../leadgen/reply.js';
import { mintQualCallToken } from '../mcp/auth.js';
import type { StartCallParams } from '../durable-objects/call-session.js';
import type { IncomingCallEvent } from '../../src/xai/webhook.js';
import type { RouteResult } from './call-router.js';

/**
 * Not a business cap — real conversations get whatever time they need (see
 * this session's plan: "Don't hard limit it. Just close the sale
 * efficiently"). Purely crash protection against a stuck or looping call
 * burning real cost unattended, the same role maxSessionSeconds already
 * plays for coaching calls, just tighter here since a qualification call
 * has no wallet backing it to naturally cap runaway cost.
 */
const QUALIFICATION_MAX_SESSION_SECONDS = 30 * 60;

/** Exported so workers/routes/talk.ts's browser-based test call reuses the exact same tool set, not a copy that could drift. */
export const QUAL_TOOL_SET = {
  serverLabel: 'qualify',
  serverDescription: "The prospect's identity, discovery signal capture, and the offer-honesty gate for this call.",
  allowedTools: ['resolve_prospect', 'record_qualification_signal', 'record_call_outcome'],
};

/**
 * Routed to from routeIncomingCall() when the dialed number's purpose is
 * 'qualify' — a separate file, mirroring how leadgen already lives on its
 * own rather than growing call-router.ts into a grab-bag of unrelated call
 * kinds. No course lookup here at all: a leadgen-only creator with no
 * coaching product must not be rejected for calling their own escalation
 * number, which is exactly the bug this split avoids (routeIncomingCall's
 * course-requirement check runs before this is ever reached).
 */
export async function routeQualificationCall(
  db: SqlDb,
  env: Env,
  event: IncomingCallEvent,
  number: PhoneNumber,
): Promise<RouteResult> {
  const cfg = loadAppConfig(env);

  const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(number.creator_id);
  if (!creator) return { accepted: false, callId: '', reason: 'creator_missing' };

  // Not on the shared Creator interface — narrow SELECT, same pattern used
  // for voice_qualification_mode in workers/leadgen/inbound.ts.
  const posture = await db
    .prepare("SELECT objection_handling_posture FROM creators WHERE id = ?")
    .get<{ objection_handling_posture: 'soft' | 'assertive' }>(creator.id);

  const callId = id('call');
  await db
    .prepare(
      `INSERT INTO calls (id, xai_call_id, creator_id, customer_id, from_number, to_number, status, started_at, kind)
       VALUES (?, ?, ?, NULL, ?, ?, 'ringing', ?, 'qualification')`,
    )
    .run(callId, event.callId, creator.id, event.from, event.to, now());

  const offers = await loadFullOffers(db, creator.id);
  const instructions = buildQualCallInstructions({
    creator,
    offers,
    objectionPosture: posture?.objection_handling_posture ?? 'soft',
  });

  const mcpToken = await mintQualCallToken(db, env.MCP_TOKEN_SECRET, 8000, { callId, creatorId: creator.id });

  const startParams: StartCallParams = {
    callId,
    xaiCallId: event.callId,
    creatorId: creator.id,
    creatorVoice: creator.coach_voice,
    customerId: null,
    instructions,
    seedText: "You're on a qualification call. Greet them warmly and ask for the short code from their invite email.",
    mcpToken,
    // No wallet to debit — prospects have no balance (they're email leads,
    // not paying customers yet). The creator absorbs the cost of a call
    // that's a high-priority potential sale, same precedent as the
    // existing unidentified/no-credit coach-caller path.
    meterWallet: false,
    initialBalanceSeconds: QUALIFICATION_MAX_SESSION_SECONDS,
    centsPerMinute: 0,
    audioCostPerMinuteCents: cfg.audioCostPerMinuteCents,
    maxSessionSeconds: QUALIFICATION_MAX_SESSION_SECONDS,
    lowBalanceWarningSeconds: cfg.lowBalanceWarningSeconds,
    finalWarningSeconds: cfg.finalWarningSeconds,
    idleTimeoutMs: cfg.idleTimeoutMs,
    toolSet: QUAL_TOOL_SET,
  };

  const stub = env.CALL_SESSION.get(env.CALL_SESSION.idFromName(callId));
  await stub.fetch('https://call-session/start', {
    method: 'POST',
    body: JSON.stringify(startParams),
    headers: { 'Content-Type': 'application/json' },
  });

  return { accepted: true, callId, reason: 'qualification_call' };
}

/**
 * The browser-based counterpart to routeQualificationCall(), for testing
 * (or, eventually, offering) the qualification conversation with no phone
 * number involved at all — see workers/routes/talk.ts. There is no PSTN
 * leg, no webhook, and no Durable Object holding this call open: xAI's
 * ephemeral-client-secret path lets a browser connect to the realtime API
 * directly over WebRTC, with our /mcp endpoint still doing everything the
 * tool calls need exactly as it does for a phone call — MCP tool routing
 * is transport-agnostic (see docs/XAI-API-NOTES.md), so nothing about the
 * qualification-call.ts prompt, tools, or honesty gates changes.
 *
 * Only creates the `calls` row and mints our own long-lived qual MCP
 * token here. The ephemeral xAI secret is deliberately NOT minted yet —
 * those expire in roughly a minute, so it has to be minted at the moment
 * the browser is actually about to connect (workers/routes/talk.ts's page
 * load), not baked into a link that might sit unopened for a while.
 */
export async function startWebQualificationCall(
  db: SqlDb,
  env: Env,
  creatorId: string,
): Promise<{ callId: string; mcpToken: string } | { error: string }> {
  const creator = await db.prepare('SELECT id FROM creators WHERE id = ?').get<{ id: string }>(creatorId);
  if (!creator) return { error: 'creator not found' };

  const callId = id('call');
  await db
    .prepare(
      `INSERT INTO calls (id, xai_call_id, creator_id, customer_id, from_number, to_number, status, started_at, connected_at, kind)
       VALUES (?, NULL, ?, NULL, 'web-test', 'web-test', 'active', ?, ?, 'qualification')`,
    )
    .run(callId, creatorId, now(), now());

  // Longer TTL than the phone path's (8000s) is unnecessary — a test
  // session lives minutes, not hours — but there's no reason to make it
  // tighter either; this token only matters for the single browser tab
  // that receives it.
  const mcpToken = await mintQualCallToken(db, env.MCP_TOKEN_SECRET, 3600, { callId, creatorId });

  return { callId, mcpToken };
}
