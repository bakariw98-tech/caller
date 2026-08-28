import { cosineSimilarity } from './embeddings.js';
import { tokenize } from './reply.js';

/**
 * Cross-batch dedup for whole-channel ingestion.
 *
 * `extractFreeContent()` (extract.ts) only dedupes within the sources handed
 * to one call. Whole-channel ingestion processes videos a few at a time in
 * the background (see workers/index.ts's ingest tick), so the same core idea
 * restated across dozens of separately-processed videos would otherwise
 * produce dozens of near-identical rows, each competing in retrieval and
 * making the reply that answers a question look like a search results page —
 * exactly the failure extract.ts's own within-call dedup exists to prevent,
 * just recurring across calls instead of within one.
 *
 * This runs the same comparison extract.ts does implicitly, explicitly and
 * repeatedly: for every newly extracted item, against every existing item
 * the creator already has.
 *
 * Two signals, not one, deliberately:
 *  - Semantic similarity of the combined problem+guidance text (the same
 *    representation already stored for retrieval, see
 *    embeddingTextForItem() in embeddings.ts) decides whether two rows are
 *    even about the same topic. Embeddings understand paraphrase, which
 *    literal matching cannot.
 *  - Keyword overlap of the guidance text specifically decides whether, once
 *    on the same topic, the two rows are actually SAYING the same thing.
 *    Embeddings alone are the wrong tool here: two rows on "how do I
 *    validate a product idea" score high on topic similarity whether they
 *    agree ("test with paid ads first") or flatly disagree ("don't spend on
 *    ads before validating demand") — the combined vector is dominated by
 *    the shared problem statement and domain vocabulary, not by whether the
 *    advice matches. Literal overlap is a coarser but more honest signal for
 *    "is this genuinely the same guidance" than semantic similarity is.
 *
 * A topic match with LOW guidance overlap is flagged as a conflict rather
 * than merged or silently dropped — see the schema comment on
 * knowledge_items.conflicts_with for why this deliberately does not try to
 * resolve the disagreement itself.
 */

export interface DedupeCandidate {
  problem: string;
  guidance: string;
  /** Same representation as the stored `embedding` column — embed embeddingTextForItem(problem, guidance). */
  embedding: Float32Array;
}

export interface ExistingKnowledgeForDedupe {
  id: string;
  guidance: string;
  embedding: Float32Array;
}

export type DedupeDecision =
  | { action: 'insert' }
  | { action: 'merge'; matchId: string; similarity: number }
  | { action: 'conflict'; matchId: string; similarity: number };

/**
 * Minimum combined-embedding similarity for two rows to even be considered
 * the same topic. Provisional pending measurement against real duplicate
 * pairs from a live channel (task #40 of the ingestion plan) — the same
 * "measure, don't guess" discipline SEMANTIC_FLOOR was set with, just
 * deferred here because that measurement needs real duplicate content to
 * measure against, which does not exist until a real channel is ingested.
 * Set high deliberately: the cost of a false merge (two disagreeing videos
 * silently collapsed into one row) is worse than the cost of a false split
 * (one idea appearing as two rows, which retrieval already tolerates fine).
 */
export const TOPIC_MATCH_THRESHOLD = 0.85;

/**
 * Overlap-coefficient floor (shared tokens / smaller token set) on the
 * GUIDANCE text alone, within a topic match, for the two rows to count as
 * agreeing rather than landing in conflicts_with. Overlap coefficient rather
 * than Jaccard because one video's restatement of a point is often a subset
 * of another's fuller explanation — penalising that for differing length
 * would flag agreement as a mismatch.
 *
 * Measured live on a real 100+ video channel, and the two distributions this
 * is trying to separate do not cleanly separate: a same-video pair
 * restating one specific recommendation ("build a simpler version using
 * Base 44, price around $29, model the ads") scored 0.308 purely because
 * the two videos named different specific tools and numbers on the way to
 * saying the same thing, while several genuinely different pieces of advice
 * on nearby topics scored 0.30-0.34 too. There is no threshold value here
 * that reliably tells "restated" from "related but distinct" apart on real
 * text — this is a coarse token signal, not a semantic one, and raising or
 * lowering it just moves which side gets the wrong answer more often.
 *
 * Given that, this stays conservative (biased toward "flag for the creator"
 * over "auto-merge and possibly discard real guidance") rather than
 * chasing a cleaner cutoff that the measurement shows does not exist. See
 * the knowledge_items.conflicts_with schema comment — the label this
 * produces is "similar enough to look at", not "confirmed disagreement".
 */
export const GUIDANCE_AGREEMENT_THRESHOLD = 0.35;

function keywordOverlapRatio(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

/**
 * Pure decision, no DB or network — the caller embeds the candidate and
 * loads existing rows' embeddings first. Picks the single best topic match
 * (highest similarity) rather than the first one over the floor, so a
 * candidate near two existing items merges into the closer one.
 */
export function decideDedupe(candidate: DedupeCandidate, existing: ExistingKnowledgeForDedupe[]): DedupeDecision {
  let best: { row: ExistingKnowledgeForDedupe; sim: number } | null = null;
  for (const row of existing) {
    const sim = cosineSimilarity(candidate.embedding, row.embedding);
    if (sim >= TOPIC_MATCH_THRESHOLD && (!best || sim > best.sim)) best = { row, sim };
  }
  if (!best) return { action: 'insert' };

  const overlap = keywordOverlapRatio(candidate.guidance, best.row.guidance);
  if (overlap >= GUIDANCE_AGREEMENT_THRESHOLD) {
    return { action: 'merge', matchId: best.row.id, similarity: best.sim };
  }
  return { action: 'conflict', matchId: best.row.id, similarity: best.sim };
}

/**
 * Merges two source_refs_json arrays (video/content titles), deduplicated
 * and order-preserving, for the UPDATE that appends a merge target's
 * reference onto the row it matched instead of inserting a new row.
 */
export function mergeSourceRefs(existingRefsJson: string, newRefs: string[]): string {
  let existing: string[] = [];
  try {
    const parsed = JSON.parse(existingRefsJson);
    if (Array.isArray(parsed)) existing = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    existing = [];
  }
  return JSON.stringify([...new Set([...existing, ...newRefs])]);
}
