import type { SqlDb } from '../db/types.js';
import { now } from '../../src/util/ids.js';

/** Async D1 version of src/xai/webhook.ts's claimWebhookId — same replay-guard purpose. */
export async function claimWebhookId(db: SqlDb, webhookId: string, eventType: string): Promise<boolean> {
  try {
    await db
      .prepare('INSERT INTO webhook_events (webhook_id, event_type, seen_at) VALUES (?, ?, ?)')
      .run(webhookId, eventType, now());
    return true;
  } catch {
    return false; // UNIQUE violation: already handled.
  }
}
