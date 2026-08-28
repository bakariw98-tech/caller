import type { SqlDb } from '../db/types.js';
import type { Env } from '../env.js';
import type { Creator } from '../../src/domain/types.js';
import { now, hmacHex } from '../../src/util/ids.js';
import { getAccessToken, buildRawMessage, sendMessage } from '../email/gmail.js';
import { runLeadgenPipeline } from '../leadgen/pipeline.js';

/**
 * The other half of voice escalation: a qualification call converts to a
 * concrete next step, live, or it doesn't — either way the prospect gets
 * one follow-up email once the call ends. No-ops immediately for a
 * coaching call (kind !== 'qualification') or a qualification call that
 * never resolved who was on the line (prospect_id still null — nobody to
 * email).
 *
 * `next_step_accepted` (set by record_call_outcome during the call) picks
 * the branch: accepted gets a short, code-assembled "here's the link"
 * email — no new generation call, the offer was already decided live.
 * Not accepted recaps through the same runLeadgenPipeline() every email
 * reply already goes through, with channel:'post_call' so the framing
 * reads as a follow-up rather than a reply to something they wrote.
 *
 * Extracted from CallSessionDO (the real phone-call path's own call-end
 * hook) rather than left as a private method there, once a second caller
 * needed it: the browser-based test-call path (workers/routes/talk.ts) has
 * no Durable Object managing its lifecycle — there's no PSTN leg, no
 * webhook-driven start/end, nothing for a DO to hold open — so it triggers
 * this directly on hangup instead. Both callers must run the identical
 * follow-up logic, which is exactly the reason every other shared
 * chokepoint in this codebase exists.
 */
export async function triggerQualificationFollowup(db: SqlDb, env: Env, callId: string, creatorId: string): Promise<void> {
  const call = await db
    .prepare('SELECT kind, prospect_id, next_step_accepted, accepted_offer_id FROM calls WHERE id = ?')
    .get<{ kind: string; prospect_id: string | null; next_step_accepted: number; accepted_offer_id: string | null }>(callId);
  if (!call || call.kind !== 'qualification' || !call.prospect_id) return;

  const prospect = await db.prepare('SELECT * FROM prospects WHERE id = ?').get<Record<string, any>>(call.prospect_id);
  // Write-once: a prospect calling back a second time must not trigger a
  // second follow-up email.
  if (!prospect || prospect.followup_sent_at) return;

  const conn = await db
    .prepare('SELECT * FROM email_connections WHERE creator_id = ?')
    .get<{ refresh_token: string; gmail_address: string }>(creatorId);
  if (!conn) {
    console.error(`qualification call ${callId} ended but creator ${creatorId} has no Gmail connection for the follow-up`);
    return;
  }

  const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(creatorId);
  if (!creator) return;

  // Threads the follow-up into the hook email's own Gmail conversation —
  // see poll.ts's send site for why the real RFC 2822 Message-Id (not
  // Gmail's own message id) has to be what's stored here for Gmail to
  // actually accept this as a reply rather than silently starting a new
  // thread.
  const hookMsg = await db
    .prepare(
      "SELECT subject, gmail_message_id, gmail_thread_id FROM prospect_messages WHERE prospect_id = ? AND kind = 'hook' ORDER BY created_at DESC LIMIT 1",
    )
    .get<{ subject: string | null; gmail_message_id: string | null; gmail_thread_id: string | null }>(call.prospect_id);

  let body: string;
  if (call.next_step_accepted && call.accepted_offer_id) {
    const offer = await db.prepare('SELECT name FROM offers WHERE id = ?').get<{ name: string }>(call.accepted_offer_id);
    const link =
      `${env.PUBLIC_BASE_URL}/r/${call.accepted_offer_id}.${call.prospect_id}.` +
      hmacHex(env.MCP_TOKEN_SECRET, `${call.accepted_offer_id}:${call.prospect_id}`).slice(0, 16);
    const firstName = prospect.name?.split(/\s+/)[0];
    body =
      `Great talking to you${firstName ? `, ${firstName}` : ''}! Like we discussed` +
      `${offer ? ` — here's ${offer.name}` : ''}:\n\n${link}`;
  } else {
    const pipelineResult = await runLeadgenPipeline({
      db,
      apiBase: env.XAI_API_BASE,
      apiKey: env.XAI_API_KEY,
      model: env.XAI_TEXT_MODEL,
      publicBaseUrl: env.PUBLIC_BASE_URL,
      mcpTokenSecret: env.MCP_TOKEN_SECRET,
      creatorId,
      fromEmail: prospect.email,
      fromName: prospect.name,
      text: 'We just spoke on the phone. Write a short, warm follow-up based on everything discussed on the call.',
      channel: 'post_call',
    });
    // Empty means opted out mid-call, or genuinely nothing useful to add —
    // never force a follow-up that has nothing behind it.
    if (!pipelineResult.reply.trim()) return;
    body = pipelineResult.reply;
  }

  const accessToken = await getAccessToken(
    { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET },
    conn.refresh_token,
  );
  const raw = buildRawMessage({
    to: prospect.email,
    from: conn.gmail_address,
    fromName: creator.coach_name,
    subject: hookMsg?.subject ?? 'Following up on our call',
    bodyText: body,
    inReplyTo: hookMsg?.gmail_message_id ?? null,
    references: hookMsg?.gmail_message_id ?? null,
  });
  await sendMessage(accessToken, raw, hookMsg?.gmail_thread_id ?? undefined);

  await db.prepare('UPDATE prospects SET followup_sent_at = COALESCE(followup_sent_at, ?) WHERE id = ?').run(now(), call.prospect_id);
}
