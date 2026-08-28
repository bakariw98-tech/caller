import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import type { Creator, Customer, PhoneNumber } from '../domain/types.js';
import { customerPage, esc, money } from './views.js';
import { confirmVerification, OtpError, startVerification } from '../identity/otp.js';
import { normalizeE164 } from '../xai/webhook.js';
import { balanceSeconds, topUp } from '../billing/wallet.js';
import { retailCentsForSeconds } from '../billing/pricing.js';

function creatorBySlug(slug: string): Creator | undefined {
  return getDb().prepare('SELECT * FROM creators WHERE slug = ?').get(slug) as Creator | undefined;
}

function coachNumber(creatorId: string): string | null {
  const row = getDb()
    .prepare('SELECT e164 FROM phone_numbers WHERE creator_id = ? ORDER BY created_at LIMIT 1')
    .get(creatorId) as Pick<PhoneNumber, 'e164'> | undefined;
  return row?.e164 ?? null;
}

/**
 * The customer's entire view of the product.
 *
 * These pages exist to get somebody verified, credited and dialling. Nothing
 * here mentions the platform, and no page explains how the coach works.
 */
export function registerCustomerRoutes(app: FastifyInstance): void {
  app.get('/c/:slug', async (req, reply) => {
    const creator = creatorBySlug((req.params as { slug: string }).slug);
    if (!creator) return reply.code(404).send('Not found');

    const body = `
      <h1>${esc(creator.coach_name)}</h1>
      <p>${esc(creator.welcome_message ?? `Call ${creator.coach_name} whenever you get stuck.`)}</p>
      <div class="card">
        <form method="post" action="/c/${esc(creator.slug)}/verify">
          <label for="name">Your name</label>
          <input id="name" name="name" autocomplete="name" required>
          <label for="phone">Your phone number</label>
          <input id="phone" name="phone" type="tel" autocomplete="tel" placeholder="+1 555 010 0100" required>
          <button type="submit">Send me a code</button>
        </form>
        <p class="muted" style="margin-top:1rem">
          We use your number to recognise you when you call, so you never have to explain
          where you are twice.
        </p>
      </div>`;
    return reply.type('text/html').send(customerPage({ creator, title: creator.coach_name, body }));
  });

  app.post('/c/:slug/verify', async (req, reply) => {
    const creator = creatorBySlug((req.params as { slug: string }).slug);
    if (!creator) return reply.code(404).send('Not found');

    const form = (req.body ?? {}) as { name?: string; phone?: string };
    const phone = normalizeE164(form.phone ?? '');
    if (!phone) {
      return reply.type('text/html').send(
        customerPage({
          creator,
          title: 'Check that number',
          body: `<h1>That number didn't look right</h1>
                 <p>Give it another go with the country code, like +1 555 010 0100.</p>
                 <p><a href="/c/${esc(creator.slug)}">Back</a></p>`,
        }),
      );
    }

    try {
      await startVerification(getDb(), { creatorId: creator.id, phoneE164: phone });
    } catch (err) {
      if (!(err instanceof OtpError) || err.code !== 'cooldown') throw err;
    }

    const body = `
      <h1>Check your messages</h1>
      <p>We sent a six-digit code to ${esc(phone)}.</p>
      <div class="card">
        <form method="post" action="/c/${esc(creator.slug)}/confirm">
          <input type="hidden" name="phone" value="${esc(phone)}">
          <input type="hidden" name="name" value="${esc(form.name ?? '')}">
          <label for="code">Your code</label>
          <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
          <button type="submit">Confirm</button>
        </form>
      </div>`;
    return reply.type('text/html').send(customerPage({ creator, title: 'Verify', body }));
  });

  app.post('/c/:slug/confirm', async (req, reply) => {
    const creator = creatorBySlug((req.params as { slug: string }).slug);
    if (!creator) return reply.code(404).send('Not found');

    const form = (req.body ?? {}) as { name?: string; phone?: string; code?: string };
    const phone = normalizeE164(form.phone ?? '');
    if (!phone || !form.code) return reply.code(400).send('Missing phone or code');

    try {
      const customer = confirmVerification(getDb(), {
        creatorId: creator.id,
        phoneE164: phone,
        code: form.code,
        name: form.name,
      });
      return reply.redirect(`/c/${creator.slug}/account?id=${customer.id}`);
    } catch (err) {
      if (err instanceof OtpError) {
        const body = `
          <h1>That didn't work</h1>
          <div class="card error"><p>${esc(err.message)}</p></div>
          <p><a href="/c/${esc(creator.slug)}">Start again</a></p>`;
        return reply.code(400).type('text/html').send(customerPage({ creator, title: 'Verify', body }));
      }
      throw err;
    }
  });

  app.get('/c/:slug/account', async (req, reply) => {
    const creator = creatorBySlug((req.params as { slug: string }).slug);
    if (!creator) return reply.code(404).send('Not found');

    const customerId = (req.query as { id?: string }).id ?? '';
    const customer = getDb()
      .prepare('SELECT * FROM customers WHERE id = ? AND creator_id = ?')
      .get(customerId, creator.id) as Customer | undefined;
    if (!customer) return reply.code(404).send('Not found');

    const seconds = balanceSeconds(getDb(), customer.id, creator.id);
    const number = coachNumber(creator.id);
    const price = creator.price_per_minute_cents;

    // Blocks are sold in minutes; unused minutes simply stay in the wallet.
    const blocks = [30, 60, 120];

    const body = `
      <h1>You're set up${customer.name ? `, ${esc(customer.name.split(' ')[0])}` : ''}</h1>
      <div class="card">
        <p class="muted">Call ${esc(creator.coach_name)} any time</p>
        <p class="number">${esc(number ?? 'Coming soon')}</p>
        <p class="muted">We'll know it's you from ${esc(customer.phone_e164)}.</p>
      </div>
      <div class="card">
        <p><strong>${Math.floor(seconds / 60)} minutes</strong> of coaching left.</p>
        <h2>Add more</h2>
        ${blocks
          .map(
            (m) => `
          <form method="post" action="/c/${esc(creator.slug)}/topup" style="margin-bottom:.5rem">
            <input type="hidden" name="id" value="${esc(customer.id)}">
            <input type="hidden" name="minutes" value="${m}">
            <button type="submit">${m} minutes — ${esc(money(retailCentsForSeconds(m * 60, price)))}</button>
          </form>`,
          )
          .join('')}
        <p class="muted">
          Minutes never expire and there's no subscription — you top up when you want more.
        </p>
      </div>`;
    return reply.type('text/html').send(customerPage({ creator, title: 'Your account', body }));
  });

  /**
   * Credit purchase.
   *
   * Deliberately a single explicit action with no stored payment method: the
   * product is prepaid minutes, and nothing here should renew on its own.
   * A real deployment puts the creator's payment processor in front of this,
   * with the creator's business name on the descriptor and receipt.
   */
  app.post('/c/:slug/topup', async (req, reply) => {
    const creator = creatorBySlug((req.params as { slug: string }).slug);
    if (!creator) return reply.code(404).send('Not found');

    const form = (req.body ?? {}) as { id?: string; minutes?: string };
    const customer = getDb()
      .prepare('SELECT * FROM customers WHERE id = ? AND creator_id = ?')
      .get(form.id ?? '', creator.id) as Customer | undefined;
    if (!customer) return reply.code(404).send('Not found');

    const minutes = Math.max(1, Number(form.minutes ?? 30));
    const seconds = minutes * 60;

    topUp(getDb(), {
      customerId: customer.id,
      creatorId: creator.id,
      seconds,
      paidCents: retailCentsForSeconds(seconds, creator.price_per_minute_cents),
      reason: `${minutes} minute block`,
    });

    return reply.redirect(`/c/${creator.slug}/account?id=${customer.id}`);
  });
}
