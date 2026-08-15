import type { DB } from '../db/index.js';
import { config } from '../config.js';
import { hmacHex, now, randomToken } from '../util/ids.js';

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
 * Mints the bearer token handed to xAI inside the session's tool definition.
 *
 * This is what makes the tool surface safe to expose to a model: no tool takes
 * a customer or creator identifier as an argument, so there is no argument for
 * the model to get wrong, be talked into changing, or use to reach another
 * caller's record. Scope arrives with the credential.
 */
export function mintCallToken(
  db: DB,
  params: {
    callId: string;
    creatorId: string;
    customerId: string | null;
    enrollmentId: string | null;
    courseId: string;
  },
): string {
  const token = randomToken(32);
  db.prepare(
    `INSERT INTO mcp_sessions
       (token_hash, call_id, creator_id, customer_id, enrollment_id, course_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hmacHex(config.mcp.tokenSecret, token),
    params.callId,
    params.creatorId,
    params.customerId,
    params.enrollmentId,
    params.courseId,
    now() + config.mcp.tokenTtlSeconds,
    now(),
  );
  return token;
}

export function resolveToken(db: DB, bearer: string | undefined): McpSession | null {
  if (!bearer) return null;
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : bearer.trim();
  if (!token) return null;

  const session = db
    .prepare('SELECT * FROM mcp_sessions WHERE token_hash = ?')
    .get(hmacHex(config.mcp.tokenSecret, token)) as McpSession | undefined;

  if (!session) return null;
  if (session.revoked_at) return null;
  if (session.expires_at < now()) return null;
  return session;
}

/** Called when a call ends, so a leaked token cannot outlive the conversation. */
export function revokeCallTokens(db: DB, callId: string): void {
  db.prepare('UPDATE mcp_sessions SET revoked_at = ? WHERE call_id = ? AND revoked_at IS NULL').run(
    now(),
    callId,
  );
}

/** Rebinds a token after an anonymous caller verifies mid-call. */
export function attachIdentity(
  db: DB,
  callId: string,
  params: { customerId: string; enrollmentId: string },
): void {
  db.prepare(
    'UPDATE mcp_sessions SET customer_id = ?, enrollment_id = ? WHERE call_id = ? AND revoked_at IS NULL',
  ).run(params.customerId, params.enrollmentId, callId);
}
