import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import type { PhoneNumber } from '../domain/types.js';
import { claimWebhookId, parseIncomingCall, verifyWebhook, WebhookVerificationError, normalizeE164 } from '../xai/webhook.js';
import { routeIncomingCall } from '../telephony/call-router.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/**
 * Inbound call webhook.
 *
 * Order matters here: verify the signature against the raw bytes, claim the
 * event id so a redelivery cannot open a second session, and only then answer.
 * Everything after verification runs detached — xAI is waiting on this response
 * while a phone rings.
 */
export function registerWebhookRoutes(app: FastifyInstance): void {
  app.post('/webhooks/xai', async (req, reply) => {
    const raw = req.rawBody ?? '';
    const payload = req.body as Record<string, unknown> | undefined;

    const event = parseIncomingCall(payload);
    if (!event) {
      // Other event types are acknowledged so xAI stops retrying them.
      req.log.info({ type: (payload as any)?.type }, 'ignoring non-call webhook');
      return reply.code(204).send();
    }

    const db = getDb();
    const secret = resolveSigningSecret(event.to);
    if (!secret) {
      req.log.error({ to: event.to }, 'no signing secret for destination number');
      return reply.code(404).send({ error: 'unknown number' });
    }

    try {
      verifyWebhook({ headers: req.headers as Record<string, string>, rawBody: raw, signingSecret: secret });
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        req.log.warn({ err: err.message }, 'webhook verification failed');
        return reply.code(401).send({ error: 'invalid signature' });
      }
      throw err;
    }

    if (!claimWebhookId(db, event.id || event.callId, event.type)) {
      req.log.info({ webhookId: event.id }, 'duplicate webhook delivery ignored');
      return reply.code(200).send({ status: 'duplicate' });
    }

    // Answer promptly; the session is established out of band.
    void routeIncomingCall({ db, logger: req.log }, event)
      .then((res) => req.log.info(res, 'call routed'))
      .catch((err) => req.log.error({ err }, 'failed to route call'));

    return reply.code(200).send({ status: 'accepted' });
  });
}

/**
 * Each number carries its own secret, since each is provisioned separately.
 * The env var is a fallback for a secret held outside the database.
 */
function resolveSigningSecret(toNumber: string | null): string | null {
  const db = getDb();
  const normalized = normalizeE164(toNumber);
  if (normalized) {
    const row = db.prepare('SELECT * FROM phone_numbers WHERE e164 = ?').get(normalized) as
      | PhoneNumber
      | undefined;
    if (row?.signing_secret) return row.signing_secret;
  }
  return config.xai.webhookSigningSecret || null;
}
