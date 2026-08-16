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

export async function resolveToken(db: SqlDb, tokenSecret: string, bearer: string | undefined | null): Promise<McpSession | null> {
  if (!bearer) return null;
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : bearer.trim();
  if (!token) return null;

  const session = await db
    .prepare('SELECT * FROM mcp_sessions WHERE token_hash = ?')
    .get<McpSession>(hmacHex(tokenSecret, token));

  if (!session) return null;
  if (session.revoked_at) return null;
  if (session.expires_at < now()) return null;
  return session;
}

export async function revokeCallTokens(db: SqlDb, callId: string): Promise<void> {
  await db
    .prepare('UPDATE mcp_sessions SET revoked_at = ? WHERE call_id = ? AND revoked_at IS NULL')
    .run(now(), callId);
}
