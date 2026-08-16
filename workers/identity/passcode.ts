import type { SqlDb } from '../db/types.js';

/**
 * The identity mechanism for a caller this platform never sees caller ID
 * from — see docs/XAI-API-NOTES.md. Six digits: short enough to say or key in
 * over a phone call, long enough that guessing one against a single creator's
 * customer list isn't practical.
 */
export async function generateUniquePasscode(db: SqlDb, creatorId: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = String(Math.floor(100000 + Math.random() * 900000));
    const existing = await db
      .prepare('SELECT 1 FROM customers WHERE creator_id = ? AND passcode = ?')
      .get(creatorId, candidate);
    if (!existing) return candidate;
  }
  throw new Error('Could not generate a unique passcode after 20 attempts — creator has an unusually large customer list.');
}
