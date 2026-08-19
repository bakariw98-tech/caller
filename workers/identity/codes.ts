import type { SqlDb } from '../db/types.js';

/**
 * Shared retry-loop for generating a short, unique-per-creator numeric
 * code — six digits: short enough to say or key in over a phone call, long
 * enough that guessing one against a single creator's list isn't
 * practical.
 *
 * Two callers share this: `customers.passcode` (an existing student
 * identifying themselves on a coaching call — see
 * `workers/identity/passcode.ts`) and `prospects.call_code` (a cold
 * prospect identifying themselves on a qualification call — see
 * `workers/leadgen/inbound.ts`). Same shape, same collision handling,
 * different table — extracted here rather than duplicated so the retry
 * logic can't drift between the two.
 *
 * `table`/`column` are never taken from user input — every call site
 * passes a fixed literal, so building the query with them interpolated is
 * safe despite D1's placeholders only parameterizing values, not
 * identifiers.
 */
export interface UniqueCodeTarget {
  table: 'customers' | 'prospects';
  column: 'passcode' | 'call_code';
}

export async function generateUniqueCode(db: SqlDb, target: UniqueCodeTarget, creatorId: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = String(Math.floor(100000 + Math.random() * 900000));
    const existing = await db
      .prepare(`SELECT 1 FROM ${target.table} WHERE creator_id = ? AND ${target.column} = ?`)
      .get(creatorId, candidate);
    if (!existing) return candidate;
  }
  throw new Error(
    `Could not generate a unique code for ${target.table}.${target.column} after 20 attempts — creator has an unusually large list.`,
  );
}
