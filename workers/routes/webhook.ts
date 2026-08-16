import { Hono } from 'hono';
import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { parseIncomingCall, verifyWebhook, WebhookVerificationError, normalizeE164 } from '../../src/xai/webhook.js';
import { claimWebhookId } from '../xai/webhook-store.js';
import { routeIncomingCall } from '../telephony/call-router.js';
import type { PhoneNumber } from '../../src/domain/types.js';

export const webhookRoute = new Hono<{ Bindings: Env }>();

/**
 * Inbound call webhook — same shape and order of operations as
 * src/http/webhook-route.ts: verify against the raw body, claim the event id,
 * then route. xAI is waiting on this response while a phone rings, so routing
 * runs via `ctx.waitUntil` rather than being awaited into the response.
 */
webhookRoute.post('/webhooks/xai', async (c) => {
  const raw = await c.req.text();
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  const event = parseIncomingCall(payload);
  if (!event) return c.body(null, 204);

  const db = wrapD1(c.env.DB);

  const normalizedTo = normalizeE164(event.to);
  let signingSecret = c.env.XAI_WEBHOOK_SIGNING_SECRET || null;
  if (normalizedTo) {
    const row = await db.prepare('SELECT * FROM phone_numbers WHERE e164 = ?').get<PhoneNumber>(normalizedTo);
    if (row?.signing_secret) signingSecret = row.signing_secret;
  }
  if (!signingSecret) return c.json({ error: 'unknown number' }, 404);

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => (headers[k] = v));

  try {
    verifyWebhook({ headers, rawBody: raw, signingSecret });
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return c.json({ error: 'invalid signature' }, 401);
    }
    throw err;
  }

  if (!(await claimWebhookId(db, event.id || event.callId, event.type))) {
    return c.json({ status: 'duplicate' }, 200);
  }

  c.executionCtx.waitUntil(
    routeIncomingCall(db, c.env, event).catch((err) => console.error('failed to route call', err)),
  );

  return c.json({ status: 'accepted' }, 200);
});
