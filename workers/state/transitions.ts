import type { SqlDb } from '../db/types.js';
import { id, now } from '../../src/util/ids.js';
import type { Enrollment, StateTransition, Step, TransitionEvent } from '../../src/domain/types.js';
import { firstStep, getStep, nextStep } from '../curriculum/repository.js';

export async function getOrCreateEnrollment(db: SqlDb, customerId: string, courseId: string): Promise<Enrollment> {
  const existing = await db
    .prepare('SELECT * FROM enrollments WHERE customer_id = ? AND course_id = ?')
    .get<Enrollment>(customerId, courseId);
  if (existing) return existing;

  const ts = now();
  const enrollmentId = id('enr');
  const start = await firstStep(db, courseId);
  await db
    .prepare(
      `INSERT INTO enrollments (id, customer_id, course_id, current_step_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(enrollmentId, customerId, courseId, start?.id ?? null, ts, ts);

  await appendTransition(db, {
    enrollmentId,
    eventType: 'enrolled',
    fromStepId: null,
    toStepId: start?.id ?? null,
    source: 'system',
  });

  return (await db.prepare('SELECT * FROM enrollments WHERE id = ?').get<Enrollment>(enrollmentId))!;
}

export interface TransitionInput {
  enrollmentId: string;
  eventType: TransitionEvent;
  fromStepId?: string | null;
  toStepId?: string | null;
  problem?: string | null;
  resolution?: string | null;
  note?: string | null;
  source?: string;
  callId?: string | null;
}

const MOVES_CURSOR: TransitionEvent[] = ['enrolled', 'started_step', 'advanced', 'moved_back'];

export async function appendTransition(db: SqlDb, input: TransitionInput): Promise<StateTransition> {
  const row = await db
    .prepare('SELECT MAX(seq) AS s FROM state_transitions WHERE enrollment_id = ?')
    .get<{ s: number | null }>(input.enrollmentId);
  const seq = (row?.s ?? 0) + 1;
  const ts = now();
  const transitionId = id('tr');

  await db
    .prepare(
      `INSERT INTO state_transitions
         (id, enrollment_id, seq, event_type, from_step_id, to_step_id, problem, resolution, note, source, call_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      transitionId,
      input.enrollmentId,
      seq,
      input.eventType,
      input.fromStepId ?? null,
      input.toStepId ?? null,
      input.problem ?? null,
      input.resolution ?? null,
      input.note ?? null,
      input.source ?? 'coach',
      input.callId ?? null,
      ts,
    );

  if (MOVES_CURSOR.includes(input.eventType) && input.toStepId) {
    await db
      .prepare('UPDATE enrollments SET current_step_id = ?, updated_at = ? WHERE id = ?')
      .run(input.toStepId, ts, input.enrollmentId);
  } else {
    await db.prepare('UPDATE enrollments SET updated_at = ? WHERE id = ?').run(ts, input.enrollmentId);
  }

  return (await db.prepare('SELECT * FROM state_transitions WHERE id = ?').get<StateTransition>(transitionId))!;
}

export async function completeAndAdvance(
  db: SqlDb,
  enrollment: Enrollment,
  opts: { callId?: string | null; note?: string | null } = {},
): Promise<{ completed: Step | null; advancedTo: Step | null }> {
  const current = enrollment.current_step_id ? await getStep(db, enrollment.current_step_id) : null;
  if (!current) return { completed: null, advancedTo: null };

  await appendTransition(db, {
    enrollmentId: enrollment.id,
    eventType: 'completed_step',
    fromStepId: current.step.id,
    toStepId: current.step.id,
    note: opts.note ?? null,
    callId: opts.callId ?? null,
  });

  const next = await nextStep(db, current.step);
  if (next) {
    await appendTransition(db, {
      enrollmentId: enrollment.id,
      eventType: 'advanced',
      fromStepId: current.step.id,
      toStepId: next.id,
      callId: opts.callId ?? null,
    });
  } else {
    await db
      .prepare("UPDATE enrollments SET status = 'completed', updated_at = ? WHERE id = ?")
      .run(now(), enrollment.id);
  }

  return { completed: current.step, advancedTo: next };
}

export async function openProblems(db: SqlDb, enrollmentId: string): Promise<StateTransition[]> {
  const all = await db
    .prepare(
      `SELECT * FROM state_transitions
        WHERE enrollment_id = ? AND event_type IN ('hit_problem', 'resolved_problem')
        ORDER BY seq`,
    )
    .all<StateTransition>(enrollmentId);

  const open = new Map<string, StateTransition>();
  for (const t of all) {
    const key = `${t.to_step_id ?? t.from_step_id ?? ''}::${(t.problem ?? '').toLowerCase().slice(0, 60)}`;
    if (t.event_type === 'hit_problem') open.set(key, t);
    else open.delete(key);
  }
  return [...open.values()];
}

export async function completedStepIds(db: SqlDb, enrollmentId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT from_step_id AS stepId FROM state_transitions
        WHERE enrollment_id = ? AND event_type = 'completed_step' AND from_step_id IS NOT NULL`,
    )
    .all<{ stepId: string }>(enrollmentId);
  return rows.map((r) => r.stepId);
}

export async function describeProgress(db: SqlDb, enrollment: Enrollment): Promise<string> {
  const lines: string[] = [];
  const current = enrollment.current_step_id ? await getStep(db, enrollment.current_step_id) : null;

  if (current) {
    lines.push(
      `Currently on Module ${current.moduleSeq} ("${current.moduleTitle}"), ` +
        `Lesson ${current.lessonSeq}, Step ${current.step.seq}: "${current.step.title}".`,
    );
  } else if (enrollment.status === 'completed') {
    lines.push('Has finished every step in the course.');
  } else {
    lines.push('Has not started the course yet.');
  }

  const completed = await completedStepIds(db, enrollment.id);
  if (completed.length > 0) lines.push(`Completed ${completed.length} step(s) so far.`);

  const open = await openProblems(db, enrollment.id);
  if (open.length > 0) {
    const p = open[open.length - 1]!;
    const where = p.to_step_id ?? p.from_step_id;
    const stepDetail = where ? await getStep(db, where) : null;
    lines.push(
      `Unresolved problem from a previous call${stepDetail ? ` on "${stepDetail.step.title}"` : ''}: ${p.problem}.`,
    );
  }

  const lastResolved = await db
    .prepare(
      `SELECT * FROM state_transitions
        WHERE enrollment_id = ? AND event_type = 'resolved_problem'
        ORDER BY seq DESC LIMIT 1`,
    )
    .get<StateTransition>(enrollment.id);
  if (lastResolved?.problem) {
    lines.push(
      `Last call resolved: ${lastResolved.problem}${lastResolved.resolution ? ` — ${lastResolved.resolution}` : ''}.`,
    );
  }

  return lines.join(' ');
}
