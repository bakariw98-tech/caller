import { Hono } from 'hono';
import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { id, now } from '../../src/util/ids.js';
import { normalizeE164 } from '../../src/xai/webhook.js';
import { customerPage, esc, money } from '../../src/web/views.js';
import { generateUniquePasscode } from '../identity/passcode.js';
import { balanceSeconds, topUp } from '../billing/wallet.js';
import { retailCentsForSeconds } from '../billing/pricing.js';
import type { Creator, Customer, PhoneNumber } from '../../src/domain/types.js';

export const customerRoute = new Hono<{ Bindings: Env }>();

/**
 * The customer's entire view of the product — a real web page, no SMS round
 * trip. A passcode is generated at signup and shown once, right there on the
 * page; there is no phone step to verify, because this platform never gets
 * caller ID to verify against anyway (see docs/XAI-API-NOTES.md). The
 * passcode itself, spoken or keyed on the call, is what proves who's calling.
 */

async function creatorBySlug(db: ReturnType<typeof wrapD1>, slug: string) {
  return db.prepare('SELECT * FROM creators WHERE slug = ?').get<Creator>(slug);
}

async function coachNumber(db: ReturnType<typeof wrapD1>, creatorId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT e164 FROM phone_numbers WHERE creator_id = ? ORDER BY created_at LIMIT 1')
    .get<Pick<PhoneNumber, 'e164'>>(creatorId);
  return row?.e164 ?? null;
}

customerRoute.get('/c/:slug', async (c) => {
  const db = wrapD1(c.env.DB);
  const creator = await creatorBySlug(db, c.req.param('slug'));
  if (!creator) return c.text('Not found', 404);

  const body = `
    <h1>${esc(creator.coach_name)}</h1>
    <p>${esc(creator.welcome_message ?? `Call ${creator.coach_name} whenever you get stuck.`)}</p>
    <div class="card">
      <form method="post" action="/c/${esc(creator.slug)}/signup">
        <label for="name">Your name</label>
        <input id="name" name="name" autocomplete="name" required>
        <label for="phone">Your phone number</label>
        <input id="phone" name="phone" type="tel" autocomplete="tel" placeholder="+1 555 010 0100" required>
        <button type="submit">Get started</button>
      </form>
      <p class="muted" style="margin-top:1rem">
        You'll get a passcode to say or type in when you call — that's how ${esc(creator.coach_name)}
        knows it's you and picks up where you left off.
      </p>
    </div>`;
  return c.html(customerPage({ creator, title: creator.coach_name, body }));
});

customerRoute.post('/c/:slug/signup', async (c) => {
  const db = wrapD1(c.env.DB);
  const creator = await creatorBySlug(db, c.req.param('slug'));
  if (!creator) return c.text('Not found', 404);

  const form = (await c.req.parseBody()) as { name?: string; phone?: string };
  const phone = normalizeE164(form.phone ?? '');
  const name = form.name?.trim();

  if (!phone || !name) {
    const body = `
      <h1>Missing something</h1>
      <p>That number didn't look right — try it again with the country code, like +1 555 010 0100.</p>
      <p><a href="/c/${esc(creator.slug)}">Back</a></p>`;
    return c.html(customerPage({ creator, title: 'Check that', body }), 400);
  }

  const existing = await db
    .prepare('SELECT * FROM customers WHERE creator_id = ? AND phone_e164 = ?')
    .get<Customer>(creator.id, phone);
  if (existing) {
    // Already signed up on this number: send them to their existing account
    // rather than minting a second identity for the same person.
    return c.redirect(`/c/${creator.slug}/account?id=${existing.id}`);
  }

  const passcode = await generateUniquePasscode(db, creator.id);
  const customerId = id('cust');
  await db
    .prepare(
      `INSERT INTO customers (id, creator_id, name, phone_e164, verified_at, passcode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(customerId, creator.id, name, phone, now(), passcode, now());

  return c.redirect(`/c/${creator.slug}/account?id=${customerId}&new=1`);
});

customerRoute.get('/c/:slug/account', async (c) => {
  const db = wrapD1(c.env.DB);
  const creator = await creatorBySlug(db, c.req.param('slug'));
  if (!creator) return c.text('Not found', 404);

  const customerId = c.req.query('id') ?? '';
  const customer = await db
    .prepare('SELECT * FROM customers WHERE id = ? AND creator_id = ?')
    .get<Customer>(customerId, creator.id);
  if (!customer) return c.text('Not found', 404);

  const seconds = await balanceSeconds(db, customer.id, creator.id);
  const number = await coachNumber(db, creator.id);
  const price = creator.price_per_minute_cents;
  const isNew = c.req.query('new') === '1';

  const blocks = [30, 60, 120];

  const body = `
    <h1>You're set up${customer.name ? `, ${esc(customer.name.split(' ')[0])}` : ''}</h1>
    ${
      isNew
        ? `<div class="card" style="border-color:var(--accent)">
             <p class="muted">Your passcode</p>
             <p class="number">${esc(customer.passcode ?? '')}</p>
             <p class="muted">
               Say this or type it on the keypad when ${esc(creator.coach_name)} asks who's calling.
               Write it down — this is the only place it's shown.
             </p>
           </div>`
        : ''
    }
    <div class="card">
      <p class="muted">Call ${esc(creator.coach_name)} any time</p>
      <p class="number">${esc(number ?? 'Coming soon')}</p>
      ${!isNew ? `<p class="muted">Your passcode is <strong>${esc(customer.passcode ?? '')}</strong> — say or type it when asked.</p>` : ''}
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
  return c.html(customerPage({ creator, title: 'Your account', body }));
});

/**
 * Credit purchase. Deliberately a single explicit action with no stored
 * payment method — the product is prepaid minutes, nothing renews on its own.
 * A real deployment puts a payment processor in front of this, with the
 * creator's business name on the descriptor and receipt.
 */
customerRoute.post('/c/:slug/topup', async (c) => {
  const db = wrapD1(c.env.DB);
  const creator = await creatorBySlug(db, c.req.param('slug'));
  if (!creator) return c.text('Not found', 404);

  const form = (await c.req.parseBody()) as { id?: string; minutes?: string };
  const customer = await db
    .prepare('SELECT * FROM customers WHERE id = ? AND creator_id = ?')
    .get<Customer>(form.id ?? '', creator.id);
  if (!customer) return c.text('Not found', 404);

  const minutes = Math.max(1, Number(form.minutes ?? 30));
  const seconds = minutes * 60;

  await topUp(db, {
    customerId: customer.id,
    creatorId: creator.id,
    seconds,
    paidCents: retailCentsForSeconds(seconds, creator.price_per_minute_cents),
    reason: `${minutes} minute block`,
  });

  return c.redirect(`/c/${creator.slug}/account?id=${customer.id}`);
});
