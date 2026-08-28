import { Hono } from 'hono';
import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { id, now } from '../../src/util/ids.js';
import type { Creator } from '../../src/domain/types.js';
import { createPhoneNumber, XaiApiError } from '../xai/client.js';
import { checkCreatorAccess, creatorIdFromPath } from '../auth/require-creator.js';

export const phoneNumberRoute = new Hono<{ Bindings: Env }>();

phoneNumberRoute.use('/api/*', async (c, next) => {
  const creatorId = creatorIdFromPath(c.req.path);
  if (creatorId) {
    if (!(await checkCreatorAccess(c, creatorId))) return c.json({ error: 'unauthorized' }, 401);
  } else {
    const token = c.env.ADMIN_TOKEN;
    if (!token) return c.json({ error: 'ADMIN_TOKEN is not configured' }, 503);
    const header = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (header !== token && c.req.query('key') !== token) return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

/**
 * Provisions a number for a creator's coach via xAI's `POST /v2/phone-numbers`.
 *
 * As documented — but confirmed against the real API on 2026-08-16 to return
 * `403 Provisioning SpaceXAI phone numbers via the API is not supported. Use
 * the console (Voice Agents) instead.` This is left in place because it is
 * what the docs describe and may work for other account tiers, but
 * `/phone-number/manual` below is the path that actually works today. See
 * docs/XAI-API-NOTES.md.
 */
phoneNumberRoute.post('/api/creators/:id/phone-number', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(creatorId);
  if (!creator) return c.json({ error: 'creator not found' }, 404);

  if (!c.env.PUBLIC_BASE_URL.startsWith('https://')) {
    return c.json({ error: 'PUBLIC_BASE_URL must be a public https URL — xAI has to reach the webhook' }, 400);
  }

  const body = (await c.req.json().catch(() => ({}))) as { area_code?: string };
  const webhookUrl = `${c.env.PUBLIC_BASE_URL}/webhooks/xai`;

  let result;
  try {
    result = await createPhoneNumber(c.env.XAI_API_BASE, c.env.XAI_API_KEY, {
      name: `${creator.business_name} — ${creator.coach_name}`,
      webhookUrl,
      areaCode: body.area_code,
    });
  } catch (err) {
    if (err instanceof XaiApiError) {
      return c.json(
        {
          error: 'xAI rejected the provisioning request',
          status: err.status,
          detail: err.body,
          hint:
            err.status === 403
              ? 'This account cannot provision numbers via the API. Provision it in the xAI console (Voice Agents), ' +
                'then register the result with POST /api/creators/:id/phone-number/manual — see docs/DEPLOY.md.'
              : undefined,
        },
        502,
      );
    }
    throw err;
  }

  const e164 = (result.phone_number as string | undefined) ?? (result.e164 as string | undefined) ?? (result.number as string | undefined);
  if (!e164) {
    return c.json({ error: 'Response did not contain a phone number', raw: result }, 502);
  }

  const secret = result.signing_secret ?? c.env.XAI_WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    return c.json({ error: 'No signing secret in the response — refusing to store an unverifiable number', raw: result }, 502);
  }

  await db
    .prepare(
      `INSERT INTO phone_numbers
         (id, creator_id, xai_phone_number_id, e164, sip_host, webhook_id, origin, signing_secret, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'xai_provisioned', ?, ?)`,
    )
    .run(id('pn'), creator.id, result.phone_number_id, e164, result.sip_host ?? null, result.webhook_id ?? null, secret, now());

  return c.json({ e164, webhook_url: webhookUrl }, 201);
});

/**
 * Registers a number that was provisioned through the xAI console instead of
 * the API — the path that actually works right now (see above). The console
 * shows the webhook signing secret exactly once at creation time, same as the
 * API would have; it must be pasted in here in that same session, since xAI
 * will not show it again.
 */
phoneNumberRoute.post('/api/creators/:id/phone-number/manual', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(creatorId);
  if (!creator) return c.json({ error: 'creator not found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    e164?: string;
    signing_secret?: string;
    phone_number_id?: string;
    sip_host?: string;
    webhook_id?: string;
    /** 'coach' (default, no behavior change for existing callers) | 'qualify'. */
    purpose?: string;
  };

  if (!body.e164?.trim() || !body.signing_secret?.trim()) {
    return c.json({ error: 'e164 and signing_secret are required' }, 400);
  }
  const purpose = body.purpose === 'qualify' ? 'qualify' : 'coach';

  const webhookUrl = `${c.env.PUBLIC_BASE_URL}/webhooks/xai`;

  await db
    .prepare(
      `INSERT INTO phone_numbers
         (id, creator_id, xai_phone_number_id, e164, sip_host, webhook_id, origin, signing_secret, created_at, purpose)
       VALUES (?, ?, ?, ?, ?, ?, 'xai_provisioned', ?, ?, ?)`,
    )
    .run(
      id('pn'),
      creator.id,
      body.phone_number_id ?? `manual_${Date.now()}`,
      body.e164.trim(),
      body.sip_host ?? 'sip.voice.x.ai',
      body.webhook_id ?? null,
      body.signing_secret.trim(),
      now(),
      purpose,
    );

  return c.json(
    {
      e164: body.e164.trim(),
      webhook_url_reminder: `Confirm the console has this exact webhook URL set: ${webhookUrl}`,
    },
    201,
  );
});
