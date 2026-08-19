import { Hono } from 'hono';
import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { verifyPassword } from '../auth/password.js';
import { mintSessionToken, revokeSessionToken } from '../auth/session.js';
import { setSessionCookie, clearSessionCookie, SESSION_COOKIE_NAME } from '../auth/require-creator.js';
import { getCookie } from 'hono/cookie';

export const loginRoute = new Hono<{ Bindings: Env }>();

/**
 * Replaces the old "the dashboard link itself carries a shared secret"
 * model with an actual login — see workers/auth/require-creator.ts's doc
 * comment for the security gap that closes (the old key wasn't scoped to
 * a creator at all; a session minted here is, by construction).
 *
 * No query params, no state carried in the URL at all — just an email and
 * a password, like any ordinary login. `next` is the one exception: an
 * optional post-login redirect target, so a creator following an expired-
 * session link to their dashboard lands back on the right page rather
 * than a bare login screen with no context.
 */
loginRoute.get('/login', (c) => {
  const next = c.req.query('next') ?? '';
  const err = c.req.query('err') ?? '';
  return c.html(renderLoginPage({ next, err }));
});

loginRoute.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const next = String(body.next ?? '');

  const fail = (message: string) =>
    c.redirect(`/login?err=${encodeURIComponent(message)}${next ? `&next=${encodeURIComponent(next)}` : ''}`);

  if (!email || !password) return fail('Enter your email and password.');

  const db = wrapD1(c.env.DB);
  const creator = await db
    .prepare('SELECT id, password_hash FROM creators WHERE login_email = ?')
    .get<{ id: string; password_hash: string | null }>(email);

  // Deliberately the SAME generic message whether the email doesn't exist
  // or the password is wrong — a distinguishing error here is exactly how
  // a login form leaks which emails are registered creators.
  if (!creator || !verifyPassword(password, creator.password_hash)) {
    return fail('Wrong email or password.');
  }

  const token = await mintSessionToken(db, c.env.SESSION_SECRET, creator.id);
  setSessionCookie(c, token);

  return c.redirect(next || `/dashboard/${creator.id}`);
});

loginRoute.post('/logout', async (c) => {
  const cookie = getCookie(c, SESSION_COOKIE_NAME);
  if (cookie) {
    const db = wrapD1(c.env.DB);
    await revokeSessionToken(db, c.env.SESSION_SECRET, cookie);
  }
  clearSessionCookie(c);
  return c.redirect('/login');
});

function renderLoginPage(params: { next: string; err: string }): string {
  return /* html */ `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Log in</title>
<style>
  * { box-sizing: border-box; }
  body { font: 16px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 22rem; margin: 5rem auto; padding: 0 1.5rem; color: #1a1a1c; }
  h1 { font-size: 1.3rem; margin: 0 0 1.2rem; }
  label { display: block; font-weight: 600; font-size: .85rem; margin: .8rem 0 .3rem; }
  input { width: 100%; padding: .6rem .7rem; font: inherit; font-size: 16px; border: 1px solid #d6d6da; border-radius: 8px; }
  button { width: 100%; margin-top: 1.1rem; font: inherit; font-weight: 600; padding: .65rem; border-radius: 8px; border: 1px solid #1a1a1c; background: #1a1a1c; color: #fff; cursor: pointer; }
  .err { color: #b3261e; font-size: .87rem; margin-top: .9rem; }
</style>
</head><body>
<h1>Log in</h1>
<form method="POST" action="/login">
  <input type="hidden" name="next" value="${escapeHtml(params.next)}">
  <label>Email</label>
  <input type="email" name="email" autocomplete="username" required autofocus>
  <label>Password</label>
  <input type="password" name="password" autocomplete="current-password" required>
  <button type="submit">Log in</button>
  ${params.err ? `<p class="err">${escapeHtml(params.err)}</p>` : ''}
</form>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
