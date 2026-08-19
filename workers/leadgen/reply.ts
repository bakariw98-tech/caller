import type { SqlDb } from '../db/types.js';
import type { Creator } from '../../src/domain/types.js';
import { chatCompletionJson, USD_PER_TICK } from '../xai/client.js';
import {
  buildReplyInstructions,
  buildHookInstructions,
  type KnowledgeForReply,
  type OfferForReply,
  type ProspectContext,
} from './prompt.js';
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
  /** The video this came from, when it came from one. Null for hand-pasted knowledge. */
  source_url?: string | null;
  /** 1 = tutorial/framework signal, 2 = everything else, from tierVideo() at ingestion. Defaults to 2 for hand-pasted knowledge, which was never tiered. */
  tier?: number;
}

export interface OfferRow {
  id: string;
  name: string;
  who_for: string | null;
  covers: string | null;
  price_text: string | null;
  url: string | null;
  /** A free resource (a video, guide, template) rather than something they pay for. */
  is_free?: number | boolean;
}

const STOPWORDS = new Set([
  'the','and','but','for','are','was','were','this','that','with','have','has','not','you','your','ive',
  'its','from','what','when','why','how','about','into','they','them','there','here','been','does','did',
  'doing','can','cant','could','should','would','like','just','get','got','now','out','off','all','any',
  'would','really','some','than','then','only','also','very','much','need','want','know','think','make',
]);

// Exported for dedupe.ts, which needs the identical tokenizer (same
// stopword list, same normalisation) to compare guidance text for the
// cross-batch dedup check — two divergent tokenizers would make that
// comparison meaningless.
export function tokenize(text: string): string[] {
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
 * Modest multiplier for tier-1 knowledge (tutorial/framework videos, see
 * workers/youtube/tier.ts) in the final ranking. Deliberately small — this
 * only breaks near-ties in a tier-1 item's favor, e.g. core methodology
 * outranking an offhand mention in a case-study video on an otherwise
 * similar match. It must not be large enough to pull a genuinely worse
 * semantic match above a genuinely better one; the floor and blend above
 * already decide relevance, this only nudges ordering within it.
 */
const TIER1_BOOST = 1.1;

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
    const blended = semantic * SEMANTIC_WEIGHT + keyword * KEYWORD_WEIGHT;
    const score = row.tier === 1 ? blended * TIER1_BOOST : blended;
    return { row, semantic, score };
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

export type MessageType =
  | 'question'
  | 'context'
  | 'acknowledgement'
  | 'clarification'
  | 'pushback'
  | 'buying_signal'
  | 'off_topic'
  | 'confused'
  | 'opt_out'
  | 'other'
  // Not one of the model's own choices — never in replyJson's enum, so the
  // model can never pick it. Synthesized in code by runHookPipeline
  // (workers/leadgen/inbound.ts) for a hook email, which runs a different,
  // much smaller generation call entirely. Exists so a hook turn is honestly
  // distinguishable in stored signals rather than overloaded onto 'other'.
  | 'hook_sent';

export type NextAction =
  | 'answer'
  | 'diagnose'
  | 'teach'
  | 'win'
  | 'resource'
  | 'offer'
  // Same reasoning as MessageType's 'hook_sent' — synthesized, never model-chosen.
  | 'invite_call';

export interface QualificationSignals {
  /** What the inbound message actually is. Drives how the reply is shaped. */
  message_type: MessageType;
  /** The most useful move this turn — asking is only one of the options. */
  next_action: NextAction;
  situation: string | null;
  /** The real bottleneck, diagnosed rather than reported. */
  diagnosed_problem: string | null;
  knowledge_level: string | null;
  urgency: string | null;
  /** They asked for the offer rather than being handed it — the metric that matters. */
  requested_offer: boolean;
  /** What they want — the destination half of the gap an offer closes. */
  goal: string | null;
  tried: string | null;
  blocked_on: string | null;
  /** The question asked this turn, if any. Kept separate from body so it cannot be dropped or made generic. */
  discovery_question: string | null;
  /** Which dimension that question probed, so the next turn never re-asks it. */
  asked_about: string | null;
  objections: string[];
  topics: string[];
  hit_boundary: boolean;
  /** Distinct from hit_boundary: they described themselves as who an offer is for, independent of any content gap. */
  qualifies_for_offer: boolean;
  routed_offer_name: string | null;
  /** Exact problem text of the knowledge item whose source video you told them to watch, if any. */
  video_reference_problem: string | null;
  answered_from_material: boolean;
}

export interface GeneratedReply {
  body: string;
  /** True when what was shared is a free resource rather than a paid offer. */
  sharedFreeResource: boolean;
  signals: QualificationSignals;
  routedOfferId: string | null;
  usage: { promptTokens: number; completionTokens: number; costUsd: number };
}

const replyJson = {
  type: 'object',
  properties: {
    // Deliberately the FIRST property. Generation is autoregressive, so
    // committing to an interpretation of the message before writing anything
    // makes the reply conditioned on that reading rather than the label being
    // a post-hoc guess about text already written.
    message_type: {
      type: 'string',
      enum: [
        'question',
        'context',
        'acknowledgement',
        'clarification',
        'pushback',
        'buying_signal',
        'off_topic',
        'confused',
        'opt_out',
        'other',
      ],
      description: 'What this message actually IS. Decide this before writing anything else.',
    },
    // Chosen before the body, for the same autoregressive reason as
    // message_type: deciding what the most useful move IS conditions what
    // gets written, instead of labelling it afterwards.
    next_action: {
      type: 'string',
      enum: ['answer', 'diagnose', 'teach', 'win', 'resource', 'offer'],
      description: 'The most useful thing you can do for this person right now. Decide before writing the body.',
    },
    body: { type: 'string', description: 'The email body. No subject line, no signature.' },
    situation: { type: 'string', description: "The person's situation, if they described one." },
    goal: { type: 'string', description: 'What they actually want — the outcome they are after, if stated.' },
    diagnosed_problem: {
      type: 'string',
      description:
        'The REAL bottleneck as you have worked it out — not merely what they reported. "Traffic is fine, ' +
        'the product page is not converting" rather than "not getting sales". Only when you can actually tell.',
    },
    knowledge_level: {
      type: 'string',
      description: 'What they already understand about this subject, if it is evident.',
    },
    urgency: { type: 'string', description: 'Why this matters to them and by when, if stated.' },
    requested_offer: {
      type: 'boolean',
      description:
        'True only if THEY asked for the offer, the link, or the price — rather than you raising it. ' +
        'The measure of whether enough understanding was built that they wanted the next step.',
    },
    tried: { type: 'string', description: 'What they have already tried, if stated.' },
    blocked_on: { type: 'string', description: 'What is actually in their way, if clear.' },
    discovery_question: {
      type: 'string',
      description:
        'The ONE question that reveals the next thing you need to know about them. Omit entirely when routing ' +
        'to an offer, when nothing offered could apply to them, or when you already know enough.',
    },
    asked_about: {
      type: 'string',
      description:
        'Which dimension discovery_question probes: situation, goal, tried, blocked_on, or objections. ' +
        'Omit when there is no discovery_question.',
    },
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
    video_reference_problem: {
      type: 'string',
      description:
        'If — and only if — a specific video would genuinely serve them better than the paragraph you just ' +
        'wrote (something visual or demonstrated on screen, not just discussed), copy the situation text of ' +
        'that item from the material above into this field, character for character. Copy ONLY the situation ' +
        'text itself — each item above is labelled "Situation: <text>"; copy <text>, and do not include the ' +
        'word "Situation" or the colon. You may mention that a video exists in body ("I actually show this on ' +
        'screen in one of my videos") but never write out the link or video title yourself — you do not ' +
        'reliably know the real URL, and the actual link is inserted afterward from this field. Omit entirely ' +
        'when nothing above is worth pointing them to a video for.',
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
  required: ['message_type', 'next_action', 'body', 'objections', 'topics', 'hit_boundary', 'qualifies_for_offer', 'answered_from_material'],
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
 * Assembles the final email from its structured parts:
 * `body` -> `discovery_question` -> `offer_pitch` -> link.
 *
 * The pitch and the question are separate structured fields rather than
 * things folded into free-form `body` for the same hard-won reason: when the
 * offer mention lived inside the main prose it was inconsistent — sometimes a
 * real bridge, sometimes the model trailing off with a bare URL — because
 * writing the answer, managing the pitch, and remembering the link were one
 * undifferentiated task competing for the same attention. Splitting each into
 * its own generation target is what makes them reliable rather than
 * occasional, and assembling here means the ordering and spacing are
 * guaranteed by code instead of hoped for.
 *
 * In practice the question and the pitch are mutually exclusive — the prompt
 * says to drop the question when routing, since a recommendation competing
 * with a fresh question weakens both. This still handles the case where the
 * model emits both rather than silently discarding output it produced: the
 * question sits with the help, and the pitch plus link close the email.
 */

/**
 * Normalizes a knowledge item's `problem` text for matching against
 * `video_reference_problem`. Strips a leading "Situation:" label if
 * present — the knowledge block in the prompt renders each item as
 * "Situation: <problem>", and observed live: the model copied the whole
 * rendered label, prefix included, into the field meant to hold just
 * <problem>. The instruction was tightened to ask for <problem> alone, but
 * this stays as the deterministic backstop — an exact-match lookup that
 * only works when the model's copy is letter-perfect is exactly the kind
 * of prompt-only guarantee this codebase does not rely on.
 */
export function normalizeVideoReference(s: string): string {
  return s.trim().replace(/^situation:\s*/i, '').trim().toLowerCase();
}
export function buildEmailBody(parts: {
  body: string;
  discoveryQuestion?: string | null;
  offerName?: string | null;
  offerPitch?: string | null;
  link?: string | null;
  /** Free resources read better woven into the body, so they get no added framing line. */
  isFreeResource?: boolean;
  /**
   * A knowledge item's source video, when the model referenced one. Same
   * problem as the offer link, observed live in exactly the same shape: the
   * model narrated "in this one, I show..." with no URL anywhere in the
   * reply — it knows a video exists but cannot reliably produce the real
   * address as literal text, the same reason offer links are never trusted
   * to appear correctly inside free-form body. Appended bare, no framing
   * sentence, for the same reason a free resource's link needs none — the
   * reference already lives naturally in the prose the model wrote.
   */
  videoLink?: string | null;
}): string {
  let body = parts.body.trimEnd();
  const question = parts.discoveryQuestion?.trim();

  // Strip the question from the body if the model wrote it in both places.
  // Observed live: the same sentence appearing twice in one reply, because
  // `discovery_question` is a separate field but nothing stopped the model
  // also ending `body` with it. Only a trailing occurrence is removed — the
  // question belongs at the end, and cutting a mid-body match could gut a
  // sentence that legitimately reads the same way.
  if (question && body.endsWith(question)) {
    body = body.slice(0, body.length - question.length).trimEnd();
  }

  const blocks = [body];
  if (parts.videoLink) blocks.push(parts.videoLink);
  if (question) blocks.push(question);

  if (parts.link) {
    const pitch = parts.offerPitch?.trim();
    if (pitch) {
      blocks.push(pitch);
    } else if (!parts.isFreeResource) {
      // A PAID recommendation always needs framing — a bare URL with nothing
      // explaining why it is there is worthless. A FREE resource does not:
      // the model naturally mentions it in the body ("I have a short video
      // that walks through this"), and adding a second description underneath
      // made the reader read the same thing twice. Working with that instinct
      // beats instructing against it.
      blocks.push(`You can find ${parts.offerName ?? 'it'} here:`);
    }
    blocks.push(parts.link);
  }

  return blocks.join('\n\n');
}

/**
 * Deterministically assembles the hook email — the phone number and call
 * code are appended in code, never written by the model, for the same
 * reason `buildEmailBody()` never trusts the model to transcribe a real
 * offer link: it doesn't reliably have it right, so it doesn't get to try.
 *
 * A bare `tel:` URI on its own line, in a plain-text email (this product
 * sends no HTML — see gmail.ts's buildRawMessage), is the closest thing to
 * a one-tap button available in that format; most mobile mail clients
 * auto-linkify it. The call code gets one short parenthetical, not a set
 * of numbered steps — the invitation should read like "want to talk it
 * through?", not a process to follow.
 */
export function buildHookEmailBody(parts: { teaser: string; phoneE164: string; callCode: string }): string {
  const telHref = `tel:${parts.phoneE164.replace(/[^\d+]/g, '')}`;
  return [parts.teaser.trim(), telHref, `(I'll ask for this quick code so I know it's you: ${parts.callCode})`].join(
    '\n\n',
  );
}

const hookJson = {
  type: 'object',
  properties: {
    teaser: {
      type: 'string',
      description: 'The 2-4 sentence email body. No subject line, no signature, no phone number or code.',
    },
  },
  required: ['teaser'],
  additionalProperties: false,
} as const;

/**
 * Generates just the warm teaser paragraph for a hook email — see
 * `buildHookInstructions()` for why this deliberately carries no
 * knowledge/offer context. `buildHookEmailBody()` assembles the rest.
 */
export async function generateHookReply(params: {
  apiBase: string;
  apiKey: string;
  model: string;
  creator: Creator;
  question: string;
}): Promise<{ teaser: string; usage: GeneratedReply['usage'] }> {
  const { value, usage } = await chatCompletionJson<{ teaser: string }>(params.apiBase, params.apiKey, {
    model: params.model,
    system: buildHookInstructions({ creator: params.creator }),
    user: `They just wrote:\n\n${params.question}`,
    schemaName: 'hook_reply',
    schema: hookJson as unknown as Record<string, unknown>,
  });
  return {
    teaser: value.teaser,
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      costUsd: (usage.cost_in_usd_ticks ?? 0) * USD_PER_TICK,
    },
  };
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
    isFree: Boolean(o.is_free),
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
    source_url: k.source_url ?? null,
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
    goal?: string;
    tried?: string;
    blocked_on?: string;
    discovery_question?: string;
    asked_about?: string;
    objections: string[];
    topics: string[];
    hit_boundary: boolean;
    qualifies_for_offer: boolean;
    routed_offer_name?: string;
    video_reference_problem?: string;
    offer_pitch?: string;
    answered_from_material: boolean;
    message_type?: MessageType;
    next_action?: NextAction;
    diagnosed_problem?: string;
    knowledge_level?: string;
    urgency?: string;
    requested_offer?: boolean;
  }>(params.apiBase, params.apiKey, {
    model: params.model,
    system,
    user: `${thread}They have just written:\n\n${params.question}`,
    schemaName: 'lead_reply',
    schema: replyJson as unknown as Record<string, unknown>,
  });

  // Gating differs by what is being pointed at, deterministically.
  //
  // A PAID offer may only go out when the chosen action is `offer`. Observed
  // live: the model picked `win` — give them something useful they can act on
  // immediately — wrote an excellent one, and then pitched in the same email
  // anyway, undercutting the exact trust that move exists to build. A prompt
  // cannot reliably hold a line the model has a standing incentive to cross,
  // so it is enforced here.
  //
  // A FREE resource has no such gate. Sending someone a relevant video costs
  // them nothing and asks nothing, so withholding it until they have been
  // qualified would make the system worse at the only job that earns trust in
  // the first place. Relevance is the whole bar.
  const namedOfferId = value.routed_offer_name
    ? (offerNameById.get(value.routed_offer_name.trim().toLowerCase()) ?? null)
    : null;
  const namedOffer = namedOfferId ? params.offers.find((o) => o.id === namedOfferId) : undefined;
  const isFreeResource = Boolean(namedOffer?.is_free);
  const routedOfferId = namedOffer && (isFreeResource || value.next_action === 'offer') ? namedOfferId : null;

  // Resolved the same way routed_offer_name is: an exact match against a
  // list the model actually saw, never invented. A video only gets linked
  // if it (a) exists in the retrieved material, not hallucinated, and (b)
  // actually has a source_url — hand-pasted knowledge has none, so a
  // reference to it is silently dropped rather than sending a broken link.
  const referencedVideo = value.video_reference_problem
    ? params.knowledge.find(
        (k) => normalizeVideoReference(k.problem) === normalizeVideoReference(value.video_reference_problem!),
      )
    : undefined;

  const routedOffer = routedOfferId ? params.offers.find((o) => o.id === routedOfferId) : undefined;
  const body = buildEmailBody({
    body: value.body,
    discoveryQuestion: value.discovery_question,
    offerName: routedOffer?.name,
    offerPitch: value.offer_pitch,
    link: routedOffer ? params.offerLink(routedOffer.id) : null,
    isFreeResource,
    videoLink: referencedVideo?.source_url ?? null,
  });

  return {
    body,
    sharedFreeResource: Boolean(routedOfferId) && isFreeResource,
    signals: {
      message_type: value.message_type ?? 'other',
      next_action: value.next_action ?? 'answer',
      situation: value.situation ?? null,
      diagnosed_problem: value.diagnosed_problem ?? null,
      knowledge_level: value.knowledge_level ?? null,
      urgency: value.urgency ?? null,
      requested_offer: Boolean(value.requested_offer),
      goal: value.goal ?? null,
      tried: value.tried ?? null,
      blocked_on: value.blocked_on ?? null,
      discovery_question: value.discovery_question?.trim() || null,
      asked_about: value.asked_about?.trim() || null,
      objections: value.objections ?? [],
      topics: value.topics ?? [],
      hit_boundary: Boolean(value.hit_boundary),
      qualifies_for_offer: Boolean(value.qualifies_for_offer),
      routed_offer_name: value.routed_offer_name ?? null,
      video_reference_problem: value.video_reference_problem ?? null,
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
  goal?: string | null;
}): number {
  let score = 0;
  score += Math.min(p.exchanges, 5) * 8;
  if (p.situation) score += 10;
  // Someone who has told you what they are actually after is further along
  // than someone who has only described where they are.
  if (p.goal) score += 10;
  if (p.blocked_on) score += 15;
  if (p.hit_boundary) score += 25;
  if (p.clicked_offer) score += 30;
  return Math.min(score, 100);
}

/** Loads a creator's knowledge for retrieval. */
export async function loadKnowledge(db: SqlDb, creatorId: string): Promise<KnowledgeRow[]> {
  return db
    .prepare(
      `SELECT id, problem, who_for, guidance, framework_terms_json, boundary, boundary_offer_id, embedding, source_url, tier
         FROM knowledge_items WHERE creator_id = ?`,
    )
    .all<KnowledgeRow>(creatorId);
}

export async function loadOffers(db: SqlDb, creatorId: string): Promise<OfferRow[]> {
  return db
    .prepare('SELECT id, name, who_for, covers, price_text, url, is_free FROM offers WHERE creator_id = ? AND active = 1')
    .all<OfferRow>(creatorId);
}
