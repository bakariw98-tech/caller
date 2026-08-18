/**
 * A minimal Gmail API client — just the surface the lead engine needs:
 * refresh an access token, read what's new since a stored cursor, send a
 * threaded reply. No googleapis SDK (it assumes Node, this runs on Workers),
 * just fetch() against the documented REST endpoints.
 *
 * See docs/DEPLOY.md for why this exists instead of Cloudflare Email
 * Service: workers.dev cannot receive mail and this account has no domain,
 * but a single Gmail account needs neither — see the plan history for the
 * OAuth verification research that established that.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.modify'];

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** The one-time consent URL a creator visits to connect their Gmail account. `state` carries the creator id. */
export function buildConsentUrl(config: GoogleOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline', // required to get a refresh_token back
    prompt: 'consent', // forces refresh_token even on a re-auth
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Google token request failed: ${json.error ?? res.status} ${json.error_description ?? ''}`.trim());
  }
  return { access_token: json.access_token, refresh_token: json.refresh_token, expires_in: json.expires_in ?? 3600 };
}

/** Exchanges the one-time authorization code from the consent redirect for tokens. The refresh_token is what gets stored. */
export async function exchangeCode(config: GoogleOAuthConfig, code: string) {
  return tokenRequest({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  });
}

/**
 * Trades a stored refresh token for a fresh access token.
 *
 * No cross-request caching: each poll invocation is a fresh, short-lived
 * request and the token endpoint is cheap, so simplicity beats shaving one
 * round trip against an unpredictable-lifetime Workers isolate.
 */
export async function getAccessToken(config: Pick<GoogleOAuthConfig, 'clientId' | 'clientSecret'>, refreshToken: string): Promise<string> {
  const { access_token } = await tokenRequest({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
  });
  return access_token;
}

async function gmailFetch(accessToken: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${accessToken}` },
  });
}

/** The mailbox's current sync cursor and address — read once at connect time to seed history_id without replaying old mail. */
export async function getProfile(accessToken: string): Promise<{ emailAddress: string; historyId: string }> {
  const res = await gmailFetch(accessToken, '/profile');
  if (!res.ok) throw new Error(`gmail profile fetch failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { emailAddress: string; historyId: string };
  return json;
}

export interface InboundMessage {
  gmailId: string;
  threadId: string;
  from: string;
  fromName: string | null;
  subject: string | null;
  messageId: string | null; // the RFC 2822 Message-Id header, for In-Reply-To/References
  references: string | null;
  text: string;
  labelIds: string[];
}

function headerValue(headers: { name: string; value: string }[] | undefined, name: string): string | null {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/** Strips tags for the rare message that only has an HTML body — good enough for extracting a question, not a rendering engine. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

/** Walks the MIME tree depth-first, preferring the first text/plain part found and falling back to text/html. */
function extractBody(payload: GmailPart): string {
  let plain: string | null = null;
  let html: string | null = null;
  const stack: GmailPart[] = [payload];
  while (stack.length) {
    const part = stack.shift()!;
    if (part.mimeType === 'text/plain' && part.body?.data && plain === null) {
      plain = decodeBase64Url(part.body.data);
    } else if (part.mimeType === 'text/html' && part.body?.data && html === null) {
      html = decodeBase64Url(part.body.data);
    }
    if (part.parts) stack.push(...part.parts);
  }
  if (plain !== null) return plain.trim();
  if (html !== null) return stripHtml(html);
  return '';
}

/** Fetches one message's headers and body in the shape the pipeline needs. */
export async function getMessage(accessToken: string, gmailId: string): Promise<InboundMessage> {
  const res = await gmailFetch(accessToken, `/messages/${gmailId}?format=full`);
  if (!res.ok) throw new Error(`gmail message fetch failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    id: string;
    threadId: string;
    labelIds?: string[];
    payload: GmailPart & { headers?: { name: string; value: string }[] };
  };
  const headers = json.payload.headers;
  const fromRaw = headerValue(headers, 'From') ?? '';
  const match = fromRaw.match(/^(.*?)\s*<([^>]+)>\s*$/);
  const from = (match ? (match[2] ?? fromRaw) : fromRaw).trim().toLowerCase();
  const fromName = match ? (match[1] ?? '').replace(/^"|"$/g, '').trim() || null : null;

  return {
    gmailId: json.id,
    threadId: json.threadId,
    from,
    fromName,
    subject: headerValue(headers, 'Subject'),
    messageId: headerValue(headers, 'Message-Id') ?? headerValue(headers, 'Message-ID'),
    references: headerValue(headers, 'References'),
    text: extractBody(json.payload),
    labelIds: json.labelIds ?? [],
  };
}

/** history.list surfaces a stale-cursor error as 404, distinct from every other failure — reset instead of crash-looping. */
export class HistoryGapError extends Error {}

export interface HistoryResult {
  /** Gmail message ids newly added to INBOX since the given cursor. */
  newMessageIds: string[];
  /** The cursor to store for next time — the latest historyId seen across all pages. */
  latestHistoryId: string;
}

/**
 * Lists what's new since `sinceHistoryId`, paginating as needed.
 *
 * Google's documented sync pattern (see /v1/users.history/list): historyId
 * is a cursor, not a timestamp, and the caller is expected to walk pages via
 * nextPageToken and adopt the last page's historyId as the next cursor.
 *
 * Returns CANDIDATE ids, not confirmed-INBOX ids — deliberately. Two rounds
 * of testing against a real account found Gmail representing "this message
 * changed" in shapes the docs don't fully enumerate: `messagesAdded` and
 * `labelsAdded` sub-arrays (each carrying their own `labelIds` snapshot), and
 * — found on a message that never got caught by either — a bare top-level
 * `messages` array with no sub-array at all and no labelIds included. Trying
 * to keep guessing every shape Gmail might use and filtering on whatever
 * labelIds happens to be embedded where is chasing an undocumented surface
 * that keeps growing. Instead: collect every id mentioned anywhere in the
 * history response, by any shape, and let the one authoritative source — an
 * actual fetch of that message — decide whether it's currently in INBOX.
 * More API calls, but correct by construction rather than by enumeration.
 */
export async function listNewInboxMessages(accessToken: string, sinceHistoryId: string): Promise<HistoryResult> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId = sinceHistoryId;

  do {
    const params = new URLSearchParams({ startHistoryId: sinceHistoryId });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await gmailFetch(accessToken, `/history?${params.toString()}`);
    if (res.status === 404) {
      // startHistoryId is too old for Gmail to have retained — the gap has to
      // be closed by resetting the cursor from a fresh profile fetch, which
      // means anything sent during the gap is missed rather than guessed at.
      throw new HistoryGapError('history cursor is stale');
    }
    if (!res.ok) throw new Error(`gmail history.list failed: ${res.status} ${await res.text()}`);

    const json = (await res.json()) as {
      history?: Record<string, unknown>[];
      historyId?: string;
      nextPageToken?: string;
    };

    for (const h of json.history ?? []) {
      collectMessageIds(h, ids);
    }
    if (json.historyId) latestHistoryId = json.historyId;
    pageToken = json.nextPageToken;
  } while (pageToken);

  return { newMessageIds: [...ids], latestHistoryId };
}

/**
 * Pulls every message id out of one history entry regardless of which
 * sub-array(s) it appears under — `messagesAdded`, `labelsAdded`, the bare
 * `messages` array, or anything else shaped like `[{ message: { id } }]` or
 * `[{ id }]`. Over-collecting is harmless (the caller re-checks each id's
 * real state); under-collecting is the actual bug this replaced.
 */
function collectMessageIds(entry: Record<string, unknown>, ids: Set<string>): void {
  for (const value of Object.values(entry)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        const msg = (rec.message ?? rec) as Record<string, unknown>;
        if (typeof msg.id === 'string') ids.add(msg.id);
      }
    }
  }
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeHeaderValue(value: string): string {
  // RFC 2047 encoded-word for a Subject/name that might carry non-ASCII —
  // most creator names and subjects are plain ASCII, so this only kicks in
  // when it needs to rather than mangling the common case.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(value)))}?=`;
}

export interface OutboundMessage {
  to: string;
  from: string;
  fromName: string | null;
  subject: string;
  bodyText: string;
  /** Set these from the inbound message being replied to so Gmail (and every other client) threads it correctly. */
  inReplyTo?: string | null;
  references?: string | null;
}

/**
 * Builds the base64url raw MIME message users.messages.send expects. Pure
 * and unit-testable — no network.
 *
 * The header/body blank line is structural, not optional. RFC 5322 requires
 * an empty line to mark where headers end and the body begins; without it,
 * a parser has no boundary and folds the body into the last header instead
 * of treating it as message content, which reads as an empty reply — found
 * by a real reply landing empty in a real inbox, not by re-reading this
 * function. So the optional-header filtering and the separator are kept
 * apart: only the header lines that might legitimately be blank (a missing
 * In-Reply-To/References) get filtered, and the separator is appended after,
 * unconditionally.
 */
export function buildRawMessage(msg: OutboundMessage): string {
  const fromHeader = msg.fromName ? `${encodeHeaderValue(msg.fromName)} <${msg.from}>` : msg.from;
  const references = [msg.references, msg.inReplyTo].filter(Boolean).join(' ');
  const headers = [
    `From: ${fromHeader}`,
    `To: ${msg.to}`,
    `Subject: ${encodeHeaderValue(msg.subject)}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    msg.inReplyTo ? `In-Reply-To: ${msg.inReplyTo}` : '',
    references ? `References: ${references}` : '',
  ].filter((l) => l !== '');
  return base64UrlEncode([...headers, '', msg.bodyText].join('\r\n'));
}

/** Sends a reply, keeping it in the same Gmail thread as the message it answers. */
export async function sendMessage(accessToken: string, raw: string, threadId?: string): Promise<void> {
  const res = await gmailFetch(accessToken, '/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  });
  if (!res.ok) throw new Error(`gmail send failed: ${res.status} ${await res.text()}`);
}
