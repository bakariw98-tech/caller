import { Hono } from 'hono';
import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { id, now } from '../../src/util/ids.js';
import type { Creator } from '../../src/domain/types.js';
import { createPhoneNumber } from '../xai/client.js';

export const phoneNumberRoute = new Hono<{ Bindings: Env }>();

/**
 * Provisions a number for a creator's coach.
 *
 * Same operation as `npm run provision` in the Node build, exposed as an admin
 * endpoint here because a Worker has no local CLI to run scripts from — the
 * user drives this with one curl call after deploying, documented in
 * docs/DEPLOY.md. The webhook signing secret is returned exactly once by xAI
 * and stored in the same request that receives it; a number whose secret we
 * cannot read is refused rather than stored unverifiable.
 */
phoneNumberRoute.use('/api/*', async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token) return c.json({ error: 'ADMIN_TOKEN is not configured' }, 503);
  const header = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  const query = c.req.query('key');
  if (header !== token && query !== token) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

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

  const result = await createPhoneNumber(c.env.XAI_API_BASE, c.env.XAI_API_KEY, {
    name: `${creator.business_name} — ${creator.coach_name}`,
    webhookUrl,
    areaCode: body.area_code,
  });

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
