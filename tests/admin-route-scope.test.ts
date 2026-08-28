import { describe, expect, it } from 'vitest';
import { ADMIN_ROUTE_PATTERNS } from '../workers/routes/admin.js';

/**
 * The real bug found live: admin.ts's middleware used to be a blanket
 * '/api/*', which — because every route file is mounted at the same base
 * path in workers/app.ts — matched EVERY '/api/*' request in the whole
 * app, not just admin.ts's own routes. Since admin.ts is registered
 * first and its check was admin-token-only, it silently rejected valid
 * creator-session requests meant for leadgen.ts/phone-numbers.ts before
 * those files' own, more permissive checks ever ran. This locks in that
 * the exact-path list stays exact: admin.ts's own routes match, nothing
 * from other files does.
 */
describe('ADMIN_ROUTE_PATTERNS', () => {
  const matches = (path: string) => ADMIN_ROUTE_PATTERNS.some((re) => re.test(path));

  it('matches every one of admin.ts\'s own real routes', () => {
    expect(matches('/api/creators')).toBe(true);
    expect(matches('/api/creators/creator_abc/curriculum')).toBe(true);
    expect(matches('/api/creators/creator_abc/curriculum/structure')).toBe(true);
    expect(matches('/api/curriculum/audit')).toBe(true);
    expect(matches('/api/creators/creator_abc/promotional-budget')).toBe(true);
    expect(matches('/api/creators/creator_abc/publish')).toBe(true);
    expect(matches('/api/creators/creator_abc/agent-setup')).toBe(true);
  });

  it('does NOT match creator-facing routes owned by other files — the exact leak this existed to close', () => {
    expect(matches('/api/creators/creator_abc/overview')).toBe(false);
    expect(matches('/api/creators/creator_abc/knowledge')).toBe(false);
    expect(matches('/api/creators/creator_abc/offers')).toBe(false);
    expect(matches('/api/creators/creator_abc/login')).toBe(false);
    expect(matches('/api/creators/creator_abc/prospects.csv')).toBe(false);
    expect(matches('/api/creators/creator_abc/phone-number/manual')).toBe(false);
    expect(matches('/api/creators/creator_abc/email/connect')).toBe(false);
    expect(matches('/api/creators/creator_abc/mcp-keys')).toBe(false);
  });

  it('does not accidentally match a path that only starts with a real prefix', () => {
    expect(matches('/api/creators/creator_abc/curriculum/extra')).toBe(false);
    expect(matches('/api/creators-not-real')).toBe(false);
  });
});
