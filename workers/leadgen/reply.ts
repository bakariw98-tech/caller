import type { SqlDb } from '../db/types.js';
import type { Creator } from '../../src/domain/types.js';
import { chatCompletionJson, USD_PER_TICK } from '../xai/client.js';
import { buildReplyInstructions, type KnowledgeForReply, type OfferForReply, type ProspectContext } from './prompt.js';
import { cosineSimilarity, decodeVector } from './embeddings.js';

export interface KnowledgeRow {
  id: string;
  problem: string;
  who_for: string | null;
  guidance: string;
  framework_terms_json: string;
  boundary: string | null;
  boundary_offer_id: string | null;
  /** base64 Float32Array, null until the item has been indexed. */
  embedding?: string | null;
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
export function keywordScores(rows: KnowledgeRow[], question: string): Map<string, number> {
  const terms = new Set(tokenize(question));
  const out = new Map<string, number>();
  if (terms.size === 0) return out;

  for (const row of rows) {
    const problemTokens = new Set(tokenize(row.problem));
    const bodyTokens = new Set(tokenize(`${row.guidance} ${row.who_for ?? ''} ${row.framework_terms_json}`));
    let score = 0;
    for (const t of terms) {
      if (problemTokens.has(t)) score += 3;
      else if (bodyTokens.has(t)) score += 1;
    }
    if (score > 0) out.set(row.id, score);
  }
  return out;
}

export function selectKnowledge(rows: KnowledgeRow[], question: string, limit = 6): KnowledgeRow[] {
  const scores = keywordScores(rows, question);
  return rows
    .filter((r) => scores.has(r.id))
    .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
    .slice(0, limit);
}

/**
 * Minimum cosine similarity for an item to count as relevant at all.
 *
 * Measured, not guessed — and the measurement overturned the first guess. On a
 * real corpus via /retrieval-debug, BGE scored genuinely relevant questions at
 * 0.53-0.63 and clearly off-topic ones at 0.42-0.56. Those bands nearly touch:
 * BGE compresses everything into a narrow range, so there is no absolute
 * threshold that cleanly separates them. An initial 0.62 looked reasonable and
 * would have silently rejected "nobody is buying from my website even though
 * people visit it" (top item 0.579) — reintroducing exactly the false-decline
 * bug embeddings were added to fix.
 *
 * So the floor is set low, to trim obvious junk only, because the two failure
 * directions cost very different amounts. Too high means a real question the
 * material answers gets "I don't cover that" — the product's worst failure.
 * Too low means the model is handed a few marginal items, and its grounding
 * instructions make it decline anyway, which is observed behaviour rather than
 * hope: gardening, mortgage and dog-training questions were all declined
 * correctly even when marginal material was retrieved. The prompt is the real
 * backstop here; this floor just keeps the obvious noise out of the context.
 */
export const SEMANTIC_FLOOR = 0.5;

/**
 * Keyword score needed to pull an item in despite a weak vector.
 *
 * 3 is one problem-field term match. Set at 1 — any single incidental body
 * word — a gardening question matched a copywriting item and bypassed the
 * floor entirely, which is how off-topic material reached the context.
 */
const KEYWORD_RESCUE_MIN = 3;

/** Weight of semantic score relative to keyword score in the blend. */
const SEMANTIC_WEIGHT = 0.75;
const KEYWORD_WEIGHT = 0.25;

/**
 * Hybrid retrieval: semantic similarity blended with keyword overlap.
 *
 * Not pure semantic, deliberately. Embeddings understand paraphrase, which is
 * the whole point of this upgrade, but they blur exact tokens — a creator's
 * coined framework name or product name is precisely the thing a prospect
 * might quote verbatim, and that is where literal matching wins. Each covers
 * the other's failure.
 *
 * Falls back to keyword-only for any item without a stored vector, so an
 * un-indexed corpus degrades to the old behaviour instead of returning
 * nothing at all.
 */
export function selectKnowledgeHybrid(
  rows: KnowledgeRow[],
  question: string,
  queryVector: Float32Array | null,
  limit = 6,
): KnowledgeRow[] {
  if (!queryVector) return selectKnowledge(rows, question, limit);

  const kw = keywordScores(rows, question);

  // Normalise keyword scores against the best one rather than against rank
  // position. Rank is far too coarse on a small corpus: two items with an
  // identical keyword score would land at 1.0 and 0.5 purely from array order,
  // and that gap is wide enough to outweigh a real semantic difference. By
  // value, equal scores stay equal.
  const bestKeyword = Math.max(0, ...kw.values());

  const scored = rows.map((row) => {
    const vec = row.embedding ? decodeVector(row.embedding) : null;
    const semantic = vec ? cosineSimilarity(queryVector, vec) : 0;
    const keyword = bestKeyword > 0 ? (kw.get(row.id) ?? 0) / bestKeyword : 0;
    return { row, semantic, score: semantic * SEMANTIC_WEIGHT + keyword * KEYWORD_WEIGHT };
  });

  // An item clears the bar on its own semantic merit, or by being a literal
  // keyword hit. The floor applies to the semantic signal specifically —
  // blending first would let a strong keyword score drag an irrelevant item
  // over the line, which is how off-topic questions start getting answered.
  const relevant = scored.filter(
    (x) => x.semantic >= SEMANTIC_FLOOR || (kw.get(x.row.id) ?? 0) >= KEYWORD_RESCUE_MIN,
  );

  return relevant
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
  /** Distinct from hit_boundary: they described themselves as who an offer is for, independent of any content gap. */
  qualifies_for_offer: boolean;
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
      description: 'True only if their need genuinely ran past a content boundary marked in the material.',
    },
    qualifies_for_offer: {
      type: 'boolean',
      description:
        'True only if they described their own situation in a way that specifically and concretely matches an ' +
        "offer's who_for, independent of any content boundary. False for a vague or partial resemblance.",
    },
    routed_offer_name: {
      type: 'string',
      description: 'Exact name of the offer you pointed them to, if you did. Omit if you did not.',
    },
    offer_pitch: {
      type: 'string',
      description:
        'ONLY when routed_offer_name is set: 1-3 sentences bridging their specific situation to the specific ' +
        'thing the offer does for it. This is the only place the offer is mentioned — do not also reference it ' +
        'in body. Omit entirely when not routing.',
    },
    answered_from_material: {
      type: 'boolean',
      description: "True if you answered from the creator's material; false if you had to say it wasn't covered.",
    },
  },
  required: ['body', 'objections', 'topics', 'hit_boundary', 'qualifies_for_offer', 'answered_from_material'],
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
 * Assembles the final email when routing: the help, then the pitch, then the
 * link — never a bare URL appended to whatever the model happened to write.
 *
 * `offer_pitch` is a separate structured field rather than something folded
 * into free-form `body` for a concrete reason: when the offer mention lived
 * inside the main prose, it was inconsistent — sometimes a real, specific
 * bridge to what the person said, sometimes nothing more than the model
 * trailing off with a URL on its own line, because writing the answer and
 * managing the pitch and remembering the link were all one undifferentiated
 * task competing for the same attention. Splitting it into its own required
 * generation target is what makes the pitch reliable rather than occasional.
 *
 * Falls back to a plain, honest line if the model routed but skipped the
 * pitch anyway — still worse than a real one, but never a naked link with
 * nothing around it, and never silently drops the link the way a bare
 * append-if-missing check previously could.
 */
export function buildRoutedBody(body: string, offerName: string, offerPitch: string | undefined, link: string): string {
  const pitch = offerPitch?.trim();
  const closer = pitch || `You can find ${offerName} here:`;
  return `${body.trimEnd()}\n\n${closer}\n\n${link}`;
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
    qualifies_for_offer: boolean;
    routed_offer_name?: string;
    offer_pitch?: string;
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
    ? buildRoutedBody(value.body, routedOffer.name, value.offer_pitch, params.offerLink(routedOffer.id))
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
      qualifies_for_offer: Boolean(value.qualifies_for_offer),
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
      `SELECT id, problem, who_for, guidance, framework_terms_json, boundary, boundary_offer_id, embedding
         FROM knowledge_items WHERE creator_id = ?`,
    )
    .all<KnowledgeRow>(creatorId);
}

export async function loadOffers(db: SqlDb, creatorId: string): Promise<OfferRow[]> {
  return db
    .prepare('SELECT id, name, who_for, covers, price_text, url FROM offers WHERE creator_id = ? AND active = 1')
    .all<OfferRow>(creatorId);
}
