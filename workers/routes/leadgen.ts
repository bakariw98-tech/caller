import { Hono } from 'hono';
import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { id, now, hmacHex } from '../../src/util/ids.js';
import type { Creator } from '../../src/domain/types.js';
import { extractFreeContent, NoUsableContentError, type FreeContentSource } from '../leadgen/extract.js';
import { loadOffers } from '../leadgen/reply.js';
import { runLeadgenPipeline, CreatorNotFoundError } from '../leadgen/pipeline.js';

export const leadgenRoute = new Hono<{ Bindings: Env }>();

leadgenRoute.use('/api/*', async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token) return c.json({ error: 'ADMIN_TOKEN is not configured' }, 503);
  const header = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  if (header !== token && c.req.query('key') !== token) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

// ---------------------------------------------------------------- offers --

leadgenRoute.post('/api/creators/:id/offers', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const creator = await db.prepare('SELECT id FROM creators WHERE id = ?').get<{ id: string }>(creatorId);
  if (!creator) return c.json({ error: 'creator not found' }, 404);

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = String(b.name ?? '').trim();
  if (!name) return c.json({ error: 'name is required' }, 400);

  const offerId = id('offer');
  await db
    .prepare(
      `INSERT INTO offers (id, creator_id, kind, name, who_for, covers, price_text, url, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      offerId,
      creatorId,
      String(b.kind ?? 'course'),
      name,
      b.who_for ? String(b.who_for) : null,
      b.covers ? String(b.covers) : null,
      b.price_text ? String(b.price_text) : null,
      b.url ? String(b.url) : null,
      now(),
    );
  return c.json({ id: offerId, name }, 201);
});

leadgenRoute.get('/api/creators/:id/offers', async (c) => {
  const db = wrapD1(c.env.DB);
  return c.json({ offers: await loadOffers(db, c.req.param('id')) });
});

// ------------------------------------------------------------- ingestion --

/**
 * Free content in, problem-indexed knowledge out.
 *
 * Unlike the curriculum endpoint, this writes directly rather than returning a
 * draft for review. The difference is what a mistake costs: a bad curriculum
 * step misleads a paying student mid-task, while a bad knowledge item mostly
 * fails to be retrieved. The boundaries it sets are reviewable afterwards via
 * GET, and nothing here is spoken until a prospect actually asks.
 */
leadgenRoute.post('/api/creators/:id/content', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(creatorId);
  if (!creator) return c.json({ error: 'creator not found' }, 404);

  const b = (await c.req.json().catch(() => ({}))) as {
    sources?: { kind?: string; title?: string; url?: string; text?: string }[];
    replace?: boolean;
  };

  const allowed = new Set(['video_transcript', 'podcast', 'blog', 'newsletter', 'framework', 'lead_magnet', 'faq']);
  const sources: FreeContentSource[] = (b.sources ?? [])
    .filter((s) => typeof s.text === 'string' && s.text.trim())
    .map((s) => ({
      kind: (allowed.has(String(s.kind)) ? String(s.kind) : 'blog') as FreeContentSource['kind'],
      title: s.title?.trim() || undefined,
      url: s.url?.trim() || undefined,
      text: String(s.text),
    }));
  if (!sources.length) return c.json({ error: 'Add some free content to work from.' }, 400);

  const offers = await loadOffers(db, creatorId);

  try {
    const result = await extractFreeContent({
      apiBase: c.env.XAI_API_BASE,
      apiKey: c.env.XAI_API_KEY,
      model: c.env.XAI_TEXT_MODEL,
      sources,
      offers: offers.map((o) => ({ id: o.id, name: o.name, who_for: o.who_for, covers: o.covers })),
    });

    if (b.replace) {
      await db.prepare('DELETE FROM knowledge_items WHERE creator_id = ?').run(creatorId);
    }

    const offerIdByName = new Map(offers.map((o) => [o.name.toLowerCase(), o.id]));
    let stored = 0;
    let withBoundary = 0;

    for (const item of result.items) {
      const boundaryOfferId = item.boundary_offer_name
        ? (offerIdByName.get(item.boundary_offer_name.trim().toLowerCase()) ?? null)
        : null;
      if (item.boundary) withBoundary++;
      await db
        .prepare(
          `INSERT INTO knowledge_items
             (id, creator_id, problem, who_for, guidance, framework_terms_json, source_refs_json,
              source_quote, boundary, boundary_offer_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id('kn'),
          creatorId,
          item.problem,
          item.who_for ?? null,
          item.guidance,
          JSON.stringify(item.framework_terms ?? []),
          JSON.stringify(item.source_refs ?? []),
          item.source_quote ?? null,
          item.boundary ?? null,
          boundaryOfferId,
          now(),
        );
      stored++;
    }

    // The extracted methodology and terminology belong on the creator so both
    // products speak the same way; only filled if the creator left it blank.
    if (result.methodology && !creator.methodology) {
      await db
        .prepare('UPDATE creators SET methodology = ?, updated_at = ? WHERE id = ?')
        .run(result.methodology, now(), creatorId);
    }

    return c.json({
      stored,
      with_boundary: withBoundary,
      without_boundary: stored - withBoundary,
      terminology: result.terminology,
      methodology: result.methodology,
      usage: result.usage,
      note:
        'Items without a boundary are answered in full and never trigger a pitch — that is the intended ' +
        'majority. Review boundaries before going live: they are the only thing routing fires on.',
    });
  } catch (err) {
    if (err instanceof NoUsableContentError) return c.json({ error: err.message }, 400);
    console.error('content extraction failed', err);
    return c.json({ error: 'Could not extract that content', detail: err instanceof Error ? err.message : String(err) }, 502);
  }
});

leadgenRoute.get('/api/creators/:id/knowledge', async (c) => {
  const db = wrapD1(c.env.DB);
  const rows = await db
    .prepare(
      `SELECT k.id, k.problem, k.who_for, k.guidance, k.boundary, k.source_refs_json, k.source_quote,
              o.name AS boundary_offer
         FROM knowledge_items k
         LEFT JOIN offers o ON o.id = k.boundary_offer_id
        WHERE k.creator_id = ? ORDER BY k.created_at`,
    )
    .all(c.req.param('id'));
  return c.json({ count: rows.length, items: rows });
});

// -------------------------------------------------------------- the brain --

/**
 * Runs the whole inbound pipeline without sending anything.
 *
 * This is the product's brain with the email transport removed: identify the
 * prospect by sender address, load their history, retrieve, reply, capture
 * signals, score. When a domain exists, the `email()` handler becomes a thin
 * wrapper that calls straight through to this same path — so what is verified
 * here is what will run in production, not a stand-in for it.
 *
 * It doubles as the creator's onboarding preview: they email their own inbox,
 * read the reply, and correct anything that does not sound like them.
 */
leadgenRoute.post('/api/leadgen/simulate', async (c) => {
  const db = wrapD1(c.env.DB);
  const b = (await c.req.json().catch(() => ({}))) as {
    creator_id?: string;
    from_email?: string;
    from_name?: string;
    subject?: string;
    text?: string;
    persist?: boolean;
  };

  const creatorId = String(b.creator_id ?? '');
  const email = String(b.from_email ?? '').trim().toLowerCase();
  const question = String(b.text ?? '').trim();
  if (!creatorId || !email || !question) {
    return c.json({ error: 'creator_id, from_email and text are required' }, 400);
  }

  let result;
  try {
    result = await runLeadgenPipeline({
      db,
      apiBase: c.env.XAI_API_BASE,
      apiKey: c.env.XAI_API_KEY,
      model: c.env.XAI_TEXT_MODEL,
      publicBaseUrl: c.env.PUBLIC_BASE_URL,
      mcpTokenSecret: c.env.MCP_TOKEN_SECRET,
      creatorId,
      fromEmail: email,
      fromName: b.from_name,
      subject: b.subject,
      text: question,
      persist: b.persist,
    });
  } catch (err) {
    if (err instanceof CreatorNotFoundError) return c.json({ error: 'creator not found' }, 404);
    throw err;
  }

  return c.json({
    reply: result.reply,
    signals: result.signals,
    routed_offer_id: result.routedOfferId,
    knowledge_used: result.knowledgeUsed,
    prospect_id: result.prospectId,
    usage: result.usage,
  });
});

leadgenRoute.get('/api/creators/:id/prospects', async (c) => {
  const db = wrapD1(c.env.DB);
  const rows = await db
    .prepare(
      `SELECT id, email, name, situation, blocked_on, exchanges, hit_boundary, clicked_offer, score, last_seen_at
         FROM prospects WHERE creator_id = ? ORDER BY score DESC, last_seen_at DESC`,
    )
    .all(c.req.param('id'));
  return c.json({ count: rows.length, prospects: rows });
});

