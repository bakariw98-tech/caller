import type { DB } from '../db/index.js';
import { transact } from '../db/index.js';
import { id, now } from '../util/ids.js';
import type { Enrollment, StateTransition, Step, TransitionEvent } from '../domain/types.js';
import { firstStep, getStep, nextStep } from '../curriculum/repository.js';

export function getOrCreateEnrollment(db: DB, customerId: string, courseId: string): Enrollment {
  const existing = db
    .prepare('SELECT * FROM enrollments WHERE customer_id = ? AND course_id = ?')
    .get(customerId, courseId) as Enrollment | undefined;
  if (existing) return existing;

  return transact(db, () => {
    const ts = now();
    const enrollmentId = id('enr');
    const start = firstStep(db, courseId);
    db.prepare(
      `INSERT INTO enrollments (id, customer_id, course_id, current_step_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run(enrollmentId, customerId, courseId, start?.id ?? null, ts, ts);

    appendTransition(db, {
      enrollmentId,
      eventType: 'enrolled',
      fromStepId: null,
      toStepId: start?.id ?? null,
      source: 'system',
    });

    return db.prepare('SELECT * FROM enrollments WHERE id = ?').get(enrollmentId) as Enrollment;
  });
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

/**
 * Appends one transition and moves the enrollment's cursor to match.
 *
 * The enrollment row is a cache of the transition log, not a separate source of
 * truth — every write goes through here so the two cannot drift.
 */
export function appendTransition(db: DB, input: TransitionInput): StateTransition {
  return transact(db, () => {
    const row = db
      .prepare('SELECT MAX(seq) AS s FROM state_transitions WHERE enrollment_id = ?')
      .get(input.enrollmentId) as { s: number | null };
    const seq = (row.s ?? 0) + 1;
    const ts = now();
    const transitionId = id('tr');

    db.prepare(
      `INSERT INTO state_transitions
         (id, enrollment_id, seq, event_type, from_step_id, to_step_id, problem, resolution, note, source, call_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
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

    // Only events that genuinely relocate the caller move the cursor. Hitting a
    // problem does not: they are still standing on the same step.
    const MOVES_CURSOR: TransitionEvent[] = ['enrolled', 'started_step', 'advanced', 'moved_back'];
    if (MOVES_CURSOR.includes(input.eventType) && input.toStepId) {
      db.prepare('UPDATE enrollments SET current_step_id = ?, updated_at = ? WHERE id = ?').run(
        input.toStepId,
        ts,
        input.enrollmentId,
      );
    } else {
      db.prepare('UPDATE enrollments SET updated_at = ? WHERE id = ?').run(ts, input.enrollmentId);
    }

    return db.prepare('SELECT * FROM state_transitions WHERE id = ?').get(transitionId) as StateTransition;
  });
}

/**
 * Marks the current step complete and moves to the next one, in a single
 * transition pair so the log reads as a story rather than a set of edits.
 */
export function completeAndAdvance(
  db: DB,
  enrollment: Enrollment,
  opts: { callId?: string | null; note?: string | null } = {},
): { completed: Step | null; advancedTo: Step | null } {
  const current = enrollment.current_step_id ? getStep(db, enrollment.current_step_id) : null;
  if (!current) return { completed: null, advancedTo: null };

  appendTransition(db, {
    enrollmentId: enrollment.id,
    eventType: 'completed_step',
    fromStepId: current.step.id,
    toStepId: current.step.id,
    note: opts.note ?? null,
    callId: opts.callId ?? null,
  });

  const next = nextStep(db, current.step);
  if (next) {
    appendTransition(db, {
      enrollmentId: enrollment.id,
      eventType: 'advanced',
      fromStepId: current.step.id,
      toStepId: next.id,
      callId: opts.callId ?? null,
    });
  } else {
    db.prepare("UPDATE enrollments SET status = 'completed', updated_at = ? WHERE id = ?").run(
      now(),
      enrollment.id,
    );
  }

  return { completed: current.step, advancedTo: next };
}

export function recentTransitions(db: DB, enrollmentId: string, limit = 12): StateTransition[] {
  return db
    .prepare('SELECT * FROM state_transitions WHERE enrollment_id = ? ORDER BY seq DESC LIMIT ?')
    .all(enrollmentId, limit) as StateTransition[];
}

export function completedStepIds(db: DB, enrollmentId: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT from_step_id AS stepId FROM state_transitions
        WHERE enrollment_id = ? AND event_type = 'completed_step' AND from_step_id IS NOT NULL`,
    )
    .all(enrollmentId) as { stepId: string }[];
  return rows.map((r) => r.stepId);
}

/** Problems raised but never resolved — the thread a returning caller picks up. */
export function openProblems(db: DB, enrollmentId: string): StateTransition[] {
  const all = db
    .prepare(
      `SELECT * FROM state_transitions
        WHERE enrollment_id = ? AND event_type IN ('hit_problem', 'resolved_problem')
        ORDER BY seq`,
    )
    .all(enrollmentId) as StateTransition[];

  const open = new Map<string, StateTransition>();
  for (const t of all) {
    const key = `${t.to_step_id ?? t.from_step_id ?? ''}::${(t.problem ?? '').toLowerCase().slice(0, 60)}`;
    if (t.event_type === 'hit_problem') open.set(key, t);
    else open.delete(key);
  }
  return [...open.values()];
}

/**
 * Renders a caller's history as the handful of lines a human coach would keep
 * on an index card. This text is seeded once per call and is billable, so it is
 * deliberately short and carries only state, never conversation.
 */
export function describeProgress(db: DB, enrollment: Enrollment): string {
  const lines: string[] = [];
  const current = enrollment.current_step_id ? getStep(db, enrollment.current_step_id) : null;

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

  const completed = completedStepIds(db, enrollment.id);
  if (completed.length > 0) lines.push(`Completed ${completed.length} step(s) so far.`);

  const open = openProblems(db, enrollment.id);
  if (open.length > 0) {
    const p = open[open.length - 1]!;
    const where = p.to_step_id ?? p.from_step_id;
    const stepDetail = where ? getStep(db, where) : null;
    lines.push(
      `Unresolved problem from a previous call${stepDetail ? ` on "${stepDetail.step.title}"` : ''}: ${p.problem}.`,
    );
  }

  const lastResolved = db
    .prepare(
      `SELECT * FROM state_transitions
        WHERE enrollment_id = ? AND event_type = 'resolved_problem'
        ORDER BY seq DESC LIMIT 1`,
    )
    .get(enrollment.id) as StateTransition | undefined;
  if (lastResolved?.problem) {
    lines.push(
      `Last call resolved: ${lastResolved.problem}${lastResolved.resolution ? ` — ${lastResolved.resolution}` : ''}.`,
    );
  }

  return lines.join(' ');
}
