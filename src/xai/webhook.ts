import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DB } from '../db/index.js';
import { now } from '../util/ids.js';

export interface WebhookHeaders {
  'webhook-id'?: string;
  'webhook-timestamp'?: string;
  'webhook-signature'?: string;
  [key: string]: string | string[] | undefined;
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

/** Reject anything older than this, so a captured request cannot be replayed later. */
const TOLERANCE_SECONDS = 5 * 60;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Standard Webhooks verification (HMAC-SHA256).
 *
 * Signed content is `{id}.{timestamp}.{payload}` over the *raw* body — parsing
 * and re-serialising the JSON first would change the bytes and fail every time,
 * so the raw string has to be preserved by the route.
 */
export function verifyWebhook(params: {
  headers: WebhookHeaders;
  rawBody: string;
  signingSecret: string;
  toleranceSeconds?: number;
}): { webhookId: string } {
  const webhookId = first(params.headers['webhook-id']);
  const timestamp = first(params.headers['webhook-timestamp']);
  const signatureHeader = first(params.headers['webhook-signature']);

  if (!webhookId || !timestamp || !signatureHeader) {
    throw new WebhookVerificationError('Missing webhook-id, webhook-timestamp or webhook-signature header');
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) throw new WebhookVerificationError('Malformed webhook-timestamp');
  const drift = Math.abs(now() - ts);
  if (drift > (params.toleranceSeconds ?? TOLERANCE_SECONDS)) {
    throw new WebhookVerificationError(`Webhook timestamp outside tolerance (${drift}s)`);
  }

  // Secrets are distributed base64 behind a `whsec_` prefix.
  const rawSecret = params.signingSecret.startsWith('whsec_')
    ? Buffer.from(params.signingSecret.slice(6), 'base64')
    : Buffer.from(params.signingSecret, 'utf8');

  const expected = createHmac('sha256', rawSecret)
    .update(`${webhookId}.${timestamp}.${params.rawBody}`)
    .digest('base64');

  // The header may carry several space-separated versioned signatures during
  // a secret rotation; any one of them matching is a pass.
  const candidates = signatureHeader
    .split(' ')
    .map((part) => (part.includes(',') ? part.slice(part.indexOf(',') + 1) : part))
    .filter(Boolean);

  const expectedBuf = Buffer.from(expected);
  const ok = candidates.some((candidate) => {
    const candidateBuf = Buffer.from(candidate);
    return candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf);
  });

  if (!ok) throw new WebhookVerificationError('Signature mismatch');
  return { webhookId };
}

/**
 * Records a webhook id, returning false if it has been seen before.
 *
 * Delivery is at-least-once, and answering the same call twice would open two
 * sessions against one caller and bill them both.
 */
export function claimWebhookId(db: DB, webhookId: string, eventType: string): boolean {
  try {
    db.prepare('INSERT INTO webhook_events (webhook_id, event_type, seen_at) VALUES (?, ?, ?)').run(
      webhookId,
      eventType,
      now(),
    );
    return true;
  } catch {
    return false; // UNIQUE violation: already handled.
  }
}

export interface IncomingCallEvent {
  id: string;
  type: string;
  createdAt: number;
  callId: string;
  from: string | null;
  to: string | null;
}

export function parseIncomingCall(payload: unknown): IncomingCallEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const evt = payload as Record<string, any>;
  if (evt.type !== 'realtime.call.incoming') return null;

  const data = evt.data ?? {};
  const headers: { name?: string; value?: string }[] = Array.isArray(data.sip_headers) ? data.sip_headers : [];
  const header = (name: string) =>
    headers.find((h) => (h.name ?? '').toLowerCase() === name.toLowerCase())?.value ?? null;

  if (!data.call_id) return null;

  return {
    id: String(evt.id ?? ''),
    type: String(evt.type),
    createdAt: Number(evt.created_at ?? now()),
    callId: String(data.call_id),
    from: normalizeE164(header('From')),
    to: normalizeE164(header('To')),
  };
}

/**
 * SIP From/To headers arrive in many shapes — bare numbers, `sip:+1...@host`,
 * `"Name" <sip:...>`. Everything is reduced to E.164 so caller-ID lookup has
 * one format to match.
 */
export function normalizeE164(value: string | null): string | null {
  if (!value) return null;
  const uriMatch = /(?:sips?|tel):\+?([0-9]+)/i.exec(value);
  const digits = uriMatch ? uriMatch[1]! : value.replace(/[^0-9]/g, '');
  if (!digits) return null;
  // Assume NANP when a 10-digit number arrives without a country code.
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits.replace(/^\+/, '')}`;
}
