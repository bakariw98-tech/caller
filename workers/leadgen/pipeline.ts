import type { SqlDb } from '../db/types.js';
import type { Creator } from '../../src/domain/types.js';
import { id, now, hmacHex } from '../../src/util/ids.js';
import { generateReply, loadKnowledge, loadOffers, selectKnowledgeHybrid, type GeneratedReply } from './reply.js';
import { embedQuery, type AiBinding } from './embeddings.js';
import { stripQuotedReply } from '../email/gmail.js';
import { looksLikeOptOut } from './prompt.js';
import { applyProspectSignals, safeArr, nullIfBlank } from './prospects.js';

export class CreatorNotFoundError extends Error {
  constructor(creatorId: string) {
    super(`creator not found: ${creatorId}`);
  }
}

export interface RunPipelineParams {
  db: SqlDb;
  /** Workers AI, for semantic retrieval. Omitted callers fall back to keyword scoring. */
  ai?: AiBinding;
  apiBase: string;
  apiKey: string;
  model: string;
  publicBaseUrl: string;
  mcpTokenSecret: string;
  creatorId: string;
  fromEmail: string;
  fromName?: string | null;
  subject?: string | null;
  text: string;
  /** Defaults to true. The onboarding preview passes false to try a question without writing anything. */
  persist?: boolean;
  /** Gmail message id, when this came from email — stored so the poller can check "have I answered this before". */
  sourceMessageId?: string | null;
}

export interface PipelineResult {
  creator: Creator;
  reply: string;
  signals: GeneratedReply['signals'];
  routedOfferId: string | null;
  knowledgeUsed: { problem: string; had_boundary: boolean }[];
  prospectId: string | null;
  usage: GeneratedReply['usage'];
  /**
   * The `prospect_messages` row id of the outbound reply just persisted —
   * null when nothing was persisted (opt-out, `persist:false`). Voice
   * escalation's hook/follow-up emails aren't triggered by an inbound
   * message the way an ordinary reply is, so there's no `source_message_id`
   * to thread from later; the caller patches Gmail's own `id`/`threadId`
   * onto this row after actually sending, once those are known.
   */
  outboundMessageId: string | null;
}

/**
 * The whole inbound pipeline: identify the prospect by sender address, load
 * their history, retrieve, reply, capture signals, score, persist.
 *
 * Shared by two callers that must never drift apart — `/api/leadgen/simulate`
 * (the HTTP test harness and creator preview) and the Gmail poller (real
 * production traffic). Extracted so the honesty-check tests written against
 * `/simulate` keep covering the exact path real mail runs through, not a
 * parallel copy of it that could quietly diverge.
 */
export async function runLeadgenPipeline(params: RunPipelineParams): Promise<PipelineResult> {
  const db = params.db;
  const creatorId = params.creatorId;
  const email = params.fromEmail.trim().toLowerCase();
  // Strip the quoted previous email here, at the shared chokepoint, rather
  // than in the Gmail client — otherwise /api/leadgen/simulate (the test
  // harness and creator preview) would see raw quoted text while production
  // saw stripped text, which defeats the entire reason this pipeline was
  // extracted: both callers must run the identical path.
  const question = stripQuotedReply(params.text).trim();
  const persist = params.persist !== false;

  const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(creatorId);
  if (!creator) throw new CreatorNotFoundError(creatorId);

  // Matched by sender address, never by mail thread — somebody writing again
  // weeks later under a new subject is the same person and their history
  // should load.
  let prospect = await db
    .prepare('SELECT * FROM prospects WHERE creator_id = ? AND email = ?')
    .get<Record<string, any>>(creatorId, email);

  if (!prospect && persist) {
    const pid = id('prospect');
    await db
      .prepare(
        `INSERT INTO prospects (id, creator_id, email, name, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(pid, creatorId, email, params.fromName ?? null, now(), now());
    prospect = await db.prepare('SELECT * FROM prospects WHERE id = ?').get<Record<string, any>>(pid);
  }

  const history = prospect
    ? await db
        .prepare('SELECT direction, body FROM prospect_messages WHERE prospect_id = ? ORDER BY created_at')
        .all<{ direction: string; body: string }>(prospect.id)
    : [];

  const allKnowledge = await loadKnowledge(db, creatorId);
  const offers = await loadOffers(db, creatorId);

  // A failed embedding must not cost the prospect their answer — retrieval
  // degrades to keyword scoring rather than the whole reply erroring out.
  let queryVector: Float32Array | null = null;
  if (params.ai) {
    try {
      queryVector = await embedQuery(params.ai, question);
    } catch (err) {
      console.error('query embedding failed, falling back to keyword retrieval', err);
    }
  }
  const knowledge = selectKnowledgeHybrid(allKnowledge, question, queryVector);

  const terminology = [
    ...new Set(
      allKnowledge.flatMap((k) => {
        try {
          const t = JSON.parse(k.framework_terms_json);
          return Array.isArray(t) ? t.filter((x) => typeof x === 'string') : [];
        } catch {
          return [];
        }
      }),
    ),
  ].slice(0, 40);

  const generated = await generateReply({
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    model: params.model,
    creator,
    question,
    knowledge,
    offers,
    terminology,
    prospect: {
      name: prospect?.name ?? params.fromName ?? null,
      situation: prospect?.situation ?? null,
      goal: prospect?.goal ?? null,
      tried: prospect?.tried ?? null,
      blocked_on: prospect?.blocked_on ?? null,
      diagnosedProblem: prospect?.diagnosed_problem ?? null,
      knowledgeLevel: prospect?.knowledge_level ?? null,
      urgency: prospect?.urgency ?? null,
      objections: safeArr(prospect?.objections_json),
      priorExchanges: prospect?.exchanges ?? 0,
      askedAbout: prospect?.last_asked_about ?? null,
      askedDimensions: safeArr(prospect?.asked_dimensions_json),
      alreadyPitched: Boolean(prospect?.offer_pitched),
    },
    history,
    // Signed so a click cannot be forged into another creator's attribution.
    offerLink: (offerId) =>
      `${params.publicBaseUrl}/r/${offerId}.${prospect ? prospect.id : 'anon'}.${hmacHex(params.mcpTokenSecret, `${offerId}:${prospect ? prospect.id : 'anon'}`).slice(0, 16)}`,
  });

  // The model's read and the deterministic check are ORed: either one is
  // enough to stop. A false positive costs one unsent reply; a false negative
  // means emailing someone who asked to be left alone.
  const optedOut = generated.signals.message_type === 'opt_out' || looksLikeOptOut(question);
  if (optedOut && persist && prospect) {
    await db.prepare('UPDATE prospects SET opted_out = 1, last_seen_at = ? WHERE id = ?').run(now(), prospect.id);
  }

  let outboundMessageId: string | null = null;
  if (persist && prospect) {
    const s = generated.signals;

    await applyProspectSignals(
      db,
      prospect,
      {
        situation: s.situation,
        goal: s.goal,
        tried: s.tried,
        blocked_on: s.blocked_on,
        diagnosed_problem: s.diagnosed_problem,
        knowledge_level: s.knowledge_level,
        urgency: s.urgency,
        objections: s.objections,
        topics: s.topics,
        requested_offer: s.requested_offer,
        hit_boundary: s.hit_boundary,
        qualifies_for_offer: s.qualifies_for_offer,
      },
      {
        // Only a PAID recommendation counts as "already pitched". Sending a
        // free video is not a pitch, and letting it set this flag would
        // permanently suppress the real recommendation later.
        offerPitched: Boolean(generated.routedOfferId && !generated.sharedFreeResource),
        name: params.fromName ?? null,
      },
    );

    // Email-only bookkeeping: which discovery dimension the LAST reply
    // asked about, so a later turn never re-asks it. Deliberately
    // overwritten each turn rather than COALESCEd — must clear when a
    // reply asks nothing, or a stale value would suppress a legitimate
    // question later. Doesn't apply to a live call (no single
    // discovery_question field there), so this stays outside the shared
    // applyProspectSignals() rather than baked into it.
    const askedDimensions = [
      ...new Set([...safeArr(prospect.asked_dimensions_json), ...(s.asked_about ? [s.asked_about] : [])]),
    ];
    await db
      .prepare('UPDATE prospects SET last_asked_about = ?, asked_dimensions_json = ? WHERE id = ?')
      .run(nullIfBlank(s.asked_about), JSON.stringify(askedDimensions), prospect.id);

    await db
      .prepare(
        `INSERT INTO prospect_messages (id, prospect_id, creator_id, direction, subject, body, source_message_id, created_at)
         VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?)`,
      )
      .run(id('msg'), prospect.id, creatorId, params.subject ?? null, question, params.sourceMessageId ?? null, now());

    outboundMessageId = id('msg');
    await db
      .prepare(
        `INSERT INTO prospect_messages
           (id, prospect_id, creator_id, direction, subject, body, routed_offer_id,
            prompt_tokens, completion_tokens, cost_usd_micros, created_at)
         VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        outboundMessageId,
        prospect.id,
        creatorId,
        params.subject ? `Re: ${params.subject}` : null,
        generated.body,
        generated.routedOfferId,
        generated.usage.promptTokens,
        generated.usage.completionTokens,
        Math.round(generated.usage.costUsd * 1e6),
        now(),
      );
  }

  return {
    creator,
    // Empty reply means the caller sends nothing. Silence is the correct
    // response to "stop emailing me" — a farewell note is still another email.
    reply: optedOut ? '' : generated.body,
    signals: generated.signals,
    routedOfferId: generated.routedOfferId,
    knowledgeUsed: knowledge.map((k) => ({ problem: k.problem, had_boundary: Boolean(k.boundary) })),
    prospectId: prospect?.id ?? null,
    outboundMessageId: optedOut ? null : outboundMessageId,
    usage: generated.usage,
  };
}
