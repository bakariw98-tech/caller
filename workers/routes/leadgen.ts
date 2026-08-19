import { Hono } from 'hono';
import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { id, now, hmacHex } from '../../src/util/ids.js';
import type { Creator } from '../../src/domain/types.js';
import { extractFreeContent, NoUsableContentError, type FreeContentSource } from '../leadgen/extract.js';
import { runLeadgenPipeline, CreatorNotFoundError } from '../leadgen/pipeline.js';
import { embedPassages, embedQuery, embeddingTextForItem, encodeVector, decodeVector, cosineSimilarity } from '../leadgen/embeddings.js';
import { loadOffers, loadFullOffers, loadKnowledge, keywordScores, SEMANTIC_FLOOR } from '../leadgen/reply.js';
import { syncChannel } from '../youtube/ingest.js';
import { startWebQualificationCall } from '../telephony/qualification-call.js';
import { mintAssistantToken } from '../mcp/auth.js';
import { extractOfferDetails } from '../leadgen/offer-extract.js';
import { getTranscript } from '../youtube/client.js';
import { toCsv } from '../leadgen/csv.js';

export const leadgenRoute = new Hono<{ Bindings: Env }>();

leadgenRoute.use('/api/*', async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token) return c.json({ error: 'ADMIN_TOKEN is not configured' }, 503);
  const header = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  if (header !== token && c.req.query('key') !== token) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

// ---------------------------------------------------------------- offers --

const CTA_TIERS = new Set(['low_ticket', 'course', 'high_ticket_application', 'very_high_ticket']);

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
      `INSERT INTO offers
         (id, creator_id, kind, name, who_for, covers, price_text, url, is_free, active, created_at,
          not_who_for, objections_and_responses, recommend_when, dont_recommend_when, cta_tier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
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
      b.is_free ? 1 : 0,
      now(),
      b.not_who_for ? String(b.not_who_for) : null,
      b.objections_and_responses ? String(b.objections_and_responses) : null,
      b.recommend_when ? String(b.recommend_when) : null,
      b.dont_recommend_when ? String(b.dont_recommend_when) : null,
      CTA_TIERS.has(String(b.cta_tier)) ? String(b.cta_tier) : 'course',
    );
  return c.json({ id: offerId, name }, 201);
});

leadgenRoute.get('/api/creators/:id/offers', async (c) => {
  const db = wrapD1(c.env.DB);
  return c.json({ offers: await loadFullOffers(db, c.req.param('id')) });
});

/**
 * Pulls a draft offer record from the creator's own ingested material
 * (pasted knowledge + YouTube transcripts) by name — see
 * workers/leadgen/offer-extract.ts's own doc comment for why this returns
 * a draft rather than writing to `offers` directly. The creator reviews
 * and edits before the normal POST/PATCH offer routes ever get called.
 */
leadgenRoute.post('/api/creators/:id/offers/extract', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(creatorId);
  if (!creator) return c.json({ error: 'creator not found' }, 404);

  const b = (await c.req.json().catch(() => ({}))) as { name?: string; url?: string };
  const offerName = String(b.name ?? '').trim();
  if (!offerName) return c.json({ error: 'name is required' }, 400);

  const { draft, usage, pagesRead, scrapeErrors } = await extractOfferDetails({
    db,
    ai: c.env.AI,
    apiBase: c.env.XAI_API_BASE,
    apiKey: c.env.XAI_API_KEY,
    model: c.env.XAI_TEXT_MODEL,
    creator,
    offerName,
    offerUrl: String(b.url ?? '').trim() || undefined,
  });

  return c.json({ draft, usage, pages_read: pagesRead, scrape_errors: scrapeErrors });
});

/**
 * DIAGNOSTIC — not part of the product surface, admin-gated like
 * everything else in this file. Re-fetches specific raw transcripts
 * (which are never persisted after ingestion — see workers/youtube/
 * ingest.ts, the knowledge base only keeps the LLM's distilled
 * problem/guidance extraction) and searches them literally for a term,
 * to tell apart "genuinely not discussed" from "discussed, but the
 * ingestion extraction never captured this specific mention." Costs one
 * transcriptapi.com credit per video_id given.
 */
leadgenRoute.post('/api/creators/:id/debug-search-transcripts', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { query?: string; video_ids?: string[] };
  const query = String(b.query ?? '').trim().toLowerCase();
  const videoIds = Array.isArray(b.video_ids) ? b.video_ids : [];
  if (!query || !videoIds.length) return c.json({ error: 'query and video_ids are required' }, 400);

  const results = [];
  for (const videoId of videoIds) {
    try {
      const t = await getTranscript({ apiKey: c.env.TRANSCRIPT_API_KEY }, videoId);
      const full = t.transcript.map((s) => s.text).join(' ');
      const idx = full.toLowerCase().indexOf(query);
      results.push({
        video_id: videoId,
        found: idx !== -1,
        excerpt: idx !== -1 ? full.slice(Math.max(0, idx - 200), idx + 300) : null,
        length: full.length,
      });
    } catch (err) {
      results.push({ video_id: videoId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return c.json({ results });
});

/**
 * Sales-truth fields are the kind of thing a creator iterates on, not
 * something they get right once at creation — an allow-list PATCH, same
 * pattern as /api/creators/:id/settings below, rather than requiring a
 * delete-and-recreate for every wording tweak.
 */
leadgenRoute.patch('/api/creators/:id/offers/:offerId', async (c) => {
  const db = wrapD1(c.env.DB);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const allowed = ['name', 'who_for', 'covers', 'price_text', 'url', 'not_who_for', 'objections_and_responses', 'recommend_when', 'dont_recommend_when'];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of allowed) {
    if (key in b) {
      sets.push(`${key} = ?`);
      vals.push(b[key] ? String(b[key]) : null);
    }
  }
  if ('cta_tier' in b) {
    sets.push('cta_tier = ?');
    vals.push(CTA_TIERS.has(String(b.cta_tier)) ? String(b.cta_tier) : 'course');
  }
  if (!sets.length) return c.json({ error: 'nothing to update' }, 400);
  vals.push(c.req.param('offerId'), c.req.param('id'));
  await db.prepare(`UPDATE offers SET ${sets.join(', ')} WHERE id = ? AND creator_id = ?`).run(...vals);
  return c.json({ ok: true });
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
              k.source_url, k.tier, k.conflicts_with, o.name AS boundary_offer
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

// -------------------------------------------------------- youtube ingest --

/**
 * Enumerates and tiers a whole channel's uploads in one request — cheap
 * enough to do synchronously (~1 credit per ~100-video page). The expensive
 * part, fetching and extracting each video, is NOT done here: it is drained
 * a few videos at a time by the Cron Trigger already running for Gmail —
 * see workers/youtube/ingest.ts's processIngestBatch() and
 * workers/index.ts. Safe to call again on an already-connected channel to
 * pick up new uploads; existing rows are left untouched.
 */
leadgenRoute.post('/api/creators/:id/youtube/connect', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const creator = await db.prepare('SELECT id FROM creators WHERE id = ?').get<{ id: string }>(creatorId);
  if (!creator) return c.json({ error: 'creator not found' }, 404);
  if (!c.env.TRANSCRIPT_API_KEY) return c.json({ error: 'TRANSCRIPT_API_KEY is not configured' }, 503);

  const b = (await c.req.json().catch(() => ({}))) as { channel?: string };
  const channel = String(b.channel ?? '').trim();
  if (!channel) return c.json({ error: 'channel (a @handle or channel URL) is required' }, 400);

  try {
    const result = await syncChannel(db, creatorId, c.env.TRANSCRIPT_API_KEY, channel);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

/** Live counts for the dashboard's progress display, plus the creator's connected channel if any. */
leadgenRoute.get('/api/creators/:id/youtube/status', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const creator = await db
    .prepare('SELECT youtube_channel FROM creators WHERE id = ?')
    .get<{ youtube_channel: string | null }>(creatorId);
  if (!creator) return c.json({ error: 'creator not found' }, 404);

  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM channel_videos WHERE creator_id = ?) AS enumerated,
         (SELECT COUNT(*) FROM channel_videos WHERE creator_id = ? AND status = 'pending') AS pending,
         (SELECT COUNT(*) FROM channel_videos WHERE creator_id = ? AND status = 'done') AS done,
         (SELECT COUNT(*) FROM channel_videos WHERE creator_id = ? AND status = 'skipped') AS skipped,
         (SELECT COUNT(*) FROM channel_videos WHERE creator_id = ? AND status = 'failed') AS failed`,
    )
    .get<Record<string, number>>(creatorId, creatorId, creatorId, creatorId, creatorId);

  const conflicts = await db
    .prepare(
      // The back-pointer is set on both rows (see ingest.ts), so a plain
      // join returns each pair twice, once from each side. a.id < b.id
      // picks one direction only, since a pair has no natural "primary"
      // side — the ordering is arbitrary and just needs to be consistent.
      `SELECT a.id AS a_id, a.problem AS a_problem, a.guidance AS a_guidance, a.source_url AS a_url,
              b.id AS b_id, b.problem AS b_problem, b.guidance AS b_guidance, b.source_url AS b_url
         FROM knowledge_items a JOIN knowledge_items b ON b.id = a.conflicts_with
        WHERE a.creator_id = ? AND a.id < b.id`,
    )
    .all(creatorId);

  return c.json({ channel: creator.youtube_channel, counts, conflicts });
});

/**
 * Dismisses a conflict without picking a side — clears the back-pointer on
 * both rows so they stop appearing in the review list. Deliberately not an
 * endpoint that resolves WHICH guidance is right: see the schema comment on
 * knowledge_items.conflicts_with for why that call is the creator's alone.
 */
leadgenRoute.post('/api/creators/:id/youtube/conflicts/:knowledgeId/dismiss', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const knowledgeId = c.req.param('knowledgeId');
  const row = await db
    .prepare('SELECT conflicts_with FROM knowledge_items WHERE id = ? AND creator_id = ?')
    .get<{ conflicts_with: string | null }>(knowledgeId, creatorId);
  if (!row) return c.json({ error: 'not found' }, 404);
  await db.prepare('UPDATE knowledge_items SET conflicts_with = NULL WHERE id = ?').run(knowledgeId);
  if (row.conflicts_with) {
    await db.prepare('UPDATE knowledge_items SET conflicts_with = NULL WHERE id = ?').run(row.conflicts_with);
  }
  return c.json({ ok: true });
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
  // The funnel counts are all PEOPLE, not events, and all scoped to the
  // same PAID meaning of "presented" that offer_pitched already uses
  // (offer_pitched: pipeline.ts — a free resource is not a pitch, on
  // purpose). offer_clicks has to match that scope too, or the funnel can
  // go backwards: a prospect who only ever clicked a free video's link
  // would count as "clicked" with no "presented" above them, which is not
  // a funnel narrowing at all — observed live on the real Bakari creator
  // (1 click, 0 presented) before this join existed. offer_clicks is
  // therefore counted via a join to offers.is_free = 0, not off
  // prospects.clicked_offer directly, which does not distinguish free
  // from paid. offer_clicks (the table) stays the full, unscoped
  // event-level detail for attribution.
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM knowledge_items WHERE creator_id = ?) AS knowledge,
         (SELECT COUNT(*) FROM knowledge_items WHERE creator_id = ? AND boundary IS NOT NULL) AS boundaries,
         (SELECT COUNT(*) FROM offers WHERE creator_id = ? AND active = 1) AS offers,
         (SELECT COUNT(*) FROM prospects WHERE creator_id = ?) AS prospects,
         (SELECT COUNT(*) FROM prospects WHERE creator_id = ?) AS leads,
         (SELECT COUNT(*) FROM prospects WHERE creator_id = ? AND qualified_at IS NOT NULL) AS qualified,
         (SELECT COUNT(*) FROM prospects WHERE creator_id = ? AND offer_pitched = 1) AS offers_presented,
         (SELECT COUNT(DISTINCT oc.prospect_id) FROM offer_clicks oc
            JOIN offers o ON o.id = oc.offer_id
           WHERE oc.creator_id = ? AND o.is_free = 0) AS offer_clicks,
         (SELECT COUNT(*) FROM prospects WHERE creator_id = ? AND first_seen_at >= ?) AS leads_last_30d`,
    )
    .get<Record<string, number>>(
      creatorId,
      creatorId,
      creatorId,
      creatorId,
      creatorId,
      creatorId,
      creatorId,
      creatorId,
      creatorId,
      now() - 30 * 86400,
    );

  const voiceRow = await db
    .prepare('SELECT voice_qualification_mode, objection_handling_posture FROM creators WHERE id = ?')
    .get<{ voice_qualification_mode: number; objection_handling_posture: string }>(creatorId);
  const qualifyNumber = await db
    .prepare("SELECT e164 FROM phone_numbers WHERE creator_id = ? AND purpose = 'qualify' LIMIT 1")
    .get<{ e164: string }>(creatorId);

  const since30d = now() - 30 * 86400;
  // Rolling 30 days, matching leads_last_30d above. Every count here is
  // PEOPLE or CALLS, never a rate presented as if it were a fact on its
  // own — see the dashboard's own framing rule: lead with "voluntarily
  // took the next step", never a bare "qualification rate", which is
  // gameable by loosening the bar in a way a count of real actions is not.
  interface VoiceFunnelRow {
    invitations_sent: number;
    calls_accepted: number;
    calls_started: number;
    calls_completed: number;
    qualified_conversations: number;
    offers_presented: number;
    objections_raised: number;
    next_steps_accepted: number;
    cost_cents_estimate: number;
  }
  const voice = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM prospects WHERE creator_id = ? AND call_code_issued_at >= ?) AS invitations_sent,
         (SELECT COUNT(DISTINCT c.prospect_id) FROM calls c
            WHERE c.creator_id = ? AND c.kind = 'qualification' AND c.started_at >= ? AND c.prospect_id IS NOT NULL) AS calls_accepted,
         (SELECT COUNT(*) FROM calls WHERE creator_id = ? AND kind = 'qualification' AND started_at >= ?) AS calls_started,
         (SELECT COUNT(*) FROM calls WHERE creator_id = ? AND kind = 'qualification' AND started_at >= ? AND status = 'ended') AS calls_completed,
         (SELECT COUNT(DISTINCT c.prospect_id) FROM calls c JOIN prospects p ON p.id = c.prospect_id
            WHERE c.creator_id = ? AND c.kind = 'qualification' AND c.started_at >= ? AND p.qualified_at IS NOT NULL) AS qualified_conversations,
         (SELECT COUNT(*) FROM calls WHERE creator_id = ? AND kind = 'qualification' AND started_at >= ? AND offer_presented = 1) AS offers_presented,
         (SELECT COUNT(*) FROM calls WHERE creator_id = ? AND kind = 'qualification' AND started_at >= ? AND objection_raised = 1) AS objections_raised,
         (SELECT COUNT(*) FROM calls WHERE creator_id = ? AND kind = 'qualification' AND started_at >= ? AND next_step_accepted = 1) AS next_steps_accepted,
         (SELECT COALESCE(SUM(cost_cents_estimate), 0) FROM calls WHERE creator_id = ? AND kind = 'qualification' AND started_at >= ?) AS cost_cents_estimate`,
    )
    .get<VoiceFunnelRow>(
      creatorId, since30d,
      creatorId, since30d,
      creatorId, since30d,
      creatorId, since30d,
      creatorId, since30d,
      creatorId, since30d,
      creatorId, since30d,
      creatorId, since30d,
      creatorId, since30d,
    );

  // Computed here, never stored: dividing by zero is "no data yet", not a
  // cost of zero, and the plan is explicit that this must never be
  // confused with a revenue-attribution number — there is no price paid
  // signal anywhere in this platform, only cost.
  const costPerVoiceQualifiedLead =
    voice && voice.qualified_conversations > 0 ? Math.round(voice.cost_cents_estimate / voice.qualified_conversations) : null;

  return c.json({
    creator,
    email: conn ?? null,
    counts,
    voice: {
      enabled: Boolean(voiceRow?.voice_qualification_mode),
      objection_handling_posture: voiceRow?.objection_handling_posture ?? 'soft',
      qualify_number: qualifyNumber?.e164 ?? null,
      funnel: voice ?? null,
      cost_per_voice_qualified_lead_cents: costPerVoiceQualifiedLead,
    },
  });
});

/**
 * Refuses to enable unless a qualify number and a Gmail connection both
 * already exist — closing the exact misconfiguration gap
 * routeInboundMessage() otherwise only detects at send time (see
 * workers/leadgen/inbound.ts's console.error fallback). Disabling has no
 * such requirement.
 */
leadgenRoute.patch('/api/creators/:id/voice-qualification', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const b = (await c.req.json().catch(() => ({}))) as { enabled?: boolean; objection_handling_posture?: string };

  if (b.enabled) {
    const qualifyNumber = await db
      .prepare("SELECT 1 FROM phone_numbers WHERE creator_id = ? AND purpose = 'qualify' LIMIT 1")
      .get(creatorId);
    const gmail = await db.prepare('SELECT 1 FROM email_connections WHERE creator_id = ?').get(creatorId);
    if (!qualifyNumber) return c.json({ error: 'Add a qualify-purpose phone number before enabling voice escalation.' }, 400);
    if (!gmail) return c.json({ error: 'Connect Gmail before enabling voice escalation — the hook email needs somewhere to send from.' }, 400);
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  if ('enabled' in b) {
    sets.push('voice_qualification_mode = ?');
    vals.push(b.enabled ? 1 : 0);
  }
  if (b.objection_handling_posture === 'soft' || b.objection_handling_posture === 'assertive') {
    sets.push('objection_handling_posture = ?');
    vals.push(b.objection_handling_posture);
  }
  if (!sets.length) return c.json({ error: 'nothing to update' }, 400);
  vals.push(creatorId);
  await db.prepare(`UPDATE creators SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return c.json({ ok: true });
});

/**
 * A browser-based way to try the qualification call live, with no phone
 * number involved — see workers/routes/talk.ts and
 * startWebQualificationCall()'s own doc comments for why this exists.
 * Does NOT require voice_qualification_mode to be on: this is a creator
 * previewing/testing the call itself, the same relationship
 * /api/leadgen/simulate has to the email reply.
 */
leadgenRoute.post('/api/creators/:id/qualification-link', async (c) => {
  const db = wrapD1(c.env.DB);
  const result = await startWebQualificationCall(db, c.env, c.req.param('id'));
  if ('error' in result) return c.json(result, 404);
  const url = `${c.env.PUBLIC_BASE_URL}/talk/${result.callId}?token=${encodeURIComponent(result.mcpToken)}`;
  return c.json({ url });
});

/**
 * Mints a fresh, short-lived (1h) assistant credential and returns the
 * browser session link — the dashboard's "Talk to your assistant" button
 * calls this, mirroring qualification-link just above. Deliberately
 * separate from Part 3's durable creator_mcp_keys mint: a voice session
 * from the dashboard should not create a long-lived credential a creator
 * never explicitly asked for, and a pasted-into-an-agent key should not
 * silently expire mid-use.
 */
leadgenRoute.post('/api/creators/:id/assistant/link', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const creator = await db.prepare('SELECT id FROM creators WHERE id = ?').get<{ id: string }>(creatorId);
  if (!creator) return c.json({ error: 'creator not found' }, 404);

  const token = await mintAssistantToken(db, c.env.MCP_TOKEN_SECRET, { creatorId, ttlSeconds: 3600 });
  const url = `${c.env.PUBLIC_BASE_URL}/assistant/${creatorId}?token=${encodeURIComponent(token)}`;
  return c.json({ url });
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
/**
 * Exported (was module-private) so workers/mcp/assistant-tools.ts's
 * edit_knowledge_item tool can re-embed an edited item through the exact
 * same code path this route already uses — re-embedding is the one piece
 * of this logic that genuinely cannot drift between the two callers
 * without silently leaving a voice-edited item unsearchable.
 */
export async function indexKnowledge(
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

/**
 * The full lead record — every field the conversation has enriched, not
 * just what fits in a table row. This is the product's actual output: a
 * cold email address turned into a sales-ready context package (situation,
 * real problem, goal, what they tried, what's in the way, how much they
 * know, urgency, objections) rather than a chat transcript the creator has
 * to re-read to extract the same thing.
 */
leadgenRoute.get('/api/creators/:id/prospects', async (c) => {
  const db = wrapD1(c.env.DB);
  const rows = await db
    .prepare(
      `SELECT id, email, name, situation, diagnosed_problem, goal, tried, blocked_on,
              knowledge_level, urgency, objections_json, topics_json,
              exchanges, hit_boundary, requested_offer, offer_pitched, clicked_offer,
              score, first_seen_at, last_seen_at, qualified_at
         FROM prospects WHERE creator_id = ? ORDER BY score DESC, last_seen_at DESC`,
    )
    .all(c.req.param('id'));
  return c.json({ count: rows.length, prospects: rows });
});

/**
 * The same lead record as GET /prospects, as a file. See csv.ts for why the
 * escaping matters here specifically — every field below is free text
 * written by a cold prospect, not app-generated data.
 */
leadgenRoute.get('/api/creators/:id/prospects.csv', async (c) => {
  const db = wrapD1(c.env.DB);
  const rows = await db
    .prepare(
      `SELECT email, name, situation, diagnosed_problem, goal, tried, blocked_on,
              knowledge_level, urgency, objections_json, topics_json,
              exchanges, hit_boundary, requested_offer, offer_pitched, clicked_offer,
              score, first_seen_at, last_seen_at, qualified_at
         FROM prospects WHERE creator_id = ? ORDER BY score DESC, last_seen_at DESC`,
    )
    .all<Record<string, unknown>>(c.req.param('id'));

  const isoOrEmpty = (epochSeconds: unknown) =>
    typeof epochSeconds === 'number' ? new Date(epochSeconds * 1000).toISOString() : '';
  const yesNo = (v: unknown) => (v ? 'Yes' : 'No');
  const joinList = (json: unknown) => {
    if (typeof json !== 'string') return '';
    try {
      const parsed = JSON.parse(json);
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string').join('; ') : '';
    } catch {
      return '';
    }
  };

  const flat = rows.map((r) => ({
    email: r.email,
    name: r.name ?? '',
    situation: r.situation ?? '',
    real_problem: r.diagnosed_problem ?? '',
    goal: r.goal ?? '',
    tried: r.tried ?? '',
    blocked_on: r.blocked_on ?? '',
    experience_level: r.knowledge_level ?? '',
    urgency: r.urgency ?? '',
    objections: joinList(r.objections_json),
    topics: joinList(r.topics_json),
    emails_exchanged: r.exchanges,
    hit_content_boundary: yesNo(r.hit_boundary),
    requested_offer: yesNo(r.requested_offer),
    offer_presented: yesNo(r.offer_pitched),
    offer_clicked: yesNo(r.clicked_offer),
    score: r.score,
    first_seen_at: isoOrEmpty(r.first_seen_at),
    last_seen_at: isoOrEmpty(r.last_seen_at),
    qualified_at: isoOrEmpty(r.qualified_at),
  }));

  const csv = toCsv(flat, [
    { key: 'email', header: 'Email' },
    { key: 'name', header: 'Name' },
    { key: 'situation', header: 'Situation' },
    { key: 'real_problem', header: 'Real problem' },
    { key: 'goal', header: 'Goal' },
    { key: 'tried', header: 'Tried' },
    { key: 'blocked_on', header: 'Blocked on' },
    { key: 'experience_level', header: 'Experience level' },
    { key: 'urgency', header: 'Urgency' },
    { key: 'objections', header: 'Objections' },
    { key: 'topics', header: 'Topics asked about' },
    { key: 'emails_exchanged', header: 'Emails exchanged' },
    { key: 'hit_content_boundary', header: 'Hit content boundary' },
    { key: 'requested_offer', header: 'Requested offer' },
    { key: 'offer_presented', header: 'Offer presented' },
    { key: 'offer_clicked', header: 'Offer clicked' },
    { key: 'score', header: 'Score' },
    { key: 'first_seen_at', header: 'First seen' },
    { key: 'last_seen_at', header: 'Last seen' },
    { key: 'qualified_at', header: 'Qualified since' },
  ]);

  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="leads-${c.req.param('id')}.csv"`);
  return c.body(csv);
});

