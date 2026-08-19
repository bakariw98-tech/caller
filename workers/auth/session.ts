import type { SqlDb } from '../db/types.js';
import { hmacHex, now, randomToken } from '../../src/util/ids.js';

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — a human login, not a machine credential; re-login after this, no rolling refresh in v1.

/**
 * A creator's own login session — the fourth appearance of the "mint a
 * random token, store only its keyed HMAC, resolve by re-hashing" pattern
 * workers/mcp/auth.ts already uses three times for machine credentials.
 * This one backs an actual browser session cookie for a human.
 *
 * Hashed with SESSION_SECRET, not MCP_TOKEN_SECRET — a bug that forges a
 * login session should not also forge a live call's MCP token, and vice
 * versa. Two credential families, two secrets.
 */
export interface CreatorSession {
  token_hash: string;
  creator_id: string;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
}

export async function mintSessionToken(db: SqlDb, sessionSecret: string, creatorId: string): Promise<string> {
  const token = randomToken(32);
  await db
    .prepare('INSERT INTO creator_sessions (token_hash, creator_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hmacHex(sessionSecret, token), creatorId, now() + SESSION_TTL_SECONDS, now());
  return token;
}

/** Returns the creator_id the cookie resolves to, or null if it's missing, unknown, revoked, or expired. */
export async function resolveSessionCookie(
  db: SqlDb,
  sessionSecret: string,
  cookieValue: string | undefined | null,
): Promise<string | null> {
  if (!cookieValue) return null;
  const session = await db
    .prepare('SELECT * FROM creator_sessions WHERE token_hash = ?')
    .get<CreatorSession>(hmacHex(sessionSecret, cookieValue));
  if (!session || session.revoked_at || session.expires_at < now()) return null;
  return session.creator_id;
}

export async function revokeSessionToken(db: SqlDb, sessionSecret: string, cookieValue: string): Promise<void> {
  await db
    .prepare('UPDATE creator_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(now(), hmacHex(sessionSecret, cookieValue));
}
