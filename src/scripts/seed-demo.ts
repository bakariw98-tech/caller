/**
 * Seeds a complete creator, so the call path can be exercised end to end
 * without provisioning a real number or spending anything.
 *
 *   npm run seed
 */
import { readFileSync } from 'node:fs';
import { applySchema, getDb } from '../db/index.js';
import { id, now } from '../util/ids.js';
import { parseCurriculumMarkdown } from '../curriculum/parse-markdown.js';
import { ingestCourse } from '../curriculum/ingest.js';
import { createBudget } from '../billing/promotional.js';
import { topUp } from '../billing/wallet.js';
import { getOrCreateEnrollment, appendTransition, completeAndAdvance } from '../state/transitions.js';
import { firstStep, nextStep } from '../curriculum/repository.js';
import type { Enrollment } from '../domain/types.js';

applySchema(getDb());
const db = getDb();

const creatorId = id('creator');
db.prepare(
  `INSERT INTO creators
     (id, slug, business_name, coach_name, coach_voice, brand_json, welcome_message, outcome, audience,
      methodology, teaching_style, always_do_json, never_do_json, ask_questions_when,
      escalation_policy, escalation_phone, price_per_minute_cents, status, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?)`,
).run(
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
  JSON.stringify([
    'Never tell someone to raise hydration to fix crumb structure',
    'Never recommend commercial yeast',
  ]),
  'When a baker describes a result without numbers, ask for the temperature and timing first.',
  'offer_human',
  '+15550100200',
  75,
  now(),
  now(),
);

const parsed = parseCurriculumMarkdown(readFileSync('examples/curriculum-sample.md', 'utf8'));
const ingested = ingestCourse(db, creatorId, parsed);

createBudget(db, {
  creatorId,
  name: 'Launch trial — 500 bakers x 10 minutes',
  fundedSeconds: 500 * 10 * 60,
  perCustomerSecondsCap: 10 * 60,
});

// A customer mid-course, with a problem left open from a previous call — the
// state a returning caller should be able to pick up without re-explaining.
const customerId = id('cust');
db.prepare(
  `INSERT INTO customers (id, creator_id, name, phone_e164, verified_at, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
).run(customerId, creatorId, 'Dana Whitfield', '+15550100199', now(), now());

topUp(db, { customerId, creatorId, seconds: 30 * 60, paidCents: 30 * 75, reason: '30 minute block' });

let enrollment = getOrCreateEnrollment(db, customerId, ingested.courseId);
const start = firstStep(db, ingested.courseId)!;
completeAndAdvance(db, enrollment, { note: 'Starter doubling reliably' });

enrollment = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(enrollment.id) as Enrollment;
const second = nextStep(db, start);
if (second) {
  appendTransition(db, {
    enrollmentId: enrollment.id,
    eventType: 'hit_problem',
    fromStepId: enrollment.current_step_id,
    toStepId: enrollment.current_step_id,
    problem: 'Starter sinks in the float test every time',
  });
}

console.log(`
Seeded.

  Creator id     ${creatorId}
  Course id      ${ingested.courseId}  (${ingested.stepCount} steps, ${ingested.problemCount} documented problems)
  Customer       Dana Whitfield  +15550100199  — 30 minutes of credit
  Landing page   /c/open-crumb
  Dashboard      /dashboard/${creatorId}

Next: npm run provision -- --creator ${creatorId}
`);
