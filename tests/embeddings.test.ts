import { describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  encodeVector,
  decodeVector,
  embeddingTextForItem,
  EMBEDDING_DIMS,
} from '../workers/leadgen/embeddings.js';
import { selectKnowledgeHybrid, SEMANTIC_FLOOR, type KnowledgeRow } from '../workers/leadgen/reply.js';

function vec(fill: (i: number) => number): Float32Array {
  return Float32Array.from({ length: EMBEDDING_DIMS }, (_, i) => fill(i));
}

describe('vector encoding', () => {
  it('round-trips a vector exactly', () => {
    const v = vec((i) => Math.sin(i) * 0.5);
    const back = decodeVector(encodeVector(v));
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual(Array.from(v));
  });

  it('rejects a vector of the wrong dimensionality rather than scoring it', () => {
    // A stored vector from a different embedding model is not comparable to a
    // fresh one; silently scoring it would degrade retrieval invisibly.
    const wrong = Float32Array.from([1, 2, 3]);
    expect(decodeVector(encodeVector(wrong))).toBeNull();
  });

  it('returns null on garbage rather than throwing into the request path', () => {
    expect(decodeVector('not base64 !!!')).toBeNull();
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    const v = vec((i) => (i % 7) + 1);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('is 0 for orthogonal vectors', () => {
    const a = vec((i) => (i % 2 === 0 ? 1 : 0));
    const b = vec((i) => (i % 2 === 0 ? 0 : 1));
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('is scale-invariant — magnitude must not beat direction', () => {
    const a = vec((i) => i + 1);
    const b = vec((i) => (i + 1) * 100);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it('returns 0 on a length mismatch instead of throwing', () => {
    expect(cosineSimilarity(vec(() => 1), Float32Array.from([1, 2]))).toBe(0);
  });
});

describe('embeddingTextForItem', () => {
  it('includes both problem and guidance so answer-only wording is still findable', () => {
    const t = embeddingTextForItem('How do I price work?', 'Estimate cut hours and add forty percent.');
    expect(t).toContain('How do I price work?');
    expect(t).toContain('cut hours');
  });

  it('truncates very long guidance rather than exceeding the model input cap', () => {
    expect(embeddingTextForItem('Q', 'x'.repeat(9000)).length).toBeLessThanOrEqual(1800);
  });
});

// A near-identical vector to `base`, tunable to land above or below the floor.
function similarTo(base: Float32Array, similarity: number): Float32Array {
  const orth = vec((i) => (i % 2 === 0 ? 1 : -1));
  const out = new Float32Array(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i++) out[i] = base[i]! * similarity + orth[i]! * (1 - similarity);
  return out;
}

describe('selectKnowledgeHybrid', () => {
  const query = vec((i) => Math.cos(i * 0.1));

  function row(id: string, problem: string, v: Float32Array | null, tier?: number): KnowledgeRow {
    return {
      id,
      problem,
      who_for: null,
      guidance: 'some guidance text',
      framework_terms_json: '[]',
      boundary: null,
      boundary_offer_id: null,
      embedding: v ? encodeVector(v) : null,
      tier,
    };
  }

  it('surfaces a semantically close item even with no shared words', () => {
    // The whole point of the upgrade: "pricing" should reach "what to charge".
    const rows = [row('k1', 'What should I charge for my first job?', similarTo(query, 0.99))];
    const hits = selectKnowledgeHybrid(rows, 'help me with pricing', query);
    expect(hits.map((h) => h.id)).toEqual(['k1']);
  });

  it('drops items below the semantic floor when no keyword matches either', () => {
    // Protects the honest decline. Cosine has no natural zero, so without this
    // an off-topic question retrieves its "least bad" item and the model is
    // handed irrelevant material to answer from.
    const rows = [row('k1', 'zzz unrelated topic', similarTo(query, 0.1))];
    const hits = selectKnowledgeHybrid(rows, '完全に無関係', query);
    expect(hits).toEqual([]);
  });

  it('keeps a literal keyword match even when its vector is weak', () => {
    // Coined framework and product names are exactly what embeddings blur and
    // literal matching catches.
    const rows = [row('k1', 'What is the halo strategy document?', similarTo(query, 0.05))];
    const hits = selectKnowledgeHybrid(rows, 'explain the halo strategy document', query);
    expect(hits.map((h) => h.id)).toEqual(['k1']);
  });

  it('ranks the more semantically similar item first', () => {
    const rows = [
      row('far', 'loosely related thing', similarTo(query, 0.7)),
      row('near', 'closely related thing', similarTo(query, 0.99)),
    ];
    const hits = selectKnowledgeHybrid(rows, 'related thing', query);
    expect(hits[0]?.id).toBe('near');
  });

  it('breaks a near-tie in favor of the tier-1 (tutorial/framework) item', () => {
    const rows = [
      row('tier2', 'closely related thing', similarTo(query, 0.9), 2),
      row('tier1', 'closely related thing', similarTo(query, 0.9), 1),
    ];
    const hits = selectKnowledgeHybrid(rows, 'related thing', query);
    expect(hits[0]?.id).toBe('tier1');
  });

  it('does not let the tier-1 boost override a genuinely stronger semantic match', () => {
    const rows = [
      row('tier1_weak', 'loosely related thing', similarTo(query, 0.55), 1),
      row('tier2_strong', 'closely related thing', similarTo(query, 0.99), 2),
    ];
    const hits = selectKnowledgeHybrid(rows, 'related thing', query);
    expect(hits[0]?.id).toBe('tier2_strong');
  });

  it('falls back to keyword scoring when there is no query vector', () => {
    const rows = [row('k1', 'sourdough starter not rising', null)];
    expect(selectKnowledgeHybrid(rows, 'starter not rising', null).map((h) => h.id)).toEqual(['k1']);
    expect(selectKnowledgeHybrid(rows, 'unrelated aviation question', null)).toEqual([]);
  });

  it('falls back to keyword scoring for rows that have no stored vector', () => {
    // An un-indexed corpus must degrade to the old behaviour, not to nothing.
    const rows = [row('k1', 'sourdough starter not rising', null)];
    expect(selectKnowledgeHybrid(rows, 'starter not rising', query).map((h) => h.id)).toEqual(['k1']);
  });

  it('respects the limit', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row('k' + i, 'related topic ' + i, similarTo(query, 0.99)));
    expect(selectKnowledgeHybrid(rows, 'related topic', query, 3)).toHaveLength(3);
  });

  it('keeps the floor below the measured relevant-question band', () => {
    // Measured on a real corpus: relevant questions scored 0.53-0.63, clearly
    // off-topic ones 0.42-0.56. A floor at or above ~0.58 starts rejecting
    // real questions, which is the failure embeddings were added to fix.
    expect(SEMANTIC_FLOOR).toBeGreaterThan(0.4);
    expect(SEMANTIC_FLOOR).toBeLessThan(0.55);
  });

  it('does not let a single incidental keyword hit bypass the floor', () => {
    // A weak body-word match on an unrelated item must not drag it into the
    // model's context — observed with a gardening question matching a
    // copywriting item on one common word.
    const weak = row('k1', 'totally unrelated subject matter', similarTo(query, 0.02));
    weak.guidance = 'incidental overlap fertilizer';
    expect(selectKnowledgeHybrid([weak], 'fertilizer', query)).toEqual([]);
  });
});
