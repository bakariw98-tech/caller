import { describe, expect, it } from 'vitest';
import { ctaPhrase } from '../workers/leadgen/call-prompt.js';

describe('ctaPhrase', () => {
  it('gives distinct phrasing for each known tier', () => {
    const tiers = ['low_ticket', 'course', 'high_ticket_application', 'very_high_ticket'];
    const phrases = tiers.map((t) => ctaPhrase(t));
    expect(new Set(phrases).size).toBe(tiers.length);
    for (const p of phrases) expect(p.length).toBeGreaterThan(0);
  });

  it('falls back to the course phrasing for an unrecognised tier', () => {
    expect(ctaPhrase('made_up_tier')).toBe(ctaPhrase('course'));
  });

  it('falls back to the course phrasing when null or undefined', () => {
    expect(ctaPhrase(null)).toBe(ctaPhrase('course'));
    expect(ctaPhrase(undefined)).toBe(ctaPhrase('course'));
  });

  it('never returns an empty string', () => {
    for (const t of ['low_ticket', 'course', 'high_ticket_application', 'very_high_ticket', 'nonsense', null, undefined]) {
      expect(ctaPhrase(t as string).trim().length).toBeGreaterThan(0);
    }
  });
});
