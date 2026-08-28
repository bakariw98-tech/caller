import { describe, expect, it } from 'vitest';
import { decideDedupe, mergeSourceRefs, TOPIC_MATCH_THRESHOLD, type ExistingKnowledgeForDedupe } from '../workers/leadgen/dedupe.js';

/** A unit vector nudged slightly off `base` by `delta` on one axis, so cosine similarity is controllable and predictable rather than random. */
function vec(base: number[], delta: number[] = []): Float32Array {
  const v = base.map((x, i) => x + (delta[i] ?? 0));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / norm));
}

const BASE = [1, 0, 0, 0];

describe('decideDedupe', () => {
  it('inserts as new when nothing is topically close', () => {
    const existing: ExistingKnowledgeForDedupe[] = [
      { id: 'k1', guidance: 'Price per loaf, then multiply by 2.5.', embedding: vec([0, 1, 0, 0]) },
    ];
    const decision = decideDedupe(
      { problem: 'unrelated topic', guidance: 'totally different advice', embedding: vec(BASE) },
      existing,
    );
    expect(decision.action).toBe('insert');
  });

  it('merges a topic match whose guidance overlaps heavily', () => {
    const existing: ExistingKnowledgeForDedupe[] = [
      {
        id: 'k1',
        guidance: 'Test your product with paid ads for fifty dollars before you commit to inventory.',
        embedding: vec(BASE),
      },
    ];
    const decision = decideDedupe(
      {
        problem: 'how do I validate a product idea',
        guidance: 'Test your product with paid ads for fifty dollars before committing to inventory.',
        embedding: vec(BASE, [0, 0.01, 0, 0]),
      },
      existing,
    );
    expect(decision).toMatchObject({ action: 'merge', matchId: 'k1' });
  });

  it('flags a conflict when the topic matches but guidance barely overlaps', () => {
    const existing: ExistingKnowledgeForDedupe[] = [
      {
        id: 'k1',
        guidance: 'Test your product with paid ads for fifty dollars before you commit to inventory.',
        embedding: vec(BASE),
      },
    ];
    const decision = decideDedupe(
      {
        problem: 'how do I validate a product idea',
        guidance: 'Never spend on ads before you see organic demand through pre-orders.',
        embedding: vec(BASE, [0, 0.01, 0, 0]),
      },
      existing,
    );
    expect(decision).toMatchObject({ action: 'conflict', matchId: 'k1' });
  });

  it('picks the closest of two topic matches, not the first one over the floor', () => {
    const existing: ExistingKnowledgeForDedupe[] = [
      { id: 'far', guidance: 'Test with paid ads before committing to inventory.', embedding: vec(BASE, [0, 0.02, 0, 0]) },
      { id: 'near', guidance: 'Test with paid ads before committing to inventory.', embedding: vec(BASE, [0, 0.001, 0, 0]) },
    ];
    const decision = decideDedupe(
      { problem: 'validate a product', guidance: 'Test with paid ads before committing to inventory.', embedding: vec(BASE) },
      existing,
    );
    expect(decision).toMatchObject({ action: 'merge', matchId: 'near' });
  });

  it('never merges below the topic threshold even with identical guidance text', () => {
    // Same guidance, but the topic vector itself is far off — a coincidental
    // phrase match on an unrelated concept must not merge.
    const existing: ExistingKnowledgeForDedupe[] = [{ id: 'k1', guidance: 'shared phrase here', embedding: vec([0, 0, 1, 0]) }];
    const sim = existing[0]!.embedding.reduce((s, x, i) => s + x * vec(BASE)[i]!, 0);
    expect(sim).toBeLessThan(TOPIC_MATCH_THRESHOLD);
    const decision = decideDedupe({ problem: 'x', guidance: 'shared phrase here', embedding: vec(BASE) }, existing);
    expect(decision.action).toBe('insert');
  });
});

describe('mergeSourceRefs', () => {
  it('appends new refs and dedupes against existing ones', () => {
    const result = mergeSourceRefs(JSON.stringify(['Video A']), ['Video B', 'Video A']);
    expect(JSON.parse(result)).toEqual(['Video A', 'Video B']);
  });

  it('handles malformed existing JSON by starting fresh', () => {
    const result = mergeSourceRefs('not json', ['Video A']);
    expect(JSON.parse(result)).toEqual(['Video A']);
  });
});
