import type { SqlDb } from '../db/types.js';
import type { Env } from '../env.js';
import { id, now } from '../../src/util/ids.js';
import {
  resolveChannel,
  listChannelVideos,
  getTranscript,
  parseLengthText,
  TranscriptApiQuotaError,
  type ChannelVideoRaw,
} from './client.js';
import { tierVideo } from './tier.js';
import { extractFreeContent, NoUsableContentError, type FreeContentSource } from '../leadgen/extract.js';
import { loadKnowledge, loadOffers } from '../leadgen/reply.js';
import { embedPassages, embeddingTextForItem, encodeVector, decodeVector } from '../leadgen/embeddings.js';
import { decideDedupe, mergeSourceRefs, type ExistingKnowledgeForDedupe } from '../leadgen/dedupe.js';

/**
 * Whole-channel YouTube ingestion: enumerate cheaply, tier for free, then
 * let the existing Cron Trigger drain the expensive part (transcript +
 * extraction + dedup) a few videos at a time. See the ingestion plan for
 * the acquisition-order and cost reasoning; this module is where it runs.
 */

function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export interface SyncResult {
  channelId: string;
  enumerated: number;
  tier1: number;
  tier2: number;
  skipped: number;
}

/**
 * Enumerates a channel's full upload history and stores one row per video,
 * tiered from free metadata. Runs to completion in one call rather than
 * across cron ticks — unlike per-video processing, this is cheap (~1
 * credit/page) and bounded (a handful of sequential fetches even for a
 * channel with hundreds of videos), so there is no reason to defer it.
 *
 * Safe to call again on an already-synced channel: `INSERT OR IGNORE`
 * against the (creator_id, video_id) unique constraint means new uploads
 * since the last sync are added and existing rows are left untouched —
 * re-syncing never resets a video that already finished processing.
 */
export async function syncChannel(db: SqlDb, creatorId: string, apiKey: string, channelInput: string): Promise<SyncResult> {
  const resolved = await resolveChannel({ apiKey }, channelInput);
  const channelId = resolved.channel_id;

  await db.prepare('UPDATE creators SET youtube_channel = ? WHERE id = ?').run(channelId, creatorId);

  let page = await listChannelVideos({ apiKey }, { channel: channelId });
  let enumerated = 0;
  let tier1 = 0;
  let tier2 = 0;
  let skipped = 0;

  // Bounded by the channel's own page count via has_more/continuation_token
  // — not an arbitrary cap. transcriptapi.com's own pagination is what ends
  // this loop.
  for (;;) {
    for (const raw of page.results as ChannelVideoRaw[]) {
      const lengthSeconds = parseLengthText(raw.lengthText);
      const { tier } = tierVideo({ title: raw.title, lengthSeconds });
      const status = tier === 3 ? 'skipped' : 'pending';
      await db
        .prepare(
          `INSERT INTO channel_videos
             (id, creator_id, video_id, title, url, length_seconds, tier, status, discovered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (creator_id, video_id) DO NOTHING`,
        )
        .run(id('vid'), creatorId, raw.videoId, raw.title, videoUrl(raw.videoId), lengthSeconds, tier, status, now());
      enumerated++;
      if (tier === 1) tier1++;
      else if (tier === 2) tier2++;
      else skipped++;
    }
    if (!page.has_more || !page.continuation_token) break;
    page = await listChannelVideos({ apiKey }, { continuation: page.continuation_token });
  }

  return { channelId, enumerated, tier1, tier2, skipped };
}

/** How long a claim on one video holds — comfortably longer than one video's transcript+extraction+embedding should ever take. */
const VIDEO_LOCK_SECONDS = 55;
/** A video that fails this many times is marked permanently failed rather than retried forever — see poll.ts's identical reasoning for messages. */
const MAX_ATTEMPTS = 3;
/** Videos processed per cron tick. Small deliberately: each one is a transcript fetch, an xAI extraction call, and an embedding call — not cheap like the Gmail poll's per-message work. */
const BATCH_SIZE = 3;

export interface IngestTickSummary {
  processed: number;
  merged: number;
  conflicts: number;
  failed: number;
  quotaExhausted: boolean;
  costUsdMicros: number;
}

/**
 * Drains a small batch of pending videos, across every creator, per cron
 * tick — the ingestion analogue of pollAllConnections(). Same compare-and-
 * swap claim pattern as email_connections.locked_until: two overlapping
 * ticks must not both grab the same video.
 */
export async function processIngestBatch(env: Env, db: SqlDb): Promise<IngestTickSummary> {
  const summary: IngestTickSummary = {
    processed: 0,
    merged: 0,
    conflicts: 0,
    failed: 0,
    quotaExhausted: false,
    costUsdMicros: 0,
  };

  // Includes stale 'processing' rows, not just 'pending' ones — a request
  // killed mid-video by Cloudflare's own CPU/wall-time limits (a real risk
  // here: transcript fetch + xAI extraction + embedding in one job) leaves
  // a row claimed but never finished. Without this, that row is gated out
  // by status forever even once its lock expires, wedging that one video
  // permanently despite the lock itself being designed to be reclaimable.
  const candidates = await db
    .prepare(
      `SELECT id, creator_id, video_id, title, url, tier, attempts FROM channel_videos
        WHERE status IN ('pending', 'processing') AND (locked_until IS NULL OR locked_until < ?)
        ORDER BY tier ASC, discovered_at ASC LIMIT ?`,
    )
    .all<{ id: string; creator_id: string; video_id: string; title: string; url: string; tier: number; attempts: number }>(
      now(),
      BATCH_SIZE,
    );

  for (const video of candidates) {
    const claim = await db
      .prepare(
        `UPDATE channel_videos SET locked_until = ?, status = 'processing'
          WHERE id = ? AND status IN ('pending', 'processing') AND (locked_until IS NULL OR locked_until < ?)`,
      )
      .run(now() + VIDEO_LOCK_SECONDS, video.id, now());
    if (claim.changes === 0) continue; // another tick already took it

    try {
      const result = await ingestOneVideo(env, db, video);
      summary.processed++;
      summary.costUsdMicros += result.costUsdMicros;
      if (result.merged) summary.merged++;
      if (result.conflicts) summary.conflicts++;
      await db
        .prepare(
          `UPDATE channel_videos SET status = 'done', locked_until = NULL, processed_at = ?, cost_usd_micros = ? WHERE id = ?`,
        )
        .run(now(), result.costUsdMicros, video.id);
    } catch (err) {
      const attempts = video.attempts + 1;
      const isQuota = err instanceof TranscriptApiQuotaError;
      if (isQuota) summary.quotaExhausted = true;
      const message = err instanceof Error ? err.message : String(err);
      const nextStatus = isQuota || attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      if (nextStatus === 'failed') summary.failed++;
      await db
        .prepare(`UPDATE channel_videos SET status = ?, attempts = ?, last_error = ?, locked_until = NULL WHERE id = ?`)
        .run(nextStatus, attempts, message.slice(0, 500), video.id);
      console.error(`video ingest failed for ${video.video_id} (creator ${video.creator_id})`, err);
      if (isQuota) break; // no point trying the rest of the batch with an empty account
    }
  }

  return summary;
}

async function ingestOneVideo(
  env: Env,
  db: SqlDb,
  video: { id: string; creator_id: string; video_id: string; title: string; url: string; tier: number },
): Promise<{ merged: number; conflicts: number; costUsdMicros: number }> {
  const transcript = await getTranscript({ apiKey: env.TRANSCRIPT_API_KEY }, video.video_id);
  const text = transcript.transcript.map((seg) => seg.text).join(' ');

  const source: FreeContentSource = { kind: 'video_transcript', title: video.title, url: video.url, text };
  const offers = await loadOffers(db, video.creator_id);

  let extraction;
  try {
    extraction = await extractFreeContent({
      apiBase: env.XAI_API_BASE,
      apiKey: env.XAI_API_KEY,
      model: env.XAI_TEXT_MODEL,
      sources: [source],
      offers: offers.map((o) => ({ id: o.id, name: o.name, who_for: o.who_for, covers: o.covers })),
    });
  } catch (err) {
    // A transcript with nothing extractable (music, a trailer with no
    // spoken teaching) is a normal outcome, not a failure to retry —
    // NoUsableContentError specifically means "nothing was there", so this
    // video is done, just with zero items.
    if (err instanceof NoUsableContentError) return { merged: 0, conflicts: 0, costUsdMicros: 0 };
    throw err;
  }

  // Same units prospect_messages.cost_usd_micros already uses — this
  // product pays for its own inference on both sides (replies AND
  // ingestion), so cost per video has to be a measured number, not an
  // estimate discovered afterwards. Embedding calls are not tracked here,
  // matching reply.ts's existing usage tracking, which only covers the
  // xAI text-generation calls.
  const costUsdMicros = Math.round(extraction.usage.costUsd * 1e6);

  if (!extraction.items.length) return { merged: 0, conflicts: 0, costUsdMicros };

  const offerIdByName = new Map(offers.map((o) => [o.name.toLowerCase(), o.id]));
  const vectors = await embedPassages(
    env.AI as unknown as Parameters<typeof embedPassages>[0],
    extraction.items.map((item) => embeddingTextForItem(item.problem, item.guidance)),
  );

  let merged = 0;
  let conflicts = 0;

  for (let i = 0; i < extraction.items.length; i++) {
    const item = extraction.items[i]!;
    const vec = vectors[i];
    if (!vec) continue;

    // Re-loaded per item rather than once per video: an earlier item in
    // this same loop may have just been inserted, and a later item in the
    // same transcript restating it should merge against that new row too,
    // not just against rows from before this video started.
    const existingRows = await loadKnowledge(db, video.creator_id);
    const existing: ExistingKnowledgeForDedupe[] = existingRows
      .map((r) => {
        const ev = r.embedding ? decodeVector(r.embedding) : null;
        return ev ? { id: r.id, guidance: r.guidance, embedding: ev } : null;
      })
      .filter((x): x is ExistingKnowledgeForDedupe => x !== null);

    const decision = decideDedupe({ problem: item.problem, guidance: item.guidance, embedding: vec }, existing);
    const boundaryOfferId = item.boundary_offer_name
      ? (offerIdByName.get(item.boundary_offer_name.trim().toLowerCase()) ?? null)
      : null;

    if (decision.action === 'merge') {
      merged++;
      // loadKnowledge()'s SELECT does not carry source_refs_json — it is
      // not needed for reply generation — so it is fetched directly here
      // rather than widening that shared query for this one caller.
      const target = await db
        .prepare('SELECT source_refs_json FROM knowledge_items WHERE id = ?')
        .get<{ source_refs_json: string }>(decision.matchId);
      const refsJson = mergeSourceRefs(target?.source_refs_json ?? '[]', [video.title]);
      await db.prepare(`UPDATE knowledge_items SET source_refs_json = ? WHERE id = ?`).run(refsJson, decision.matchId);
      continue;
    }

    const newId = id('kn');
    if (decision.action === 'conflict') conflicts++;

    // Insert BEFORE linking the existing row back to it — conflicts_with
    // has a foreign key onto knowledge_items(id), and SQLite enforces FK
    // constraints immediately rather than deferring to commit, so pointing
    // the existing row at newId before newId exists fails outright. Found
    // live: every conflict decision on the real channel errored with
    // "FOREIGN KEY constraint failed" until this was reordered.
    await db
      .prepare(
        `INSERT INTO knowledge_items
           (id, creator_id, problem, who_for, guidance, framework_terms_json, source_refs_json,
            source_quote, boundary, boundary_offer_id, source_url, tier, conflicts_with, embedding, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId,
        video.creator_id,
        item.problem,
        item.who_for ?? null,
        item.guidance,
        JSON.stringify(item.framework_terms ?? []),
        JSON.stringify([video.title]),
        item.source_quote ?? null,
        item.boundary ?? null,
        boundaryOfferId,
        video.url,
        video.tier,
        decision.action === 'conflict' ? decision.matchId : null,
        encodeVector(vec),
        now(),
      );

    if (decision.action === 'conflict') {
      // Only set the existing row's back-pointer if it does not already
      // have one — first conflict found wins the link rather than a later
      // one silently overwriting it, matching this codebase's existing
      // COALESCE-style "don't clobber what's already been recorded"
      // convention (see pipeline.ts's COALESCE merge).
      await db
        .prepare(`UPDATE knowledge_items SET conflicts_with = COALESCE(conflicts_with, ?) WHERE id = ?`)
        .run(newId, decision.matchId);
    }
  }

  return { merged, conflicts, costUsdMicros };
}
