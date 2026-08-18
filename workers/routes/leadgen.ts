import { Hono } from 'hono';
import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { id, now, hmacHex } from '../../src/util/ids.js';
import type { Creator } from '../../src/domain/types.js';
import { extractFreeContent, NoUsableContentError, type FreeContentSource } from '../leadgen/extract.js';
import { runLeadgenPipeline, CreatorNotFoundError } from '../leadgen/pipeline.js';
import { embedPassages, embedQuery, embeddingTextForItem, encodeVector, decodeVector, cosineSimilarity } from '../leadgen/embeddings.js';
import { loadOffers, loadKnowledge, keywordScores, SEMANTIC_FLOOR } from '../leadgen/reply.js';

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

    // Index what was just stored. Best-effort: a failure here leaves rows
    // findable by keyword rather than losing them, and /reindex repairs it.
    try {
      await indexKnowledge(c.env, db, creatorId);
    } catch (err) {
      console.error('embedding index failed after ingest', err);
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

/**
 * Edits one knowledge item.
 *
 * Extraction is deliberately conservative and leaves gaps rather than
 * inventing, so the creator is the one who fills them — this is how a wrong
 * boundary or an awkwardly-phrased problem gets fixed without re-ingesting
 * everything. Only the fields sent are touched; `boundary: null` clears it,
 * which is the difference between "this topic pitches" and "this topic is
 * answered in full".
 */
leadgenRoute.patch('/api/creators/:id/knowledge/:itemId', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const itemId = c.req.param('itemId');
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const existing = await db
    .prepare('SELECT id FROM knowledge_items WHERE id = ? AND creator_id = ?')
    .get<{ id: string }>(itemId, creatorId);
  if (!existing) return c.json({ error: 'not found' }, 404);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (typeof b.problem === 'string' && b.problem.trim()) {
    sets.push('problem = ?');
    vals.push(b.problem.trim());
  }
  if (typeof b.guidance === 'string' && b.guidance.trim()) {
    sets.push('guidance = ?');
    vals.push(b.guidance.trim());
  }
  if ('who_for' in b) {
    sets.push('who_for = ?');
    vals.push(b.who_for ? String(b.who_for) : null);
  }
  if ('boundary' in b) {
    sets.push('boundary = ?');
    vals.push(b.boundary ? String(b.boundary) : null);
    // A boundary with no offer behind it can never route, so clearing one
    // clears the other rather than leaving a dangling half-configuration.
    if (!b.boundary) {
      sets.push('boundary_offer_id = ?');
      vals.push(null);
    }
  }
  if ('boundary_offer_id' in b) {
    sets.push('boundary_offer_id = ?');
    vals.push(b.boundary_offer_id ? String(b.boundary_offer_id) : null);
  }
  if (!sets.length) return c.json({ error: 'nothing to update' }, 400);

  vals.push(itemId);
  await db.prepare(`UPDATE knowledge_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

  // problem/guidance are exactly what the vector encodes, so an edit to either
  // invalidates it. Clear and re-index rather than leaving a vector that
  // describes text no longer in the row.
  if (typeof b.problem === 'string' || typeof b.guidance === 'string') {
    await db.prepare('UPDATE knowledge_items SET embedding = NULL WHERE id = ?').run(itemId);
    try {
      await indexKnowledge(c.env, db, creatorId);
    } catch (err) {
      console.error('re-index after edit failed', err);
    }
  }
  return c.json({ ok: true });
});

leadgenRoute.delete('/api/creators/:id/knowledge/:itemId', async (c) => {
  const db = wrapD1(c.env.DB);
  const res = await db
    .prepare('DELETE FROM knowledge_items WHERE id = ? AND creator_id = ?')
    .run(c.req.param('itemId'), c.req.param('id'));
  return c.json({ ok: true, deleted: res });
});

leadgenRoute.delete('/api/creators/:id/offers/:offerId', async (c) => {
  const db = wrapD1(c.env.DB);
  // Soft-delete: knowledge_items may still point at this offer as what lies
  // past a boundary, and hard-deleting would silently turn those into
  // boundaries that route nowhere.
  await db
    .prepare('UPDATE offers SET active = 0 WHERE id = ? AND creator_id = ?')
    .run(c.req.param('offerId'), c.req.param('id'));
  return c.json({ ok: true });
});

/** Everything the dashboard needs to render its header in one call. */
leadgenRoute.get('/api/creators/:id/overview', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const creator = await db
    .prepare('SELECT id, business_name, coach_name, audience, teaching_style, status FROM creators WHERE id = ?')
    .get<Record<string, unknown>>(creatorId);
  if (!creator) return c.json({ error: 'creator not found' }, 404);

  const conn = await db
    .prepare('SELECT gmail_address, connected_at FROM email_connections WHERE creator_id = ?')
    .get<{ gmail_address: string; connected_at: number }>(creatorId);
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM knowledge_items WHERE creator_id = ?) AS knowledge,
         (SELECT COUNT(*) FROM knowledge_items WHERE creator_id = ? AND boundary IS NOT NULL) AS boundaries,
         (SELECT COUNT(*) FROM offers WHERE creator_id = ? AND active = 1) AS offers,
         (SELECT COUNT(*) FROM prospects WHERE creator_id = ?) AS prospects`,
    )
    .get<Record<string, number>>(creatorId, creatorId, creatorId, creatorId);

  return c.json({ creator, email: conn ?? null, counts });
});

leadgenRoute.patch('/api/creators/:id/settings', async (c) => {
  const db = wrapD1(c.env.DB);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const allowed = ['business_name', 'coach_name', 'audience', 'teaching_style'];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of allowed) {
    if (key in b) {
      sets.push(`${key} = ?`);
      vals.push(b[key] ? String(b[key]) : null);
    }
  }
  if (!sets.length) return c.json({ error: 'nothing to update' }, 400);
  vals.push(now(), c.req.param('id'));
  await db.prepare(`UPDATE creators SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals);
  return c.json({ ok: true });
});


/**
 * Embeds every knowledge item for a creator that does not yet have a vector.
 *
 * Batched because the model accepts arrays and one round trip for twenty items
 * beats twenty round trips. Only un-indexed rows are touched, so this is safe
 * to call repeatedly and cheap when there is nothing to do.
 */
async function indexKnowledge(
  env: Env,
  db: ReturnType<typeof wrapD1>,
  creatorId: string,
  force = false,
): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT id, problem, guidance FROM knowledge_items
        WHERE creator_id = ?${force ? '' : ' AND embedding IS NULL'}`,
    )
    .all<{ id: string; problem: string; guidance: string }>(creatorId);
  if (!rows.length) return 0;

  const BATCH = 20;
  let indexed = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vectors = await embedPassages(
      env.AI as unknown as Parameters<typeof embedPassages>[0],
      chunk.map((r) => embeddingTextForItem(r.problem, r.guidance)),
    );
    for (let j = 0; j < chunk.length; j++) {
      const vec = vectors[j];
      const row = chunk[j];
      if (!vec || !row) continue;
      await db.prepare('UPDATE knowledge_items SET embedding = ? WHERE id = ?').run(encodeVector(vec), row.id);
      indexed++;
    }
  }
  return indexed;
}

/**
 * Backfills embeddings. `?force=1` re-embeds everything, which is what to use
 * after changing the embedding model — stale vectors from a different model
 * are not comparable to fresh ones and silently degrade retrieval.
 */
leadgenRoute.post('/api/creators/:id/reindex', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const force = c.req.query('force') === '1';
  try {
    const indexed = await indexKnowledge(c.env, db, creatorId, force);
    const remaining = await db
      .prepare('SELECT COUNT(*) AS n FROM knowledge_items WHERE creator_id = ? AND embedding IS NULL')
      .get<{ n: number }>(creatorId);
    return c.json({ indexed, still_unindexed: remaining?.n ?? 0 });
  } catch (err) {
    console.error('reindex failed', err);
    return c.json({ error: 'reindex failed', detail: err instanceof Error ? err.message : String(err) }, 502);
  }
});


/**
 * Every item's raw similarity to a question, sorted, ignoring the floor.
 *
 * The floor is the one number in retrieval that cannot be reasoned to from
 * first principles — embedding models differ wildly in how they space
 * unrelated text, and BGE in particular compresses everything into a narrow
 * band. This endpoint is how it gets set from measurements on a real corpus
 * instead of a guess, and how a creator seeing bad retrieval can find out why.
 */
leadgenRoute.post('/api/creators/:id/retrieval-debug', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const b = (await c.req.json().catch(() => ({}))) as { text?: string };
  const question = String(b.text ?? '').trim();
  if (!question) return c.json({ error: 'text is required' }, 400);

  const rows = await loadKnowledge(db, creatorId);
  const qv = await embedQuery(c.env.AI as unknown as Parameters<typeof embedQuery>[0], question);
  const kw = keywordScores(rows, question);

  const scored = rows
    .map((r) => {
      const v = r.embedding ? decodeVector(r.embedding) : null;
      return {
        problem: r.problem.slice(0, 60),
        semantic: v ? Number(cosineSimilarity(qv, v).toFixed(4)) : null,
        keyword: kw.get(r.id) ?? 0,
      };
    })
    .sort((a, b2) => (b2.semantic ?? 0) - (a.semantic ?? 0));

  return c.json({ question, floor: SEMANTIC_FLOOR, items: scored });
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
      ai: c.env.AI,
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

