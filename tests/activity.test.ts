import { describe, expect, it } from 'vitest';
import { computeDelta, tallyTopics, fillDaily } from '../workers/leadgen/activity.js';

describe('computeDelta', () => {
  it('computes a normal signed percentage', () => {
    expect(computeDelta(120, 100)).toEqual({ pct: 20, dir: 'up' });
    expect(computeDelta(80, 100)).toEqual({ pct: -20, dir: 'down' });
    expect(computeDelta(100, 100)).toEqual({ pct: 0, dir: 'flat' });
  });

  it('treats a zero prior period as "new" rather than dividing by zero', () => {
    expect(computeDelta(5, 0)).toEqual({ pct: null, dir: 'up' });
    expect(computeDelta(0, 0)).toEqual({ pct: null, dir: 'flat' });
  });
});

describe('tallyTopics', () => {
  it('counts real topic mentions, case-insensitively, using the first-seen casing for display', () => {
    const out = tallyTopics([
      { topics_json: '["Facebook ads", "facebook ads"]' },
      { topics_json: '["Product research"]' },
    ]);
    const fb = out.find((t) => t.name.toLowerCase() === 'facebook ads');
    expect(fb).toBeDefined();
    expect(fb!.count).toBe(2);
    expect(fb!.name).toBe('Facebook ads');
  });

  it('never invents a topic that was not present in the data', () => {
    const out = tallyTopics([{ topics_json: '["Scaling"]' }]);
    expect(out).toEqual([{ name: 'Scaling', count: 1, pct: 100 }]);
  });

  it('folds everything past the top 5 into "Everything else"', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((t) => ({ topics_json: JSON.stringify([t]) }));
    const out = tallyTopics(rows);
    expect(out).toHaveLength(6);
    expect(out[5]).toEqual({ name: 'Everything else', count: 2, pct: Math.round((2 / 7) * 100) });
  });

  it('tolerates malformed JSON, blank strings, and non-string entries without throwing', () => {
    const out = tallyTopics([
      { topics_json: 'not json' },
      { topics_json: '["", "  ", 5, null]' },
      { topics_json: '[]' },
    ]);
    expect(out).toEqual([]);
  });

  it('returns an empty list rather than a fabricated distribution when nobody has any topics', () => {
    expect(tallyTopics([])).toEqual([]);
  });
});

describe('fillDaily', () => {
  const DAY = 86_400;

  it('produces exactly N days ending today, oldest first', () => {
    const nowSeconds = Math.floor(new Date('2026-08-20T12:00:00Z').getTime() / 1000);
    const { keys } = fillDaily([], 30, nowSeconds);
    expect(keys).toHaveLength(30);
    expect(keys[0]).toBe('2026-07-22');
    expect(keys[29]).toBe('2026-08-20');
  });

  it('fills days with no matching row as 0', () => {
    const nowSeconds = Math.floor(new Date('2026-08-20T00:00:00Z').getTime() / 1000);
    const { keys, values } = fillDaily([{ day: '2026-08-20', n: 4 }], 3, nowSeconds);
    expect(keys).toEqual(['2026-08-18', '2026-08-19', '2026-08-20']);
    expect(values).toEqual([0, 0, 4]);
  });

  it('never returns a value for a day that was not actually queried', () => {
    const nowSeconds = Math.floor(new Date('2026-08-20T00:00:00Z').getTime() / 1000);
    const { keys, values } = fillDaily([{ day: '2020-01-01', n: 99 }], 2, nowSeconds);
    expect(keys).toEqual(['2026-08-19', '2026-08-20']);
    expect(values).toEqual([0, 0]);
  });

  it('lines up with a UTC day boundary matching SQLite date(x, "unixepoch")', () => {
    // 23:59:59 UTC on the 19th must NOT roll into the 20th.
    const nowSeconds = Math.floor(new Date('2026-08-19T23:59:59Z').getTime() / 1000);
    const { keys } = fillDaily([], 1, nowSeconds);
    expect(keys).toEqual(['2026-08-19']);
  });
});
