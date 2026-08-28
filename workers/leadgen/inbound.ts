import type { Creator } from '../../src/domain/types.js';
import { id, now } from '../../src/util/ids.js';
import { stripQuotedReply } from '../email/gmail.js';
import { generateUniqueCode } from '../identity/codes.js';
import { runLeadgenPipeline, CreatorNotFoundError, type RunPipelineParams, type PipelineResult } from './pipeline.js';
import { generateHookReply, buildHookEmailBody } from './reply.js';

/**
 * Sits above `runLeadgenPipeline()`, not inside it — that function is an
 * explicit shared chokepoint between `/api/leadgen/simulate` and the Gmail
 * poller and must not grow a phone-specific branch.
 *
 * Decides whether an inbound message gets the normal written reply, or —
 * when the creator has voice escalation on and this is genuinely a
 * prospect's first message — a hook email instead, inviting a call where
 * the real qualifying conversation happens. Not gated on any discovery
 * having already happened: the bar for "worth inviting to a call" is a
 * real first message, not `isQualified()`'s three-field bar, which is
 * right for deciding an email reply can honestly pitch, not for deciding
 * someone deserves a richer conversation.
 */
export async function routeInboundMessage(params: RunPipelineParams): Promise<PipelineResult> {
  const db = params.db;
  const creatorId = params.creatorId;
  const email = params.fromEmail.trim().toLowerCase();

  const creator = await db
    .prepare('SELECT voice_qualification_mode FROM creators WHERE id = ?')
    .get<{ voice_qualification_mode: number }>(creatorId);
  if (!creator) throw new CreatorNotFoundError(creatorId);

  if (creator.voice_qualification_mode) {
    // First contact = no prospect row exists yet. Once someone has a row —
    // even one created moments ago by their own first message on a retry —
    // this path never fires again for them; every later message is a
    // normal written reply.
    const existingProspect = await db
      .prepare('SELECT id FROM prospects WHERE creator_id = ? AND email = ?')
      .get<{ id: string }>(creatorId, email);

    if (!existingProspect) {
      const qualifyNumber = await db
        .prepare("SELECT e164 FROM phone_numbers WHERE creator_id = ? AND purpose = 'qualify' LIMIT 1")
        .get<{ e164: string }>(creatorId);

      if (qualifyNumber) {
        return runHookPipeline(params, qualifyNumber.e164);
      }
      // Misconfigured: the mode is on but no qualify number is registered.
      // Fall through to the normal written reply rather than losing this
      // prospect's first-contact response entirely — the dashboard's
      // enable-toggle (workers/routes/dashboard.ts) is meant to prevent
      // this from happening, but a fallback that keeps working beats one
      // that fails silently on a real lead.
      console.error(`voice_qualification_mode is on for creator ${creatorId} but no purpose='qualify' number is registered`);
    }
  }

  return runLeadgenPipeline(params);
}

/**
 * Sends a warm teaser and an invitation to call — never a written answer.
 * The actual qualifying conversation, diagnosis, and offer all happen live
 * on the call (see workers/leadgen/call-prompt.ts); this email's only job
 * is making someone want to take it.
 */
async function runHookPipeline(params: RunPipelineParams, qualifyPhoneE164: string): Promise<PipelineResult> {
  const db = params.db;
  const creatorId = params.creatorId;
  const email = params.fromEmail.trim().toLowerCase();
  const question = stripQuotedReply(params.text).trim();
  const persist = params.persist !== false;

  const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(creatorId);
  if (!creator) throw new CreatorNotFoundError(creatorId);

  const { teaser, usage } = await generateHookReply({
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    model: params.model,
    creator,
    question,
  });

  const signals: PipelineResult['signals'] = {
    message_type: 'hook_sent',
    next_action: 'invite_call',
    situation: null,
    diagnosed_problem: null,
    knowledge_level: null,
    urgency: null,
    requested_offer: false,
    goal: null,
    tried: null,
    blocked_on: null,
    discovery_question: null,
    asked_about: null,
    objections: [],
    topics: [],
    hit_boundary: false,
    qualifies_for_offer: false,
    routed_offer_name: null,
    video_reference_problem: null,
    answered_from_material: false,
  };

  if (!persist) {
    // Onboarding preview / a call site that doesn't want anything written —
    // still need a real call_code to render a realistic preview, but never
    // commit to uniqueness against real prospects for something that won't
    // be sent.
    const previewCode = String(Math.floor(100000 + Math.random() * 900000));
    return {
      creator,
      reply: buildHookEmailBody({ teaser, phoneE164: qualifyPhoneE164, callCode: previewCode }),
      signals,
      routedOfferId: null,
      knowledgeUsed: [],
      prospectId: null,
      usage,
      outboundMessageId: null,
    };
  }

  const callCode = await generateUniqueCode(db, { table: 'prospects', column: 'call_code' }, creatorId);
  const body = buildHookEmailBody({ teaser, phoneE164: qualifyPhoneE164, callCode });

  const prospectId = id('prospect');
  await db
    .prepare(
      `INSERT INTO prospects (id, creator_id, email, name, first_seen_at, last_seen_at, call_code, call_code_issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(prospectId, creatorId, email, params.fromName ?? null, now(), now(), callCode, now());

  await db
    .prepare(
      `INSERT INTO prospect_messages (id, prospect_id, creator_id, direction, subject, body, source_message_id, created_at)
       VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?)`,
    )
    .run(id('msg'), prospectId, creatorId, params.subject ?? null, question, params.sourceMessageId ?? null, now());

  const outboundMessageId = id('msg');
  await db
    .prepare(
      `INSERT INTO prospect_messages
         (id, prospect_id, creator_id, direction, subject, body, kind, prompt_tokens, completion_tokens, cost_usd_micros, created_at)
       VALUES (?, ?, ?, 'outbound', ?, ?, 'hook', ?, ?, ?, ?)`,
    )
    .run(
      outboundMessageId,
      prospectId,
      creatorId,
      params.subject ? `Re: ${params.subject}` : null,
      body,
      usage.promptTokens,
      usage.completionTokens,
      Math.round(usage.costUsd * 1e6),
      now(),
    );

  return {
    creator,
    reply: body,
    signals,
    routedOfferId: null,
    knowledgeUsed: [],
    prospectId,
    usage,
    outboundMessageId,
  };
}
