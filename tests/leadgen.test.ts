import { describe, expect, it } from 'vitest';
import { selectKnowledge, scoreProspect, buildEmailBody, type KnowledgeRow } from '../workers/leadgen/reply.js';
import { buildDiscoveryState, looksLikeOptOut, type ProspectContext } from '../workers/leadgen/prompt.js';

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

describe('buildEmailBody', () => {
  const LINK = 'https://example.test/r/offer_1.prospect_1.abcd';

  it('places the discovery question after the answer when not routing', () => {
    const out = buildEmailBody({
      body: 'Get the footage before you quote.',
      discoveryQuestion: 'How many of these are you turning around a week right now?',
    });
    expect(out).toBe('Get the footage before you quote.\n\nHow many of these are you turning around a week right now?');
    expect(out).not.toContain('http');
  });

  it('assembles help, then the specific pitch, then the link — never a bare append', () => {
    // The bug this replaced: the offer mention lived inside free-form body
    // text the model could shortchange, so a routed reply sometimes ended in
    // a URL with nothing persuasive around it.
    const out = buildEmailBody({
      body: 'The free material stops there.',
      offerName: 'The Retainer Playbook',
      offerPitch: 'Since you mentioned five one-off clients turning into repeat work, the Playbook covers the scope-fencing conversation you need next.',
      link: LINK,
    });
    expect(out).toContain('five one-off clients');
    // The link must be last, and must have real framing before it.
    expect(out.endsWith(LINK)).toBe(true);
    expect(out.slice(0, out.indexOf(LINK))).toContain('scope-fencing');
  });

  it('still frames the link when the model routes without writing a pitch', () => {
    const out = buildEmailBody({ body: 'Body text.', offerName: 'Offer', link: LINK });
    expect(out).toContain('Offer');
    expect(out.endsWith(LINK)).toBe(true);
    // Must not degrade to a naked URL with nothing explaining it.
    expect(out).not.toBe(`Body text.\n\n${LINK}`);
  });

  it('keeps the question with the help and the link last when the model emits both', () => {
    // The prompt says to drop the question when routing, but model output is
    // never silently discarded — this pins the fallback ordering.
    const out = buildEmailBody({
      body: 'Answer.',
      discoveryQuestion: 'Which of those is costing you most?',
      offerName: 'Offer',
      offerPitch: 'Given the volume you described, Offer handles it.',
      link: LINK,
    });
    expect(out.indexOf('costing you most')).toBeLessThan(out.indexOf('Given the volume'));
    expect(out.endsWith(LINK)).toBe(true);
  });

  it('does not leave double blank lines when the body already ends in newlines', () => {
    const out = buildEmailBody({ body: 'Body text.\n\n', discoveryQuestion: 'A question?' });
    expect(out).toBe('Body text.\n\nA question?');
  });

  it('returns the body untouched when there is nothing to append', () => {
    expect(buildEmailBody({ body: 'Just an answer.' })).toBe('Just an answer.');
  });
});

function ctx(over: Partial<ProspectContext> = {}): ProspectContext {
  return {
    name: null,
    situation: null,
    goal: null,
    tried: null,
    blocked_on: null,
    diagnosedProblem: null,
    knowledgeLevel: null,
    urgency: null,
    objections: [],
    priorExchanges: 0,
    askedAbout: null,
    askedDimensions: [],
    alreadyPitched: false,
    ...over,
  };
}

describe('buildDiscoveryState — the progression', () => {
  it('starts at QUESTION when nothing is known', () => {
    const d = buildDiscoveryState(ctx());
    expect(d.stage).toBe('question');
    expect(d.canAssessFit).toBe(false);
    expect(d.text).toContain('[MISSING]');
    expect(d.text).toContain('STATE: QUESTION');
  });

  it('moves to SITUATION once their context is known but the problem is not diagnosed', () => {
    const d = buildDiscoveryState(ctx({ situation: '3 months dropshipping, TikTok traffic' }));
    expect(d.stage).toBe('situation');
    expect(d.text).toContain('STATE: SITUATION');
    expect(d.canAssessFit).toBe(false);
  });

  it('moves to PROBLEM once the real bottleneck is diagnosed', () => {
    const d = buildDiscoveryState(ctx({
      situation: '3 months dropshipping',
      diagnosedProblem: 'traffic is fine, the product page is not converting',
    }));
    expect(d.stage).toBe('problem');
    expect(d.text).toContain('STATE: PROBLEM');
    // Still not enough — without knowing where they want to get to, any
    // recommendation is a guess about what they would value.
    expect(d.canAssessFit).toBe(false);
  });

  it('only earns the recommendation once situation, problem AND outcome are all known', () => {
    const d = buildDiscoveryState(ctx({
      situation: '3 months dropshipping',
      diagnosedProblem: 'product page not converting',
      goal: '$10k/month so they can quit their job',
    }));
    expect(d.stage).toBe('outcome');
    expect(d.canAssessFit).toBe(true);
    expect(d.text).toContain('NAME THE GAP AND RECOMMEND');
    // Framed as recognition, not a pitch — the distinction the whole design
    // rests on.
    expect(d.text).toContain('RECOGNITION');
  });

  it('does not treat a reported complaint as a diagnosed problem', () => {
    // blocked_on is what they said; diagnosed_problem is what was worked out.
    // Conflating them would let a recommendation fire off a vague grievance.
    const d = buildDiscoveryState(ctx({ situation: 'x', blocked_on: 'not getting sales', goal: 'more revenue' }));
    expect(d.canAssessFit).toBe(false);
    expect(d.stage).toBe('situation');
  });

  it('treats whitespace-only values as missing, not known', () => {
    expect(buildDiscoveryState(ctx({ situation: '   ' })).known).toEqual([]);
  });

  it('never presents reservations as something to ask about', () => {
    const d = buildDiscoveryState(ctx({ situation: 'x', goal: 'y', tried: 'z', blocked_on: 'w' }));
    expect(d.text).toContain('[not yet raised]');
    expect(d.text).toContain('never ask about this directly');
  });

  it('frames itself as prior state and tells the model to absorb the new message', () => {
    const d = buildDiscoveryState(ctx({ situation: 'runs an agency' }));
    expect(d.text).toContain('BEFORE OPENING THIS EMAIL');
    expect(d.text).toContain('that gap is FILLED');
  });

  it('says nothing about prior questions on a first contact', () => {
    expect(buildDiscoveryState(ctx()).text).not.toContain('ALREADY ASKED');
  });
});

describe('buildDiscoveryState — not pitching twice', () => {
  it('tells the model to stop pitching once an offer has been recommended', () => {
    // Observed live: the same offer pitched on two consecutive emails, the
    // second one repeating the situation summary the body had just given.
    const d = buildDiscoveryState(ctx({ alreadyPitched: true }));
    expect(d.text).toContain('ALREADY RECOMMENDED AN OFFER');
    expect(d.text).toContain('Do not pitch again unless they ask');
  });

  it('says nothing about prior pitches when none has happened', () => {
    expect(buildDiscoveryState(ctx()).text).not.toContain('ALREADY RECOMMENDED');
  });
});

describe('buildDiscoveryState — never re-asking', () => {
  it('removes every previously asked dimension from the askable list', () => {
    // The live failure: the same question in five consecutive replies. The
    // old guard only remembered the single previous turn.
    const d = buildDiscoveryState(ctx({ askedDimensions: ['situation', 'goal'] }));
    expect(d.text).toContain('ALREADY ASKED, NEVER ASK AGAIN: situation, goal');
    const gaps = /Gaps worth asking about: ([^.]+)\./.exec(d.text)?.[1] ?? '';
    expect(gaps).not.toContain('situation');
    expect(gaps).not.toContain('goal');
    expect(gaps).toContain('diagnosed_problem');
  });

  it('tells the model to ask nothing when every gap is spent', () => {
    const d = buildDiscoveryState(ctx({
      askedDimensions: ['situation', 'diagnosed_problem', 'goal', 'knowledge_level', 'urgency', 'tried', 'blocked_on'],
    }));
    expect(d.text).toContain('no unasked gaps left');
    expect(d.text).toContain('Do not ask anything this email');
  });

  it('still allows a question when some gaps remain unasked', () => {
    const d = buildDiscoveryState(ctx({ askedDimensions: ['situation'] }));
    expect(d.text).not.toContain('no unasked gaps left');
  });
});
