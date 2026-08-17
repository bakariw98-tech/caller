import { Hono } from 'hono';
import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { id, now, hmacHex, safeEqual } from '../../src/util/ids.js';
import { buildConsentUrl, exchangeCode, getAccessToken, getProfile } from '../email/gmail.js';
import { pollAllConnections } from '../email/poll.js';

export const emailConnectRoute = new Hono<{ Bindings: Env }>();

const REDIRECT_PATH = '/oauth/gmail/callback';

function stateFor(secret: string, creatorId: string): string {
  return `${creatorId}.${hmacHex(secret, `gmail-connect:${creatorId}`).slice(0, 16)}`;
}

/**
 * Starts a creator's Gmail connection.
 *
 * Admin-gated like the rest of the onboarding API — this only *builds* the
 * consent URL, it does not complete anything itself, because nobody but the
 * creator's own browser can click "Allow" on Google's screen. `state` is
 * signed so the callback below can't be walked in with a forged creator id
 * to attach someone else's Gmail account to another creator's connection.
 */
emailConnectRoute.get('/api/creators/:id/email/connect', async (c) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token) return c.json({ error: 'ADMIN_TOKEN is not configured' }, 503);
  const header = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  if (header !== token && c.req.query('key') !== token) return c.json({ error: 'unauthorized' }, 401);

  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const creator = await db.prepare('SELECT id FROM creators WHERE id = ?').get<{ id: string }>(creatorId);
  if (!creator) return c.json({ error: 'creator not found' }, 404);

  if (!c.env.GOOGLE_OAUTH_CLIENT_ID || !c.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return c.json({ error: 'Google OAuth is not configured on this deployment yet' }, 503);
  }

  const url = buildConsentUrl(
    {
      clientId: c.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: c.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: `${c.env.PUBLIC_BASE_URL}${REDIRECT_PATH}`,
    },
    stateFor(c.env.MCP_TOKEN_SECRET, creatorId),
  );
  return c.json({ url });
});

/**
 * Where Google redirects after the creator clicks Allow.
 *
 * Not admin-gated — Google calls this directly with no Authorization header,
 * only `code` and the `state` this app minted a moment earlier. The state
 * signature is what stands in for auth here.
 */
emailConnectRoute.get(REDIRECT_PATH, async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state') ?? '';
  const error = c.req.query('error');
  if (error) return c.html(page(`Google reported an error: ${error}. You can close this tab and try again.`), 400);
  if (!code) return c.html(page('Missing authorization code.'), 400);

  const [creatorId, sig] = state.split('.');
  const expected = creatorId ? stateFor(c.env.MCP_TOKEN_SECRET, creatorId).split('.')[1] : undefined;
  if (!creatorId || !sig || !expected || !safeEqual(sig, expected)) {
    return c.html(page('That connection link is invalid or expired. Start over from the onboarding page.'), 400);
  }

  const db = wrapD1(c.env.DB);
  const creator = await db.prepare('SELECT id, business_name FROM creators WHERE id = ?').get<{ id: string; business_name: string }>(creatorId);
  if (!creator) return c.html(page('Creator not found.'), 404);

  const oauth = {
    clientId: c.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: c.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: `${c.env.PUBLIC_BASE_URL}${REDIRECT_PATH}`,
  };

  try {
    const tokens = await exchangeCode(oauth, code);
    if (!tokens.refresh_token) {
      // Google omits refresh_token on a repeat consent unless prompt=consent
      // forced it — buildConsentUrl always sets that, so this should not
      // happen, but failing loudly beats silently storing an unusable row.
      return c.html(page('Google did not return a refresh token. Revoke this app\'s access at myaccount.google.com/permissions and try connecting again.'), 502);
    }

    const accessToken = await getAccessToken(oauth, tokens.refresh_token);
    const profile = await getProfile(accessToken);

    await db
      .prepare(
        `INSERT INTO email_connections (id, creator_id, gmail_address, refresh_token, history_id, connected_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(creator_id) DO UPDATE SET
           gmail_address = excluded.gmail_address,
           refresh_token = excluded.refresh_token,
           history_id = excluded.history_id,
           connected_at = excluded.connected_at`,
      )
      .run(id('emailconn'), creatorId, profile.emailAddress, tokens.refresh_token, profile.historyId, now());

    return c.html(page(`Connected ${profile.emailAddress} to ${creator.business_name}. You can close this tab.`));
  } catch (err) {
    console.error('gmail connect failed', err);
    return c.html(page(`Connection failed: ${err instanceof Error ? err.message : String(err)}`), 502);
  }
});

/**
 * Runs one poll cycle on demand instead of waiting up to 2 minutes for the
 * Cron Trigger — for verifying a connection right after setting it up.
 * Same admin gate as the rest of this file's API, same function the
 * scheduled handler calls; this isn't a separate path to keep in sync.
 */
emailConnectRoute.post('/api/admin/email/poll', async (c) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token) return c.json({ error: 'ADMIN_TOKEN is not configured' }, 503);
  const header = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  if (header !== token && c.req.query('key') !== token) return c.json({ error: 'unauthorized' }, 401);

  const summary = await pollAllConnections(c.env);
  return c.json(summary);
});

function page(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Gmail connection</title>
<style>body{font:16px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;color:#1a1a1c;}</style>
</head><body><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
