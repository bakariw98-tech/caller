import { describe, expect, it } from 'vitest';
import { tierVideo } from '../workers/youtube/tier.js';

describe('tierVideo', () => {
  it('skips a Short regardless of title', () => {
    expect(tierVideo({ title: 'How To Fix Your Starter', lengthSeconds: 45 }).tier).toBe(3);
  });

  it('skips a vlog', () => {
    expect(tierVideo({ title: 'A day in the life of a dropshipper', lengthSeconds: 600 }).tier).toBe(3);
  });

  it('skips an announcement', () => {
    expect(tierVideo({ title: 'Big Channel Announcement!!', lengthSeconds: 300 }).tier).toBe(3);
  });

  it('skips a Q&A', () => {
    expect(tierVideo({ title: 'Answering Your Questions - Q&A', lengthSeconds: 900 }).tier).toBe(3);
  });

  it('skips a livestream replay', () => {
    expect(tierVideo({ title: 'LIVE: Product Research (Livestream)', lengthSeconds: 3600 }).tier).toBe(3);
  });

  it('skips a reaction video', () => {
    expect(tierVideo({ title: 'Reacting to my first dropshipping store', lengthSeconds: 720 }).tier).toBe(3);
  });

  it('tiers a how-to tutorial as tier 1', () => {
    const r = tierVideo({ title: 'How To Find Winning Products in 2025', lengthSeconds: 720 });
    expect(r.tier).toBe(1);
    expect(r.reason).toBe('how-to');
  });

  it('tiers a numbered mistakes list as tier 1', () => {
    expect(tierVideo({ title: '5 Mistakes Killing Your Ad Spend', lengthSeconds: 480 }).tier).toBe(1);
  });

  it('tiers a named framework as tier 1', () => {
    expect(tierVideo({ title: 'The Validation Framework I Use For Every Product', lengthSeconds: 600 }).tier).toBe(1);
  });

  it('tiers a step-by-step guide as tier 1', () => {
    expect(tierVideo({ title: 'Step-by-Step Guide to Facebook Ads', lengthSeconds: 900 }).tier).toBe(1);
  });

  it('falls back to tier 2 for ordinary content of reasonable length', () => {
    const r = tierVideo({ title: 'My Product Sold $10k in a Week', lengthSeconds: 500 });
    expect(r.tier).toBe(2);
    expect(r.reason).toBe('general');
  });

  it('treats a null length as eligible rather than penalized', () => {
    expect(tierVideo({ title: 'Scaling to $50k/month', lengthSeconds: null }).tier).toBe(2);
  });

  it('checks length before title patterns — a short clip stays a Short even with a how-to title', () => {
    const r = tierVideo({ title: 'How To Do This In 30 Seconds', lengthSeconds: 30 });
    expect(r.tier).toBe(3);
    expect(r.reason).toBe('short');
  });
});
