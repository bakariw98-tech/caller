import { describe, expect, it } from 'vitest';
import { filterDiscoveredOffers, findLiteralNameMatches } from '../workers/leadgen/offer-extract.js';
import type { KnowledgeRow } from '../workers/leadgen/reply.js';

function item(overrides: Partial<KnowledgeRow> & { id: string; problem: string; guidance: string }): KnowledgeRow {
  return {
    who_for: null,
    framework_terms_json: '[]',
    boundary: null,
    boundary_offer_id: null,
    ...overrides,
  };
}

describe('findLiteralNameMatches', () => {
  const rows = [
    item({ id: 'a', problem: 'How do I analyze competitors?', guidance: 'Use Sandcastles to pull their video data.' }),
    item({ id: 'b', problem: 'What tools help with hooks?', guidance: 'Nothing to do with that tool at all.' }),
  ];

  // The exact live bug this exists to fix: hybrid retrieval's keyword
  // signal has no stemming, so a "Sandcastle" query got zero keyword boost
  // on a passage that only ever said "Sandcastles" — pushing it out of the
  // ranked window entirely even though it plainly discusses the offer.
  it('matches the singular query against plural material (a substring match on its own)', () => {
    const matches = findLiteralNameMatches(rows, 'Sandcastle');
    expect(matches.map((r) => r.id)).toEqual(['a']);
  });

  // The direction substring matching alone does NOT cover — "Sandcastles"
  // is not a substring of "Sandcastle" — so this only passes because of
  // the explicit plural/singular variant, not incidentally.
  it('matches the plural query against material that only ever uses the singular', () => {
    const singularOnly = [item({ id: 'c', problem: 'x', guidance: 'Use the Sandcastle tool for research.' })];
    const matches = findLiteralNameMatches(singularOnly, 'Sandcastles');
    expect(matches.map((r) => r.id)).toEqual(['c']);
  });

  it('is case-insensitive', () => {
    expect(findLiteralNameMatches(rows, 'SANDCASTLE').map((r) => r.id)).toEqual(['a']);
  });

  it('returns nothing for a name genuinely absent from the material', () => {
    expect(findLiteralNameMatches(rows, 'Kong AI')).toEqual([]);
  });

  it('ignores a too-short name to avoid matching everything', () => {
    expect(findLiteralNameMatches(rows, 'to')).toEqual([]);
  });

  it('returns nothing for a blank name', () => {
    expect(findLiteralNameMatches(rows, '  ')).toEqual([]);
  });
});

describe('filterDiscoveredOffers', () => {
  // The exact live bug this exists to fix: the discovery model kept
  // listing "Co-work" as this creator's own offer no matter how the
  // prompt's exclusion instructions were worded — a non-reasoning model
  // applies prose exclusion rules unreliably. This is the deterministic
  // backstop, same discipline as every other honesty gate in this codebase.
  it('drops known third-party platforms and AI assistants regardless of case', () => {
    const out = filterDiscoveredOffers([
      { name: 'Co-work', source_indices: [1, 2] },
      { name: 'CLAUDE', source_indices: [3] },
      { name: 'youtube', source_indices: [4] },
      { name: 'Sandcastles', url: 'sandcastles.ai', source_indices: [1, 2, 3] },
    ]);
    expect(out).toEqual([{ name: 'Sandcastles', url: 'sandcastles.ai', mentions: 3 }]);
  });

  it('drops blank names', () => {
    expect(filterDiscoveredOffers([{ name: '  ', source_indices: [1] }])).toEqual([]);
  });

  it('handles an undefined offers list', () => {
    expect(filterDiscoveredOffers(undefined)).toEqual([]);
  });

  it('defaults url to null and mentions to the source_indices length', () => {
    const out = filterDiscoveredOffers([{ name: 'Real Offer', source_indices: [1, 2, 3, 4] }]);
    expect(out).toEqual([{ name: 'Real Offer', url: null, mentions: 4 }]);
  });
});
