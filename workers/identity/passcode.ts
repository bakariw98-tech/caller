import type { SqlDb } from '../db/types.js';
import { generateUniqueCode } from './codes.js';

/**
 * The identity mechanism for a caller this platform never sees caller ID
 * from — see docs/XAI-API-NOTES.md. Six digits: short enough to say or key in
 * over a phone call, long enough that guessing one against a single creator's
 * customer list isn't practical.
 */
export async function generateUniquePasscode(db: SqlDb, creatorId: string): Promise<string> {
  return generateUniqueCode(db, { table: 'customers', column: 'passcode' }, creatorId);
}
