import { describe, expect, it } from 'vitest';
import { ctaNextStep, describeOfferForFit } from '../workers/leadgen/call-prompt.js';
import type { FullOfferRow } from '../workers/leadgen/reply.js';

function offer(overrides: Partial<FullOfferRow> & { id: string; name: string }): FullOfferRow {
  return {
    who_for: null,
    covers: null,
    price_text: null,
    url: null,
    not_who_for: null,
    objections_and_responses: null,
    recommend_when: null,
    dont_recommend_when: null,
    cta_tier: 'course',
    ...overrides,
  };
}

describe('ctaNextStep', () => {
  it('gives a distinct next-step fact for each known tier', () => {
    const tiers = ['low_ticket', 'course', 'high_ticket_application', 'very_high_ticket'];
    const facts = tiers.map((t) => ctaNextStep(t));
    expect(new Set(facts).size).toBe(tiers.length);
    for (const f of facts) expect(f.length).toBeGreaterThan(0);
  });

  it('falls back to the course fact for an unrecognised tier', () => {
    expect(ctaNextStep('made_up_tier')).toBe(ctaNextStep('course'));
  });

  it('falls back to the course fact when null or undefined', () => {
    expect(ctaNextStep(null)).toBe(ctaNextStep('course'));
    expect(ctaNextStep(undefined)).toBe(ctaNextStep('course'));
  });

  it('never returns an empty string', () => {
    for (const t of ['low_ticket', 'course', 'high_ticket_application', 'very_high_ticket', 'nonsense', null, undefined]) {
      expect(ctaNextStep(t as string).trim().length).toBeGreaterThan(0);
    }
  });
});

/**
 * The actual bug this exists to catch: an earlier version presented
 * who_for/not_who_for/recommend_when/dont_recommend_when under literal
 * rule labels ("Right for:", "NOT right for:", "Recommend when:", "Do
 * NOT recommend when:") — a model reading rule-shaped labels reasons
 * like it's checking rules ("prospect doesn't match the label →
 * excluded") instead of judging whether the diagnosed problem is what
 * the offer actually solves. This locks in that the labels read as
 * evidence of a pattern, not eligibility rules, while still tracing
 * every word back to a real input field.
 */
describe('describeOfferForFit', () => {
  const full = offer({
    id: 'offer_1',
    name: 'Dropship Launch',
    who_for: 'people just starting out with no store yet',
    not_who_for: 'people already running a profitable store',
    recommend_when: 'someone has no store and no product picked yet',
    dont_recommend_when: 'someone is already generating consistent sales',
    covers: 'picking a product, setting up a store, first ads',
    price_text: '$499 one-time',
    objections_and_responses: '"Too expensive" — pays for itself with the first few sales.',
  });

  it('never uses the old rule-style labels', () => {
    const out = describeOfferForFit(full);
    expect(out).not.toMatch(/Right for:/);
    expect(out).not.toMatch(/NOT right for:/);
    expect(out).not.toMatch(/^\s*Recommend when:/m);
    expect(out).not.toMatch(/Do NOT recommend when:/);
  });

  it('still traces every fact back to its real field — nothing invented', () => {
    const out = describeOfferForFit(full);
    expect(out).toContain('people just starting out with no store yet');
    expect(out).toContain('people already running a profitable store');
    expect(out).toContain('someone has no store and no product picked yet');
    expect(out).toContain('someone is already generating consistent sales');
    expect(out).toContain('picking a product, setting up a store, first ads');
    expect(out).toContain('$499 one-time');
    expect(out).toContain('pays for itself with the first few sales');
  });

  it('reads as a pattern, not a checklist, when it presents the fit fields at all', () => {
    const out = describeOfferForFit(full);
    expect(out.toLowerCase()).toContain('pattern');
  });

  it('omits a field entirely when it is null, rather than inventing something', () => {
    const bare = offer({ id: 'offer_2', name: 'Bare Offer' });
    const out = describeOfferForFit(bare);
    expect(out).toContain('"Bare Offer"');
    expect(out).not.toContain('pattern');
    expect(out).not.toContain('Covers:');
    expect(out).not.toContain('Price:');
    expect(out).not.toContain('objections');
  });

  it('includes covers/price/objections as plain facts regardless of whether any pattern field is set', () => {
    const factsOnly = offer({ id: 'offer_3', name: 'Facts Only', covers: 'the basics', price_text: '$10' });
    const out = describeOfferForFit(factsOnly);
    expect(out).toContain('Covers: the basics');
    expect(out).toContain('Price: $10');
  });
});
