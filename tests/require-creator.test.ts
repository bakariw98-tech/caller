import { describe, expect, it } from 'vitest';
import { mintSessionToken } from '../workers/auth/session.js';
import { resolveCreatorAccess } from '../workers/auth/require-creator.js';
import type { SqlDb } from '../workers/db/types.js';

/** Same fake used by tests/session.test.ts — see that file's comment. */
function fakeDb(): SqlDb {
  const rows: { token_hash: string; creator_id: string; expires_at: number; revoked_at: number | null; created_at: number }[] = [];
  return {
    prepare(sql: string) {
      return {
        async run(...params: unknown[]) {
          if (sql.startsWith('INSERT')) {
            const [token_hash, creator_id, expires_at, created_at] = params as [string, string, number, number];
            rows.push({ token_hash, creator_id, expires_at, revoked_at: null, created_at });
          }
          return { changes: 1, lastInsertRowid: null };
        },
        async get<T>(...params: unknown[]) {
          const [token_hash] = params as [string];
          return rows.find((r) => r.token_hash === token_hash) as T | undefined;
        },
        async all<T>() {
          return rows as T[];
        },
      };
    },
  };
}

const SECRET = 'test-session-secret';
const ADMIN = 'test-admin-token';

/**
 * This is the actual security property the whole login system exists for
 * (see require-creator.ts's own doc comment): the old ADMIN_TOKEN scheme
 * had no concept of "whose" data a request was for — one key opened every
 * creator's dashboard. A login session must not repeat that mistake.
 */
describe('resolveCreatorAccess', () => {
  it("a valid session for creator A grants access to creator A's own path", async () => {
    const db = fakeDb();
    const token = await mintSessionToken(db, SECRET, 'creator_a');
    const result = await resolveCreatorAccess(
      db,
      { sessionSecret: SECRET, adminToken: ADMIN, cookie: token, authHeader: undefined, queryKey: undefined },
      'creator_a',
    );
    expect(result).toBe('session');
  });

  it("a valid session for creator A is REJECTED against creator B's path — the core fix this feature exists for", async () => {
    const db = fakeDb();
    const token = await mintSessionToken(db, SECRET, 'creator_a');
    const result = await resolveCreatorAccess(
      db,
      { sessionSecret: SECRET, adminToken: ADMIN, cookie: token, authHeader: undefined, queryKey: undefined },
      'creator_b',
    );
    expect(result).toBeNull();
  });

  it('the admin token still works as an unscoped override, on top of per-creator sessions', async () => {
    const db = fakeDb();
    const byHeader = await resolveCreatorAccess(
      db,
      { sessionSecret: SECRET, adminToken: ADMIN, cookie: undefined, authHeader: `Bearer ${ADMIN}`, queryKey: undefined },
      'any_creator_at_all',
    );
    const byQuery = await resolveCreatorAccess(
      db,
      { sessionSecret: SECRET, adminToken: ADMIN, cookie: undefined, authHeader: undefined, queryKey: ADMIN },
      'any_creator_at_all',
    );
    expect(byHeader).toBe('admin');
    expect(byQuery).toBe('admin');
  });

  it('a wrong admin token and no session is rejected', async () => {
    const db = fakeDb();
    const result = await resolveCreatorAccess(
      db,
      { sessionSecret: SECRET, adminToken: ADMIN, cookie: undefined, authHeader: 'Bearer not-the-real-token', queryKey: undefined },
      'creator_a',
    );
    expect(result).toBeNull();
  });

  it('an unset ADMIN_TOKEN never accidentally matches an empty/undefined header', async () => {
    const db = fakeDb();
    const result = await resolveCreatorAccess(
      db,
      { sessionSecret: SECRET, adminToken: undefined, cookie: undefined, authHeader: undefined, queryKey: undefined },
      'creator_a',
    );
    expect(result).toBeNull();
  });

  it('a session takes precedence and is checked before falling back to the admin token', async () => {
    const db = fakeDb();
    const token = await mintSessionToken(db, SECRET, 'creator_a');
    // Both a valid session for creator_a AND a valid admin token are present —
    // either alone would grant access; confirms the session path is tried first.
    const result = await resolveCreatorAccess(
      db,
      { sessionSecret: SECRET, adminToken: ADMIN, cookie: token, authHeader: `Bearer ${ADMIN}`, queryKey: undefined },
      'creator_a',
    );
    expect(result).toBe('session');
  });
});

/**
 * Found live, not locally: `c.req.param('id')` returns nothing inside a
 * wildcard `.use('/api/*', ...)` middleware in this Hono version — only
 * the specific matched route handler gets it. That silently broke the
 * session-cookie path for every creator-facing API route (the admin-
 * token path kept working, since it never needed the id, which is
 * exactly why this wasn't obvious from a 401 alone). Locks in the path-
 * based extraction that replaced it.
 */
describe('creatorIdFromPath', () => {
  it('extracts the id from a real creator API path', async () => {
    const { creatorIdFromPath } = await import('../workers/auth/require-creator.js');
    expect(creatorIdFromPath('/api/creators/creator_abc123/overview')).toBe('creator_abc123');
    expect(creatorIdFromPath('/api/creators/creator_abc123/knowledge/item_xyz')).toBe('creator_abc123');
  });

  it('returns null for a path with no creator id', async () => {
    const { creatorIdFromPath } = await import('../workers/auth/require-creator.js');
    expect(creatorIdFromPath('/api/leadgen/simulate')).toBeNull();
    expect(creatorIdFromPath('/health')).toBeNull();
  });
});
