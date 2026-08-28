import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDb, type DB } from '../src/db/index.js';
import { parseCurriculumMarkdown } from '../src/curriculum/parse-markdown.js';
import { ingestCourse } from '../src/curriculum/ingest.js';
import {
  appendTransition,
  completeAndAdvance,
  describeProgress,
  getOrCreateEnrollment,
  openProblems,
  completedStepIds,
} from '../src/state/transitions.js';
import { getStep } from '../src/curriculum/repository.js';
import { id, now } from '../src/util/ids.js';
import type { Enrollment } from '../src/domain/types.js';

const SAMPLE = readFileSync('examples/curriculum-sample.md', 'utf8');

function setup() {
  const db = createTestDb();
  const creatorId = id('creator');
  db.prepare(
    `INSERT INTO creators (id, slug, business_name, coach_name, price_per_minute_cents, created_at, updated_at)
     VALUES (?, ?, 'Test Co', 'Coach', 75, ?, ?)`,
  ).run(creatorId, `slug-${creatorId}`, now(), now());

  const { courseId } = ingestCourse(db, creatorId, parseCurriculumMarkdown(SAMPLE));

  const customerId = id('cust');
  db.prepare(
    `INSERT INTO customers (id, creator_id, name, phone_e164, verified_at, created_at)
     VALUES (?, ?, 'Dana Whitfield', '+15550100199', ?, ?)`,
  ).run(customerId, creatorId, now(), now());

  return { db, creatorId, courseId, customerId };
}

function reload(db: DB, enrollmentId: string): Enrollment {
  return db.prepare('SELECT * FROM enrollments WHERE id = ?').get(enrollmentId) as Enrollment;
}

describe('enrollment and position', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('starts a new caller on the first step', () => {
    const enrollment = getOrCreateEnrollment(ctx.db, ctx.customerId, ctx.courseId);
    const step = getStep(ctx.db, enrollment.current_step_id!)!;
    expect(step.moduleSeq).toBe(1);
    expect(step.step.seq).toBe(1);
  });

  it('is idempotent', () => {
    const a = getOrCreateEnrollment(ctx.db, ctx.customerId, ctx.courseId);
    const b = getOrCreateEnrollment(ctx.db, ctx.customerId, ctx.courseId);
    expect(a.id).toBe(b.id);
  });

  it('advances across a module boundary when a step completes', () => {
    let enrollment = getOrCreateEnrollment(ctx.db, ctx.customerId, ctx.courseId);
    completeAndAdvance(ctx.db, enrollment); // module 1 step 1 -> step 2
    enrollment = reload(ctx.db, enrollment.id);
    completeAndAdvance(ctx.db, enrollment); // end of module 1
    enrollment = reload(ctx.db, enrollment.id);

    const step = getStep(ctx.db, enrollment.current_step_id!)!;
    expect(step.moduleSeq).toBe(2);
    expect(completedStepIds(ctx.db, enrollment.id)).toHaveLength(2);
  });

  it('does not move the caller when they hit a problem', () => {
    const enrollment = getOrCreateEnrollment(ctx.db, ctx.customerId, ctx.courseId);
    const before = enrollment.current_step_id;

    appendTransition(ctx.db, {
      enrollmentId: enrollment.id,
      eventType: 'hit_problem',
      fromStepId: before,
      toStepId: before,
      problem: 'Starter never doubles',
    });

    expect(reload(ctx.db, enrollment.id).current_step_id).toBe(before);
  });

  it('marks the enrollment complete after the final step', () => {
    let enrollment = getOrCreateEnrollment(ctx.db, ctx.customerId, ctx.courseId);
    for (let i = 0; i < 20; i++) {
      const res = completeAndAdvance(ctx.db, enrollment);
      enrollment = reload(ctx.db, enrollment.id);
      if (!res.advancedTo) break;
    }
    expect(reload(ctx.db, enrollment.id).status).toBe('completed');
  });
});

describe('open problems across calls', () => {
  it('carries an unresolved problem from one call into the next', () => {
    const ctx = setup();
    const enrollment = getOrCreateEnrollment(ctx.db, ctx.customerId, ctx.courseId);

    // Monday.
    appendTransition(ctx.db, {
      enrollmentId: enrollment.id,
      eventType: 'hit_problem',
      fromStepId: enrollment.current_step_id,
      toStepId: enrollment.current_step_id,
      problem: 'Numbers are too high',
      callId: 'call_monday',
    });

    const open = openProblems(ctx.db, enrollment.id);
    expect(open).toHaveLength(1);
    expect(describeProgress(ctx.db, enrollment)).toContain('Unresolved problem');

    // Thursday: "I fixed what we talked about."
    appendTransition(ctx.db, {
      enrollmentId: enrollment.id,
      eventType: 'resolved_problem',
      fromStepId: enrollment.current_step_id,
      toStepId: enrollment.current_step_id,
      problem: 'Numbers are too high',
      resolution: 'Recalculated water temperature from measured flour temperature',
      callId: 'call_thursday',
    });

    expect(openProblems(ctx.db, enrollment.id)).toHaveLength(0);
    const summary = describeProgress(ctx.db, enrollment);
    expect(summary).toContain('Last call resolved');
    expect(summary).not.toContain('Unresolved problem');
  });

  it('summarises position rather than conversation', () => {
    const ctx = setup();
    let enrollment = getOrCreateEnrollment(ctx.db, ctx.customerId, ctx.courseId);
    completeAndAdvance(ctx.db, enrollment);
    enrollment = reload(ctx.db, enrollment.id);

    const summary = describeProgress(ctx.db, enrollment);
    expect(summary).toMatch(/Module 1/);
    expect(summary).toContain('Completed 1 step');
    // Nothing in the summary is a transcript of what anyone said.
    expect(summary).not.toMatch(/asked|said|told/i);
  });

  it('keeps two problems on the same step distinct', () => {
    const ctx = setup();
    const enrollment = getOrCreateEnrollment(ctx.db, ctx.customerId, ctx.courseId);
    const step = enrollment.current_step_id;

    for (const problem of ['Starter never doubles', 'Smells like acetone']) {
      appendTransition(ctx.db, {
        enrollmentId: enrollment.id,
        eventType: 'hit_problem',
        fromStepId: step,
        toStepId: step,
        problem,
      });
    }
    appendTransition(ctx.db, {
      enrollmentId: enrollment.id,
      eventType: 'resolved_problem',
      fromStepId: step,
      toStepId: step,
      problem: 'Starter never doubles',
      resolution: 'Moved to the oven with the light on',
    });

    const open = openProblems(ctx.db, enrollment.id);
    expect(open).toHaveLength(1);
    expect(open[0]!.problem).toBe('Smells like acetone');
  });
});
