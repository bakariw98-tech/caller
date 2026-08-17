import type { SqlDb } from '../db/types.js';
import type { Creator } from '../../src/domain/types.js';
import { chatCompletionJson, USD_PER_TICK } from '../xai/client.js';
import { buildReplyInstructions, type KnowledgeForReply, type OfferForReply, type ProspectContext } from './prompt.js';

export interface KnowledgeRow {
  id: string;
  problem: string;
  who_for: string | null;
  guidance: string;
  framework_terms_json: string;
  boundary: string | null;
  boundary_offer_id: string | null;
}

export interface OfferRow {
  id: string;
  name: string;
  who_for: string | null;
  covers: string | null;
  price_text: string | null;
  url: string | null;
}

const STOPWORDS = new Set([
  'the','and','but','for','are','was','were','this','that','with','have','has','not','you','your','ive',
  'its','from','what','when','why','how','about','into','they','them','there','here','been','does','did',
  'doing','can','cant','could','should','would','like','just','get','got','now','out','off','all','any',
  'would','really','some','than','then','only','also','very','much','need','want','know','think','make',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((t) => t.replace(/'/g, ''))
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Picks the knowledge most likely to answer this question.
 *
 * Same JS-side scoring as searchCurriculum() in curriculum/repository.ts, and
 * for the same reason — D1's FTS5 support is unconfirmed and one creator's
 * free content is small enough that scoring in memory is simpler than
 * depending on an unverified extension.
 *
 * The `problem` field carries most of the signal, since it was extracted as
 * the situation a prospect would arrive with — so it is weighted above the
 * guidance prose, which is longer and dilutes overlap.
 */
export function selectKnowledge(rows: KnowledgeRow[], question: string, limit = 6): KnowledgeRow[] {
  const terms = new Set(tokenize(question));
  if (terms.size === 0) return [];

  return rows
    .map((row) => {
      const problemTokens = new Set(tokenize(row.problem));
      const bodyTokens = new Set(tokenize(`${row.guidance} ${row.who_for ?? ''} ${row.framework_terms_json}`));
      let score = 0;
      for (const t of terms) {
        if (problemTokens.has(t)) score += 3;
        else if (bodyTokens.has(t)) score += 1;
      }
      return { row, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.row);
}

export interface QualificationSignals {
  situation: string | null;
  tried: string | null;
  blocked_on: string | null;
  objections: string[];
  topics: string[];
  hit_boundary: boolean;
  routed_offer_name: string | null;
  answered_from_material: boolean;
}

export interface GeneratedReply {
  body: string;
  signals: QualificationSignals;
  routedOfferId: string | null;
  usage: { promptTokens: number; completionTokens: number; costUsd: number };
}

const replyJson = {
  type: 'object',
  properties: {
    body: { type: 'string', description: 'The email body. No subject line, no signature.' },
    situation: { type: 'string', description: "The person's situation, if they described one." },
    tried: { type: 'string', description: 'What they have already tried, if stated.' },
    blocked_on: { type: 'string', description: 'What is actually in their way, if clear.' },
    objections: { type: 'array', items: { type: 'string' }, description: 'Doubts or reservations they raised.' },
    topics: { type: 'array', items: { type: 'string' }, description: 'Topics they asked about.' },
    hit_boundary: {
      type: 'boolean',
      description: 'True only if their need genuinely ran past a boundary marked in the material.',
    },
    routed_offer_name: {
      type: 'string',
      description: 'Exact name of the offer you pointed them to, if you did. Omit if you did not.',
    },
    answered_from_material: {
      type: 'boolean',
      description: "True if you answered from the creator's material; false if you had to say it wasn't covered.",
    },
  },
  required: ['body', 'objections', 'topics', 'hit_boundary', 'answered_from_material'],
  additionalProperties: false,
} as const;

/**
 * Generates the reply and the qualification signals in one call.
 *
 * Deliberately one call rather than reply-then-classify: the model has just
 * decided what it knows about this person in order to write to them, so asking
 * it to also report that is nearly free, whereas a second pass would re-read
 * the thread and double the per-conversation cost of a product that pays for
 * its own inference. Scoring then falls out of the conversation instead of
 * needing a separate qualification step.
 */
/**
 * Guarantees a routed reply carries its tracking link.
 *
 * The prompt asks for the link twice and the model still omitted it in live
 * testing, while reporting the routed offer correctly in the structured output
 * every time — so the reliable signal is the structured field, not the prose.
 * A mention without a link is worthless to the creator, because offer_clicks is
 * the only evidence any of this made them money. Same lesson as record_progress
 * on the phone side: when a mechanical step depends on model discipline and the
 * model is inconsistent, do it in code instead.
 *
 * If the model did include the link, this leaves the body untouched — its own
 * phrasing reads better than an appended line.
 */
export function attachOfferLink(body: string, offerName: string, link: string): string {
  if (body.includes(link)) return body;
  return `${body.trimEnd()}\n\n${offerName}: ${link}`;
}

export async function generateReply(params: {
  apiBase: string;
  apiKey: string;
  model: string;
  creator: Creator;
  question: string;
  knowledge: KnowledgeRow[];
  offers: OfferRow[];
  terminology: string[];
  prospect: ProspectContext;
  history: { direction: string; body: string }[];
  offerLink: (offerId: string) => string;
}): Promise<GeneratedReply> {
  const offersForReply: OfferForReply[] = params.offers.map((o) => ({
    id: o.id,
    name: o.name,
    who_for: o.who_for,
    covers: o.covers,
    price_text: o.price_text,
    link: params.offerLink(o.id),
  }));

  const offerNameById = new Map(params.offers.map((o) => [o.name.toLowerCase(), o.id]));

  const knowledgeForReply: KnowledgeForReply[] = params.knowledge.map((k) => ({
    problem: k.problem,
    who_for: k.who_for,
    guidance: k.guidance,
    framework_terms: safeList(k.framework_terms_json),
    boundary: k.boundary,
    boundary_offer_name: k.boundary_offer_id
      ? (params.offers.find((o) => o.id === k.boundary_offer_id)?.name ?? null)
      : null,
  }));

  const system = buildReplyInstructions({
    creator: params.creator,
    knowledge: knowledgeForReply,
    offers: offersForReply,
    prospect: params.prospect,
    terminology: params.terminology,
  });

  const thread = params.history.length
    ? [
        'Earlier in this conversation:',
        ...params.history.slice(-6).map((m) => `${m.direction === 'inbound' ? 'THEM' : 'YOU'}: ${m.body}`),
        '',
      ].join('\n')
    : '';

  const { value, usage } = await chatCompletionJson<{
    body: string;
    situation?: string;
    tried?: string;
    blocked_on?: string;
    objections: string[];
    topics: string[];
    hit_boundary: boolean;
    routed_offer_name?: string;
    answered_from_material: boolean;
  }>(params.apiBase, params.apiKey, {
    model: params.model,
    system,
    user: `${thread}They have just written:\n\n${params.question}`,
    schemaName: 'lead_reply',
    schema: replyJson as unknown as Record<string, unknown>,
  });

  const routedOfferId = value.routed_offer_name
    ? (offerNameById.get(value.routed_offer_name.trim().toLowerCase()) ?? null)
    : null;

  const routedOffer = routedOfferId ? params.offers.find((o) => o.id === routedOfferId) : undefined;
  const body = routedOffer
    ? attachOfferLink(value.body, routedOffer.name, params.offerLink(routedOffer.id))
    : value.body;

  return {
    body,
    signals: {
      situation: value.situation ?? null,
      tried: value.tried ?? null,
      blocked_on: value.blocked_on ?? null,
      objections: value.objections ?? [],
      topics: value.topics ?? [],
      hit_boundary: Boolean(value.hit_boundary),
      routed_offer_name: value.routed_offer_name ?? null,
      answered_from_material: Boolean(value.answered_from_material),
    },
    routedOfferId,
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      costUsd: (usage.cost_in_usd_ticks ?? 0) * USD_PER_TICK,
    },
  };
}

function safeList(json: string): string[] {
  try {
    const p = JSON.parse(json);
    return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Readiness, derived from what the conversation actually did rather than from
 * a separate qualification step.
 *
 * Someone who came back repeatedly, described their situation, and ran past
 * the edge of the free material is further along than someone who asked once
 * and left — that ordering is the whole point, so depth and reaching the
 * boundary dominate, and a click counts most because it is the only signal
 * that is an action rather than a statement.
 */
export function scoreProspect(p: {
  exchanges: number;
  hit_boundary: number | boolean;
  clicked_offer: number | boolean;
  situation: string | null;
  blocked_on: string | null;
}): number {
  let score = 0;
  score += Math.min(p.exchanges, 5) * 8;
  if (p.situation) score += 10;
  if (p.blocked_on) score += 15;
  if (p.hit_boundary) score += 25;
  if (p.clicked_offer) score += 30;
  return Math.min(score, 100);
}

/** Loads a creator's knowledge for retrieval. */
export async function loadKnowledge(db: SqlDb, creatorId: string): Promise<KnowledgeRow[]> {
  return db
    .prepare(
      `SELECT id, problem, who_for, guidance, framework_terms_json, boundary, boundary_offer_id
         FROM knowledge_items WHERE creator_id = ?`,
    )
    .all<KnowledgeRow>(creatorId);
}

export async function loadOffers(db: SqlDb, creatorId: string): Promise<OfferRow[]> {
  return db
    .prepare('SELECT id, name, who_for, covers, price_text, url FROM offers WHERE creator_id = ? AND active = 1')
    .all<OfferRow>(creatorId);
}
