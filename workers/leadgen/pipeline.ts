import type { SqlDb } from '../db/types.js';
import type { Creator } from '../../src/domain/types.js';
import { id, now, hmacHex } from '../../src/util/ids.js';
import {
  generateReply,
  loadKnowledge,
  loadOffers,
  selectKnowledgeHybrid,
  scoreProspect,
  type GeneratedReply,
} from './reply.js';
import { embedQuery, type AiBinding } from './embeddings.js';

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
}

function safeArr(json: unknown): string[] {
  if (typeof json !== 'string') return [];
  try {
    const p = JSON.parse(json);
    return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
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
  const question = params.text.trim();
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
      objections: safeArr(prospect?.objections_json),
      priorExchanges: prospect?.exchanges ?? 0,
      askedAbout: prospect?.last_asked_about ?? null,
    },
    history,
    // Signed so a click cannot be forged into another creator's attribution.
    offerLink: (offerId) =>
      `${params.publicBaseUrl}/r/${offerId}.${prospect ? prospect.id : 'anon'}.${hmacHex(params.mcpTokenSecret, `${offerId}:${prospect ? prospect.id : 'anon'}`).slice(0, 16)}`,
  });

  if (persist && prospect) {
    const s = generated.signals;
    const objections = [...new Set([...safeArr(prospect.objections_json), ...s.objections])];
    const topics = [...new Set([...safeArr(prospect.topics_json), ...s.topics])];
    const exchanges = (prospect.exchanges ?? 0) + 1;
    // Stored as one column for scoring purposes, even though the model
    // reports two distinct reasons — a content gap versus a self-disclosed
    // fit with an offer. Both mean the same thing to a creator glancing at
    // the prospects list: this person is worth their attention.
    const hitBoundary = prospect.hit_boundary || s.hit_boundary || s.qualifies_for_offer ? 1 : 0;

    const score = scoreProspect({
      exchanges,
      hit_boundary: hitBoundary,
      clicked_offer: prospect.clicked_offer,
      situation: s.situation ?? prospect.situation,
      blocked_on: s.blocked_on ?? prospect.blocked_on,
      goal: s.goal ?? prospect.goal,
    });

    await db
      .prepare(
        `UPDATE prospects
            SET situation = COALESCE(?, situation), goal = COALESCE(?, goal), tried = COALESCE(?, tried),
                blocked_on = COALESCE(?, blocked_on), objections_json = ?, topics_json = ?,
                exchanges = ?, hit_boundary = ?, score = ?, last_seen_at = ?, name = COALESCE(name, ?),
                last_asked_about = ?
          WHERE id = ?`,
      )
      .run(
        s.situation,
        s.goal,
        s.tried,
        s.blocked_on,
        JSON.stringify(objections),
        JSON.stringify(topics),
        exchanges,
        hitBoundary,
        score,
        now(),
        params.fromName ?? null,
        // Deliberately overwritten each turn rather than COALESCEd: this
        // records what the LAST reply asked, so it must clear when a reply
        // asks nothing. Carrying a stale value forward would suppress a
        // legitimate question on a later turn.
        s.asked_about,
        prospect.id,
      );

    await db
      .prepare(
        `INSERT INTO prospect_messages (id, prospect_id, creator_id, direction, subject, body, source_message_id, created_at)
         VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?)`,
      )
      .run(id('msg'), prospect.id, creatorId, params.subject ?? null, question, params.sourceMessageId ?? null, now());

    await db
      .prepare(
        `INSERT INTO prospect_messages
           (id, prospect_id, creator_id, direction, subject, body, routed_offer_id,
            prompt_tokens, completion_tokens, cost_usd_micros, created_at)
         VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id('msg'),
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
    reply: generated.body,
    signals: generated.signals,
    routedOfferId: generated.routedOfferId,
    knowledgeUsed: knowledge.map((k) => ({ problem: k.problem, had_boundary: Boolean(k.boundary) })),
    prospectId: prospect?.id ?? null,
    usage: generated.usage,
  };
}
