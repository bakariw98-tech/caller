import { describe, expect, it } from 'vitest';
import { mintSessionToken, resolveSessionCookie, revokeSessionToken } from '../workers/auth/session.js';
import type { SqlDb } from '../workers/db/types.js';

/**
 * Minimal in-memory fake of the one table session.ts touches — enough to
 * exercise the real mint/resolve/revoke logic (including the HMAC hashing
 * and expiry math) without D1. Matches statements by substring since
 * session.ts's SQL is small and fixed.
 */
function fakeDb(): SqlDb {
  const rows: { token_hash: string; creator_id: string; expires_at: number; revoked_at: number | null; created_at: number }[] = [];
  return {
    prepare(sql: string) {
      return {
        async run(...params: unknown[]) {
          if (sql.startsWith('INSERT')) {
            const [token_hash, creator_id, expires_at, created_at] = params as [string, string, number, number];
            rows.push({ token_hash, creator_id, expires_at, revoked_at: null, created_at });
          } else if (sql.startsWith('UPDATE')) {
            const [revoked_at, token_hash] = params as [number, string];
            const row = rows.find((r) => r.token_hash === token_hash && r.revoked_at === null);
            if (row) row.revoked_at = revoked_at;
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

describe('mintSessionToken / resolveSessionCookie / revokeSessionToken', () => {
  it('a freshly minted token resolves to the creator it was minted for', async () => {
    const db = fakeDb();
    const token = await mintSessionToken(db, SECRET, 'creator_a');
    expect(await resolveSessionCookie(db, SECRET, token)).toBe('creator_a');
  });

  it('never stores the plaintext token — only its hash is queryable', async () => {
    const db = fakeDb();
    const token = await mintSessionToken(db, SECRET, 'creator_a');
    // Looking the raw token up directly (as if it were the stored key) must miss.
    expect(await resolveSessionCookie(db, 'wrong-secret', token)).toBeNull();
  });

  it('rejects a missing or empty cookie', async () => {
    const db = fakeDb();
    expect(await resolveSessionCookie(db, SECRET, undefined)).toBeNull();
    expect(await resolveSessionCookie(db, SECRET, null)).toBeNull();
    expect(await resolveSessionCookie(db, SECRET, '')).toBeNull();
  });

  it('rejects an unknown token', async () => {
    const db = fakeDb();
    await mintSessionToken(db, SECRET, 'creator_a');
    expect(await resolveSessionCookie(db, SECRET, 'some-token-nobody-minted')).toBeNull();
  });

  it('revoking a token makes it stop resolving immediately', async () => {
    const db = fakeDb();
    const token = await mintSessionToken(db, SECRET, 'creator_a');
    expect(await resolveSessionCookie(db, SECRET, token)).toBe('creator_a');
    await revokeSessionToken(db, SECRET, token);
    expect(await resolveSessionCookie(db, SECRET, token)).toBeNull();
  });

  it('two creators get independent, non-interfering sessions', async () => {
    const db = fakeDb();
    const tokenA = await mintSessionToken(db, SECRET, 'creator_a');
    const tokenB = await mintSessionToken(db, SECRET, 'creator_b');
    expect(await resolveSessionCookie(db, SECRET, tokenA)).toBe('creator_a');
    expect(await resolveSessionCookie(db, SECRET, tokenB)).toBe('creator_b');
    await revokeSessionToken(db, SECRET, tokenA);
    expect(await resolveSessionCookie(db, SECRET, tokenA)).toBeNull();
    expect(await resolveSessionCookie(db, SECRET, tokenB)).toBe('creator_b');
  });
});
