import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from '../env.js';
import type { SqlDb } from '../db/types.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { resolveSessionCookie } from './session.js';

export const SESSION_COOKIE_NAME = 'coach_session';

/**
 * Found live, not locally: `c.req.param('id')` is NOT populated inside a
 * wildcard `.use('/api/*', ...)` middleware in this Hono version — only
 * inside the specific route handler that actually matched (`:id` params
 * from routes further down the chain aren't resolved yet when generic
 * middleware runs). Every `.use('/api/*', ...)` block that needs the
 * creator id — the whole point of the creator-scoped check — must pull it
 * from the raw path instead of trusting c.req.param() at that point.
 */
export function creatorIdFromPath(path: string): string | null {
  return /\/api\/creators\/([^/]+)/.exec(path)?.[1] ?? null;
}

/**
 * The actual decision — pulled out as a pure function (DB + strings in,
 * no Hono Context) so the property this whole login system exists for is
 * directly unit-testable: a session minted for creator A must be rejected
 * against creator B's id, even though the session itself is perfectly
 * valid. tests/require-creator.test.ts exercises this with the same
 * in-memory fake SqlDb tests/session.test.ts already uses.
 *
 * Two ways in, checked in this order:
 *   1. A valid session cookie whose creator_id matches THIS request's
 *      `:id` — the normal path, a creator looking at their own data. This
 *      is the fix over the old scheme: the old ADMIN_TOKEN had no concept
 *      of "whose" data a request was for at all.
 *   2. ADMIN_TOKEN, exactly as before — the operator support override,
 *      unscoped by design (that's the whole point of it), confirmed
 *      wanted on top of per-creator login rather than replacing it.
 */
export async function resolveCreatorAccess(
  db: SqlDb,
  params: { sessionSecret: string; adminToken: string | undefined; cookie: string | undefined; authHeader: string | undefined; queryKey: string | undefined },
  creatorId: string,
): Promise<'session' | 'admin' | null> {
  if (params.cookie) {
    const sessionCreatorId = await resolveSessionCookie(db, params.sessionSecret, params.cookie);
    if (sessionCreatorId && sessionCreatorId === creatorId) return 'session';
  }

  if (params.adminToken) {
    const header = params.authHeader?.replace(/^Bearer\s+/i, '');
    if (header === params.adminToken || params.queryKey === params.adminToken) return 'admin';
  }

  return null;
}

/**
 * The single check every creator-facing route (dashboard, leadgen API,
 * phone numbers, Gmail connect) now runs, replacing the bare ADMIN_TOKEN
 * comparison each of those files used to do inline. Thin Hono-Context
 * wrapper around resolveCreatorAccess() above — pulls the cookie/header/
 * query out of the real request and defers the actual decision to the
 * pure, tested function.
 *
 * Returns which path succeeded (a route may want to know, e.g. to hide
 * "change your password" from an admin-override session that isn't
 * really that creator) or null if neither did.
 */
export async function checkCreatorAccess(
  c: Context<{ Bindings: Env }>,
  creatorId: string,
): Promise<'session' | 'admin' | null> {
  const db = wrapD1(c.env.DB);
  return resolveCreatorAccess(
    db,
    {
      sessionSecret: c.env.SESSION_SECRET,
      adminToken: c.env.ADMIN_TOKEN,
      cookie: getCookie(c, SESSION_COOKIE_NAME),
      authHeader: c.req.header('Authorization'),
      queryKey: c.req.query('key'),
    },
    creatorId,
  );
}

/** Sets the session cookie after a successful login. HttpOnly: never readable from page JS — the whole point of a cookie over the old ?key=. */
export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
}
