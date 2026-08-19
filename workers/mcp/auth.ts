import type { SqlDb } from '../db/types.js';
import { hmacHex, now, randomToken } from '../../src/util/ids.js';

export interface McpSession {
  token_hash: string;
  call_id: string;
  creator_id: string;
  customer_id: string | null;
  enrollment_id: string | null;
  course_id: string;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
}

/**
 * A qualification call's session — mirrors McpSession minus the
 * course_id/enrollment_id/customer_id columns that don't apply. See
 * mcp_qual_sessions in schema.sql for why this is a separate table rather
 * than a widened mcp_sessions (SQLite can't relax that table's NOT NULL
 * course_id FK on a live table).
 *
 * `prospect_id` starts null at mint and is set by resolve_prospect the
 * moment a call_code matches — because this is read fresh from the DB on
 * every resolveToken() call (once per tool call), that write is how later
 * tool calls in the same conversation learn who they're speaking to,
 * mirroring how the coach's session-bound customer_id already works.
 */
export interface McpQualSession {
  token_hash: string;
  call_id: string;
  creator_id: string;
  prospect_id: string | null;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
}

/** What resolveToken() returns — tagged so mcp.ts can dispatch to the right tool set without guessing from field shape. */
export type ResolvedSession = { kind: 'coach'; session: McpSession } | { kind: 'qualify'; session: McpQualSession };

export async function mintCallToken(
  db: SqlDb,
  tokenSecret: string,
  tokenTtlSeconds: number,
  params: { callId: string; creatorId: string; customerId: string | null; enrollmentId: string | null; courseId: string },
): Promise<string> {
  const token = randomToken(32);
  await db
    .prepare(
      `INSERT INTO mcp_sessions
         (token_hash, call_id, creator_id, customer_id, enrollment_id, course_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      hmacHex(tokenSecret, token),
      params.callId,
      params.creatorId,
      params.customerId,
      params.enrollmentId,
      params.courseId,
      now() + tokenTtlSeconds,
      now(),
    );
  return token;
}

/** prospect_id is always null at mint — nobody has been identified yet at call start; resolve_prospect fills it in mid-call. */
export async function mintQualCallToken(
  db: SqlDb,
  tokenSecret: string,
  tokenTtlSeconds: number,
  params: { callId: string; creatorId: string },
): Promise<string> {
  const token = randomToken(32);
  await db
    .prepare(
      `INSERT INTO mcp_qual_sessions (token_hash, call_id, creator_id, prospect_id, expires_at, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    )
    .run(hmacHex(tokenSecret, token), params.callId, params.creatorId, now() + tokenTtlSeconds, now());
  return token;
}

/** Tries mcp_sessions (coach calls) then mcp_qual_sessions (qualification calls) — the two token spaces never overlap. */
export async function resolveToken(
  db: SqlDb,
  tokenSecret: string,
  bearer: string | undefined | null,
): Promise<ResolvedSession | null> {
  if (!bearer) return null;
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : bearer.trim();
  if (!token) return null;
  const hash = hmacHex(tokenSecret, token);

  const coach = await db.prepare('SELECT * FROM mcp_sessions WHERE token_hash = ?').get<McpSession>(hash);
  if (coach) {
    if (coach.revoked_at || coach.expires_at < now()) return null;
    return { kind: 'coach', session: coach };
  }

  const qual = await db.prepare('SELECT * FROM mcp_qual_sessions WHERE token_hash = ?').get<McpQualSession>(hash);
  if (qual) {
    if (qual.revoked_at || qual.expires_at < now()) return null;
    return { kind: 'qualify', session: qual };
  }

  return null;
}

export async function revokeCallTokens(db: SqlDb, callId: string): Promise<void> {
  await db.prepare('UPDATE mcp_sessions SET revoked_at = ? WHERE call_id = ? AND revoked_at IS NULL').run(now(), callId);
  await db
    .prepare('UPDATE mcp_qual_sessions SET revoked_at = ? WHERE call_id = ? AND revoked_at IS NULL')
    .run(now(), callId);
}
