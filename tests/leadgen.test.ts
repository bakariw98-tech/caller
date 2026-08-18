import { describe, expect, it } from 'vitest';
import { selectKnowledge, scoreProspect, buildRoutedBody, type KnowledgeRow } from '../workers/leadgen/reply.js';

function item(overrides: Partial<KnowledgeRow> & { id: string; problem: string }): KnowledgeRow {
  return {
    who_for: null,
    guidance: '',
    framework_terms_json: '[]',
    boundary: null,
    boundary_offer_id: null,
    ...overrides,
  };
}

const CORPUS: KnowledgeRow[] = [
  item({
    id: 'k_starter',
    problem: 'My sourdough starter is not rising after feeding',
    guidance: 'Check ambient temperature and feed ratio. A sluggish starter is almost always cold.',
    framework_terms_json: '["peak window"]',
  }),
  item({
    id: 'k_crumb',
    problem: 'The crumb comes out dense and gummy',
    guidance: 'Underbaked loaves stay gummy. Pull at internal temperature, not by clock.',
  }),
  item({
    id: 'k_pricing',
    problem: 'How should I price bread at a farmers market',
    guidance: 'Cost your ingredients per loaf, then multiply. Undercharging is the usual mistake.',
    boundary: 'The free material does not cover wholesale contracts or scaling past one oven.',
    boundary_offer_id: 'offer_pro',
  }),
];

describe('selectKnowledge', () => {
  it('ranks the item whose problem matches the question', () => {
    const hits = selectKnowledge(CORPUS, 'my starter will not rise, what do I do');
    expect(hits[0]?.id).toBe('k_starter');
  });

  it('returns nothing when no term overlaps, rather than a nearest guess', () => {
    // The grounding property: an unrelated question must not surface an
    // unrelated item, because the reply would present it as the creator's
    // documented answer. Same bug that was fixed in matchProblems().
    expect(selectKnowledge(CORPUS, 'what is the weather in Reykjavik')).toEqual([]);
  });

  it('weights a problem-field match above a guidance-body match', () => {
    // "gummy" appears in k_crumb's problem; "mistake" only in k_pricing's body.
    const hits = selectKnowledge(CORPUS, 'gummy mistake');
    expect(hits[0]?.id).toBe('k_crumb');
  });

  it('ignores stopwords so a question made only of them matches nothing', () => {
    expect(selectKnowledge(CORPUS, 'what should I do about this')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(selectKnowledge(CORPUS, 'starter crumb price bread loaf', 2)).toHaveLength(2);
  });

  it('handles an empty corpus', () => {
    expect(selectKnowledge([], 'starter not rising')).toEqual([]);
  });
});

describe('scoreProspect', () => {
  const base = { exchanges: 1, hit_boundary: 0, clicked_offer: 0, situation: null, blocked_on: null };

  it('scores a one-off question low', () => {
    expect(scoreProspect(base)).toBe(8);
  });

  it('ranks someone who hit the boundary above someone who just talked a lot', () => {
    const chatty = scoreProspect({ ...base, exchanges: 5 });
    const boundary = scoreProspect({ ...base, exchanges: 2, hit_boundary: 1 });
    expect(boundary).toBeGreaterThan(chatty);
  });

  it('ranks a click above every stated signal', () => {
    const stated = scoreProspect({ ...base, situation: 'x', blocked_on: 'y' });
    const clicked = scoreProspect({ ...base, clicked_offer: 1 });
    expect(clicked).toBeGreaterThan(stated);
  });

  it('accepts booleans and D1 integers identically', () => {
    expect(scoreProspect({ ...base, hit_boundary: true, clicked_offer: true })).toBe(
      scoreProspect({ ...base, hit_boundary: 1, clicked_offer: 1 }),
    );
  });

  it('caps exchange credit so volume alone cannot max the score', () => {
    expect(scoreProspect({ ...base, exchanges: 50 })).toBe(scoreProspect({ ...base, exchanges: 5 }));
  });

  it('caps at 100', () => {
    expect(
      scoreProspect({ exchanges: 5, hit_boundary: 1, clicked_offer: 1, situation: 'x', blocked_on: 'y' }),
    ).toBe(100);
  });
});

describe('buildRoutedBody', () => {
  const LINK = 'https://example.test/r/offer_1.prospect_1.abcd';

  it('assembles help, then the specific pitch, then the link — never a bare append', () => {
    // The bug this replaced: the offer mention lived inside free-form body
    // text the model could shortchange, so a routed reply sometimes ended in
    // a URL with nothing persuasive around it. offer_pitch is now a separate
    // required-when-routing field, guaranteeing a real bridge sentence exists.
    const out = buildRoutedBody(
      'The free material stops there.',
      'The Retainer Playbook',
      'Since you mentioned five one-off clients turning into repeat work, the Playbook covers exactly the scope-fencing conversation you need next.',
      LINK,
    );
    expect(out).toContain('five one-off clients');
    expect(out).toContain(LINK);
    // The link must not be the very next thing after the help text with
    // nothing between — that reads as a bare drop, which is the complaint
    // this function exists to fix.
    const linkIndex = out.indexOf(LINK);
    expect(out.slice(0, linkIndex)).toContain('scope-fencing');
  });

  it('still includes a real sentence, not a naked link, when the model routes without writing a pitch', () => {
    const out = buildRoutedBody('Body text.', 'Offer', undefined, LINK);
    expect(out).toContain(LINK);
    expect(out).toContain('Offer');
    // Must not degrade to "Offer: <link>" with no framing at all.
    expect(out).not.toMatch(/^Body text\.\n\nOffer: /);
  });

  it('does not double-space when the body already ends in a newline', () => {
    const out = buildRoutedBody('Body text.\n\n', 'Offer', 'A real pitch sentence.', LINK);
    expect(out).toBe(`Body text.\n\nA real pitch sentence.\n\n${LINK}`);
  });
});
