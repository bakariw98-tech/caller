import { describe, expect, it } from 'vitest';
import { ctaNextStep } from '../workers/leadgen/call-prompt.js';

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
