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

/**
 * The creator's own assistant — the session behind both talking to it from
 * the dashboard and connecting it to an agent of their own. Deliberately
 * has no call_id: it is not a call, nothing is metered, and no `calls` row
 * is created for it (see mcp_assistant_sessions in schema.sql).
 *
 * expires_at NULL means a long-lived pasted key rather than a voice
 * session, and is the one field that distinguishes the two. Everything
 * downstream treats them identically on purpose — same creator scope, same
 * tool set — so there is exactly one code path to get right.
 */
export interface McpAssistantSession {
  token_hash: string;
  creator_id: string;
  label: string | null;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

/** What resolveToken() returns — tagged so mcp.ts can dispatch to the right tool set without guessing from field shape. */
export type ResolvedSession =
  | { kind: 'coach'; session: McpSession }
  | { kind: 'qualify'; session: McpQualSession }
  | { kind: 'assistant'; session: McpAssistantSession };

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

/**
 * Mints a credential for the creator's own assistant.
 *
 * ttlSeconds null makes it permanent — that is the pasted-into-your-own-
 * agent key, and it is genuinely more dangerous than the hour-long call
 * tokens above: it can edit everything and (via the assistant tool set)
 * send mail as the creator, for as long as it exists. It is stored only as
 * an HMAC, shown to the creator exactly once, and revocable individually;
 * the plaintext returned here is the only time it can ever be read.
 */
export async function mintAssistantToken(
  db: SqlDb,
  tokenSecret: string,
  params: { creatorId: string; ttlSeconds: number | null; label?: string | null },
): Promise<string> {
  const token = randomToken(32);
  await db
    .prepare(
      `INSERT INTO mcp_assistant_sessions (token_hash, creator_id, label, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      hmacHex(tokenSecret, token),
      params.creatorId,
      params.label ?? null,
      params.ttlSeconds === null ? null : now() + params.ttlSeconds,
      now(),
    );
  return token;
}

/** Revokes one assistant credential by its plaintext token — used when a voice session ends. */
export async function revokeAssistantToken(db: SqlDb, tokenSecret: string, token: string): Promise<void> {
  await db
    .prepare('UPDATE mcp_assistant_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(now(), hmacHex(tokenSecret, token));
}

/**
 * Revokes a durable key by its HASH rather than its plaintext — the
 * dashboard's "Revoke" button has only ever seen the hash (the plaintext
 * was shown once, at mint time, and was never stored anywhere including
 * here). token_hash is a keyed HMAC, not the secret itself, so returning
 * and accepting it back is safe: it cannot be reversed to the plaintext
 * or used on its own to authenticate. creatorId is required in the WHERE
 * clause as defense in depth — the dashboard route already scopes by
 * creator, but a revoke call must never be reachable across creators even
 * if that scoping were ever removed by mistake.
 */
export async function revokeAssistantTokenByHash(db: SqlDb, creatorId: string, tokenHash: string): Promise<boolean> {
  const res = await db
    .prepare('UPDATE mcp_assistant_sessions SET revoked_at = ? WHERE token_hash = ? AND creator_id = ? AND revoked_at IS NULL')
    .run(now(), tokenHash, creatorId);
  return res.changes > 0;
}

export interface AssistantKeySummary {
  token_hash: string;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/** Durable ("paste into your own agent") keys only — a short-lived voice session (expires_at set) never shows up here. */
export async function listAssistantKeys(db: SqlDb, creatorId: string): Promise<AssistantKeySummary[]> {
  return db
    .prepare(
      `SELECT token_hash, label, created_at, last_used_at, revoked_at
         FROM mcp_assistant_sessions
        WHERE creator_id = ? AND expires_at IS NULL
        ORDER BY created_at DESC`,
    )
    .all<AssistantKeySummary>(creatorId);
}

/** Tries mcp_sessions (coach calls), then mcp_qual_sessions (qualification calls), then mcp_assistant_sessions — the token spaces never overlap. */
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

  const assistant = await db
    .prepare('SELECT * FROM mcp_assistant_sessions WHERE token_hash = ?')
    .get<McpAssistantSession>(hash);
  if (assistant) {
    // expires_at NULL is a long-lived key and never times out; only an
    // explicit revoke stops it.
    if (assistant.revoked_at) return null;
    if (assistant.expires_at !== null && assistant.expires_at < now()) return null;
    // Recorded so a creator can see a key being used and recognise it — or
    // not, and revoke it. Best-effort: a failed bookkeeping write must never
    // deny an otherwise-valid credential.
    await db
      .prepare('UPDATE mcp_assistant_sessions SET last_used_at = ? WHERE token_hash = ?')
      .run(now(), hash)
      .catch(() => {});
    return { kind: 'assistant', session: assistant };
  }

  return null;
}

export async function revokeCallTokens(db: SqlDb, callId: string): Promise<void> {
  await db.prepare('UPDATE mcp_sessions SET revoked_at = ? WHERE call_id = ? AND revoked_at IS NULL').run(now(), callId);
  await db
    .prepare('UPDATE mcp_qual_sessions SET revoked_at = ? WHERE call_id = ? AND revoked_at IS NULL')
    .run(now(), callId);
}
