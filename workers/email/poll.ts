import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import {
  getAccessToken,
  getProfile,
  listNewInboxMessages,
  getMessage,
  buildRawMessage,
  sendMessage,
  HistoryGapError,
} from './gmail.js';
import { runLeadgenPipeline, CreatorNotFoundError } from '../leadgen/pipeline.js';

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
    try {
      await pollOneConnection(env, db, conn, oauth, summary);
    } catch (err) {
      console.error(`gmail poll failed for creator ${conn.creator_id}`, err);
      summary.errors.push({ creatorId: conn.creator_id, detail: err instanceof Error ? err.message : String(err) });
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
      // Defensive: INBOX shouldn't contain the account's own sent mail, but a
      // filter/forwarding rule on the connected account could put it there,
      // and replying to ourselves is exactly the kind of loop worth guarding
      // against cheaply.
      if (inbound.from === conn.gmail_address.toLowerCase()) continue;

      const result = await runLeadgenPipeline({
        db,
        apiBase: env.XAI_API_BASE,
        apiKey: env.XAI_API_KEY,
        model: env.XAI_TEXT_MODEL,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        mcpTokenSecret: env.MCP_TOKEN_SECRET,
        creatorId: conn.creator_id,
        fromEmail: inbound.from,
        fromName: inbound.fromName,
        subject: inbound.subject,
        text: inbound.text,
      });

      const raw = buildRawMessage({
        to: inbound.from,
        from: conn.gmail_address,
        fromName: result.creator.coach_name,
        subject: inbound.subject ? `Re: ${inbound.subject.replace(/^Re:\s*/i, '')}` : 'Re: your question',
        bodyText: result.reply,
        inReplyTo: inbound.messageId,
        references: inbound.references,
      });
      await sendMessage(accessToken, raw, inbound.threadId);
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
