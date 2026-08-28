/**
 * Produces a SQL script that seeds a demo creator, course and customer in D1,
 * by running the exact same logic paths (ingestCourse, wallet, transitions)
 * that production uses — recorded against a throwaway in-memory SQLite
 * database instead of hand-written by comparison, so the seeded data is
 * guaranteed structurally consistent with what a real call would produce.
 *
 * Run with: npx tsx workers/scripts/seed-via-d1.ts > /tmp/seed.sql
 * Then the statements are executed against the real D1 database via the
 * Cloudflare MCP tool (see docs/DEPLOY.md) — this script only *generates*
 * SQL, it never touches the network or the real database itself.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import type { SqlDb, SqlStatement } from '../db/types.js';
import { id, now } from '../../src/util/ids.js';
import { parseCurriculumMarkdown } from '../../src/curriculum/parse-markdown.js';
import { ingestCourse } from '../curriculum/ingest.js';
import { createBudget } from '../billing/promotional.js';
import { topUp } from '../billing/wallet.js';
import { getOrCreateEnrollment, appendTransition, completeAndAdvance } from '../state/transitions.js';
import { firstStep, nextStep } from '../curriculum/repository.js';

const recorded: { sql: string; params: unknown[] }[] = [];

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Records every write while executing reads for real against an in-memory mirror, so decisions (like version lookups) stay correct. */
function recordingDb(sqlite: Database.Database): SqlDb {
  return {
    prepare(sql: string): SqlStatement {
      const stmt = sqlite.prepare(sql);
      const isWrite = /^\s*(INSERT|UPDATE|DELETE)/i.test(sql);
      return {
        async get<T>(...params: unknown[]): Promise<T | undefined> {
          return stmt.get(...params) as T | undefined;
        },
        async all<T>(...params: unknown[]): Promise<T[]> {
          return stmt.all(...params) as T[];
        },
        async run(...params: unknown[]) {
          const info = stmt.run(...params);
          if (isWrite) recorded.push({ sql, params });
          return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
        },
      };
    },
  };
}

async function main() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const db = recordingDb(sqlite);

  const creatorId = id('creator');
  await db
    .prepare(
      `INSERT INTO creators
         (id, slug, business_name, coach_name, coach_voice, brand_json, welcome_message, outcome, audience,
          methodology, teaching_style, always_do_json, never_do_json, ask_questions_when,
          escalation_policy, escalation_phone, price_per_minute_cents, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?)`,
    )
    .run(
      creatorId,
      'open-crumb',
      'Open Crumb Baking',
      'Rosa',
      'eve',
      JSON.stringify({ primary: '#2b2118', accent: '#a8632c' }),
      'Stuck mid-bake? Call Rosa and she will talk you through it.',
      'Bake a reliably open-crumb sourdough loaf at home',
      'Home bakers with a starter who keep getting dense loaves',
      'Temperature first, then fermentation time, then shaping.',
      'Direct and practical. One thing at a time. Never lectures.',
      JSON.stringify([
        'Ask for the actual dough temperature before diagnosing anything about fermentation',
        'Give one action, then ask them to report back on the result',
      ]),
      JSON.stringify(['Never tell someone to raise hydration to fix crumb structure', 'Never recommend commercial yeast']),
      'When a baker describes a result without numbers, ask for the temperature and timing first.',
      'offer_human',
      '+15550100200',
      75,
      now(),
      now(),
    );

  const parsed = parseCurriculumMarkdown(readFileSync(new URL('../../examples/curriculum-sample.md', import.meta.url), 'utf8'));
  const ingested = await ingestCourse(db, creatorId, parsed);

  await createBudget(db, {
    creatorId,
    name: 'Launch trial — 500 bakers x 10 minutes',
    fundedSeconds: 500 * 10 * 60,
    perCustomerSecondsCap: 10 * 60,
  });

  const customerId = id('cust');
  await db
    .prepare(
      `INSERT INTO customers (id, creator_id, name, phone_e164, verified_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(customerId, creatorId, 'Dana Whitfield', '+15550100199', now(), now());

  await topUp(db, { customerId, creatorId, seconds: 30 * 60, paidCents: 30 * 75, reason: '30 minute block' });

  let enrollment = await getOrCreateEnrollment(db, customerId, ingested.courseId);
  const start = (await firstStep(db, ingested.courseId))!;
  await completeAndAdvance(db, enrollment, { note: 'Starter doubling reliably' });

  enrollment = (await db.prepare('SELECT * FROM enrollments WHERE id = ?').get(enrollment.id)) as typeof enrollment;
  const second = await nextStep(db, start);
  if (second) {
    await appendTransition(db, {
      enrollmentId: enrollment.id,
      eventType: 'hit_problem',
      fromStepId: enrollment.current_step_id,
      toStepId: enrollment.current_step_id,
      problem: 'Starter sinks in the float test every time',
    });
  }

  const lines = recorded.map((r) => {
    const inlined = r.sql.replace(/\?/g, () => literal(r.params.shift()));
    return inlined.trim().endsWith(';') ? inlined : `${inlined};`;
  });

  console.log(lines.join('\n'));
  console.error(`\n-- ${lines.length} statements. Creator: ${creatorId}  Course: ${ingested.courseId}  Customer: ${customerId} --`);
}

main();
