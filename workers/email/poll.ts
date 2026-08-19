import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { now } from '../../src/util/ids.js';
import {
  getAccessToken,
  getProfile,
  listNewInboxMessages,
  getMessage,
  buildRawMessage,
  sendMessage,
  HistoryGapError,
} from './gmail.js';
import { CreatorNotFoundError } from '../leadgen/pipeline.js';
import { routeInboundMessage } from '../leadgen/inbound.js';

interface ConnectionRow {
  id: string;
  creator_id: string;
  gmail_address: string;
  refresh_token: string;
  history_id: string;
}

export interface PollSummary {
  connectionsChecked: number;
  messagesProcessed: number;
  errors: { creatorId: string; detail: string }[];
}

/** How long a claim on a connection holds, in seconds — comfortably longer than one poll should ever take. */
const LOCK_SECONDS = 55;

/**
 * Automated-sender addresses that can never be a real prospect, by the
 * universal "do not reply to this mailbox" convention.
 *
 * Added after this poller answered a mailer-daemon bounce, a Reddit
 * notification, an Instacart promo, and an Indeed job alert as if each were
 * a lead — real xAI cost spent on mail nobody will ever read a reply to,
 * against a personal inbox that (like most real inboxes) has this kind of
 * mail mixed in with real correspondence. Deliberately narrow: this catches
 * the "structurally cannot be a person" case via the local-part convention,
 * not an attempt at general mail classification, which is a much fuzzier
 * problem this is not trying to solve.
 */
export const AUTOMATED_SENDER_PATTERN = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster)@/i;

/**
 * One pass over every connected creator's inbox: whatever's new since the
 * stored cursor gets run through the pipeline and answered.
 *
 * Best-effort, at-most-once: a message that fails mid-pipeline is logged and
 * skipped rather than retried, and the cursor still advances past it. The
 * alternative — holding the cursor back until every message in a batch
 * succeeds — would mean one permanently-failing message (a malformed sender
 * header, a since-deleted offer) blocks every message that arrives after it,
 * forever. That failure mode is worse than occasionally losing a retry, and
 * the fix if this ever matters is a dead-letter log, not more elaborate
 * cursor logic, which is why this stays this simple until real volume shows
 * it needs to be more.
 */
export async function pollAllConnections(env: Env): Promise<PollSummary> {
  const db = wrapD1(env.DB);
  const connections = await db.prepare('SELECT * FROM email_connections').all<ConnectionRow>();

  const summary: PollSummary = { connectionsChecked: connections.length, messagesProcessed: 0, errors: [] };
  const oauth = { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET };

  for (const conn of connections) {
    // Compare-and-swap claim, not just an application-level check: two
    // overlapping poll runs (the Cron Trigger firing while a manual
    // /api/admin/email/poll is still in flight, or one poll simply taking
    // longer than the cron interval) previously both saw the same "new"
    // message before either had written a row, both passed the
    // source_message_id dedupe check, and both sent a reply — observed
    // live, not hypothetical: the same inbound message answered twice,
    // seconds apart, with two different AI-generated replies to a real
    // person. The UPDATE below only succeeds for the caller that wins the
    // race; `changes === 0` means someone else is already holding it.
    const claim = await db
      .prepare(
        `UPDATE email_connections SET locked_until = ?
           WHERE id = ? AND (locked_until IS NULL OR locked_until < ?)`,
      )
      .run(now() + LOCK_SECONDS, conn.id, now());
    if (claim.changes === 0) continue;

    try {
      await pollOneConnection(env, db, conn, oauth, summary);
    } catch (err) {
      console.error(`gmail poll failed for creator ${conn.creator_id}`, err);
      summary.errors.push({ creatorId: conn.creator_id, detail: err instanceof Error ? err.message : String(err) });
    } finally {
      // Always release, success or failure — an uncleared lock would mean
      // one crashed poll permanently stops this connection from ever being
      // checked again.
      await db.prepare('UPDATE email_connections SET locked_until = NULL WHERE id = ?').run(conn.id);
    }
  }

  return summary;
}

async function pollOneConnection(
  env: Env,
  db: ReturnType<typeof wrapD1>,
  conn: ConnectionRow,
  oauth: { clientId: string; clientSecret: string },
  summary: PollSummary,
): Promise<void> {
  const accessToken = await getAccessToken(oauth, conn.refresh_token);

  let history;
  try {
    history = await listNewInboxMessages(accessToken, conn.history_id);
  } catch (err) {
    if (!(err instanceof HistoryGapError)) throw err;
    // The stored cursor is too old for Gmail to diff from. Anything sent
    // during the gap is missed, but resetting from a fresh profile is the
    // only way to stop permanently failing on every subsequent poll.
    console.error(`gmail history cursor stale for creator ${conn.creator_id}, resetting`);
    const profile = await getProfile(accessToken);
    await db.prepare('UPDATE email_connections SET history_id = ? WHERE id = ?').run(profile.historyId, conn.id);
    return;
  }

  for (const gmailId of history.newMessageIds) {
    try {
      const inbound = await getMessage(accessToken, gmailId);
      // The real "is this actually a new inbound lead" check. history.list
      // only returns candidate ids now — see listNewInboxMessages — so this
      // fetch is where INBOX membership is actually confirmed, and where a
      // message that got archived, trashed, or was never in INBOX to begin
      // with (a SENT or DRAFT event surfaced as a candidate) gets filtered out.
      if (!inbound.labelIds.includes('INBOX')) continue;
      // Defensive: INBOX shouldn't contain the account's own sent mail, but a
      // filter/forwarding rule on the connected account could put it there,
      // and replying to ourselves is exactly the kind of loop worth guarding
      // against cheaply.
      if (inbound.from === conn.gmail_address.toLowerCase()) continue;
      // Bounces, notifications and promos are not leads — see AUTOMATED_SENDER_PATTERN.
      if (AUTOMATED_SENDER_PATTERN.test(inbound.from)) continue;

      // Never email someone who asked to be left alone — checked before any
      // work is done, so an opted-out sender costs nothing and can never
      // receive a reply even if a later message from them looks like a
      // question.
      const optedOut = await db
        .prepare('SELECT 1 FROM prospects WHERE creator_id = ? AND email = ? AND opted_out = 1 LIMIT 1')
        .get(conn.creator_id, inbound.from);
      if (optedOut) continue;

      // Idempotency: candidates are deliberately over-collected (see
      // listNewInboxMessages), so the same real message can legitimately
      // surface again on a later poll — e.g. our own reply changes the
      // thread's read state, which itself is a history event. Without this,
      // that resurfacing would generate a second reply to the same email.
      const already = await db
        .prepare('SELECT 1 FROM prospect_messages WHERE creator_id = ? AND source_message_id = ? LIMIT 1')
        .get(conn.creator_id, gmailId);
      if (already) continue;

      const result = await routeInboundMessage({
        db,
        ai: env.AI,
        apiBase: env.XAI_API_BASE,
        apiKey: env.XAI_API_KEY,
        model: env.XAI_TEXT_MODEL,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        mcpTokenSecret: env.MCP_TOKEN_SECRET,
        creatorId: conn.creator_id,
        fromEmail: inbound.from,
        fromName: inbound.fromName,
        subject: inbound.subject,
        sourceMessageId: gmailId,
        text: inbound.text,
      });

      // An empty reply is the pipeline signalling "send nothing" — currently
      // an opt-out. Record it, do not mail it.
      if (!result.reply.trim()) continue;

      const raw = buildRawMessage({
        to: inbound.from,
        from: conn.gmail_address,
        fromName: result.creator.coach_name,
        subject: inbound.subject ? `Re: ${inbound.subject.replace(/^Re:\s*/i, '')}` : 'Re: your question',
        bodyText: result.reply,
        inReplyTo: inbound.messageId,
        references: inbound.references,
      });
      const sent = await sendMessage(accessToken, raw, inbound.threadId);
      // Thread-link the just-sent message to Gmail's own ids so a later
      // follow-up (voice escalation's post-call recap, or a next-step
      // confirmation) can reply into this same thread instead of starting a
      // disconnected new one — there's no inbound message to key off of for
      // those, unlike an ordinary reply.
      if (result.outboundMessageId) {
        await db
          .prepare('UPDATE prospect_messages SET gmail_message_id = ?, gmail_thread_id = ? WHERE id = ?')
          .run(sent.id, sent.threadId, result.outboundMessageId);
      }
      summary.messagesProcessed++;
    } catch (err) {
      if (err instanceof CreatorNotFoundError) throw err; // connection row is orphaned — surface it, don't loop forever
      console.error(`gmail message ${gmailId} failed for creator ${conn.creator_id}`, err);
      summary.errors.push({ creatorId: conn.creator_id, detail: `message ${gmailId}: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  await db
    .prepare('UPDATE email_connections SET history_id = ? WHERE id = ?')
    .run(history.latestHistoryId, conn.id);
}
