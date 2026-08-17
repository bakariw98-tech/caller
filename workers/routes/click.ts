import { Hono } from 'hono';
import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { id, now, hmacHex, safeEqual } from '../../src/util/ids.js';

export const clickRoute = new Hono<{ Bindings: Env }>();

/**
 * Offer click attribution.
 *
 * Built now rather than later because "did this actually make me money" is the
 * first question every creator asks, and it is unanswerable retroactively —
 * clicks not recorded at the time are gone. It is also the evidence that
 * justifies moving up a pricing tier.
 *
 * Tokens are signed so a click cannot be forged into another creator's
 * numbers, and an invalid signature still redirects: the prospect asked for a
 * page and should get it. Attribution failing is our problem, not theirs.
 */
clickRoute.get('/r/:token', async (c) => {
  const db = wrapD1(c.env.DB);
  const raw = c.req.param('token');
  const [offerId, prospectId, sig] = raw.split('.');

  if (!offerId || !prospectId || !sig) return c.text('Not found', 404);

  const offer = await db
    .prepare('SELECT id, creator_id, url FROM offers WHERE id = ?')
    .get<{ id: string; creator_id: string; url: string | null }>(offerId);
  if (!offer) return c.text('Not found', 404);

  const expected = hmacHex(c.env.MCP_TOKEN_SECRET, `${offerId}:${prospectId}`).slice(0, 16);
  const valid = safeEqual(expected, sig);

  if (valid) {
    await db
      .prepare(
        `INSERT INTO offer_clicks (id, creator_id, prospect_id, offer_id, clicked_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id('click'), offer.creator_id, prospectId === 'anon' ? null : prospectId, offer.id, now());

    if (prospectId !== 'anon') {
      // A click is the only signal that is an action rather than a statement,
      // so it moves the score more than anything the prospect said.
      await db
        .prepare(
          `UPDATE prospects SET clicked_offer = 1, score = MIN(100, score + 30), last_seen_at = ? WHERE id = ?`,
        )
        .run(now(), prospectId);
    }
  } else {
    console.warn('offer click with bad signature', { offerId });
  }

  return offer.url ? c.redirect(offer.url, 302) : c.text('This offer has no link yet.', 404);
});
