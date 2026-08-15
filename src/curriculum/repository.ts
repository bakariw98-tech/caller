import type { DB } from '../db/index.js';
import type { Step, StepProblem } from '../domain/types.js';

export interface StepDetail {
  step: Step;
  lessonTitle: string;
  moduleTitle: string;
  moduleSeq: number;
  lessonSeq: number;
  problems: StepProblem[];
  nextStepId: string | null;
  nextStepTitle: string | null;
  prevStepId: string | null;
}

export interface SearchHit {
  refKind: 'step' | 'problem' | 'lesson' | 'module' | 'reference';
  refId: string;
  stepId: string | null;
  title: string;
  body: string;
  score: number;
}

export function getStep(db: DB, stepId: string): StepDetail | null {
  const step = db.prepare('SELECT * FROM steps WHERE id = ?').get(stepId) as Step | undefined;
  if (!step) return null;
  return hydrateStep(db, step);
}

export function hydrateStep(db: DB, step: Step): StepDetail {
  const ctx = db
    .prepare(
      `SELECT l.title AS lessonTitle, l.seq AS lessonSeq, m.title AS moduleTitle, m.seq AS moduleSeq
         FROM lessons l JOIN modules m ON m.id = l.module_id
        WHERE l.id = ?`,
    )
    .get(step.lesson_id) as
    | { lessonTitle: string; lessonSeq: number; moduleTitle: string; moduleSeq: number }
    | undefined;

  const problems = db
    .prepare('SELECT * FROM step_problems WHERE step_id = ? ORDER BY seq')
    .all(step.id) as StepProblem[];

  const next = db
    .prepare(
      'SELECT id, title FROM steps WHERE course_id = ? AND global_seq > ? ORDER BY global_seq LIMIT 1',
    )
    .get(step.course_id, step.global_seq) as { id: string; title: string } | undefined;

  const prev = db
    .prepare(
      'SELECT id FROM steps WHERE course_id = ? AND global_seq < ? ORDER BY global_seq DESC LIMIT 1',
    )
    .get(step.course_id, step.global_seq) as { id: string } | undefined;

  return {
    step,
    lessonTitle: ctx?.lessonTitle ?? '',
    lessonSeq: ctx?.lessonSeq ?? 0,
    moduleTitle: ctx?.moduleTitle ?? '',
    moduleSeq: ctx?.moduleSeq ?? 0,
    problems,
    nextStepId: next?.id ?? null,
    nextStepTitle: next?.title ?? null,
    prevStepId: prev?.id ?? null,
  };
}

export function firstStep(db: DB, courseId: string): Step | null {
  return (
    (db
      .prepare('SELECT * FROM steps WHERE course_id = ? ORDER BY global_seq LIMIT 1')
      .get(courseId) as Step | undefined) ?? null
  );
}

export function nextStep(db: DB, step: Step): Step | null {
  return (
    (db
      .prepare(
        'SELECT * FROM steps WHERE course_id = ? AND global_seq > ? ORDER BY global_seq LIMIT 1',
      )
      .get(step.course_id, step.global_seq) as Step | undefined) ?? null
  );
}

/**
 * Resolves the way callers actually describe their position: "module 4",
 * "module 2 step 3", "the third step of lesson 1".
 */
export function findStepByPosition(
  db: DB,
  courseId: string,
  pos: { module?: number; lesson?: number; step?: number },
): Step | null {
  const clauses: string[] = ['s.course_id = ?'];
  const params: unknown[] = [courseId];

  if (pos.module !== undefined) {
    clauses.push('m.seq = ?');
    params.push(pos.module);
  }
  if (pos.lesson !== undefined) {
    clauses.push('l.seq = ?');
    params.push(pos.lesson);
  }
  if (pos.step !== undefined) {
    clauses.push('s.seq = ?');
    params.push(pos.step);
  }

  return (
    (db
      .prepare(
        `SELECT s.* FROM steps s
           JOIN lessons l ON l.id = s.lesson_id
           JOIN modules m ON m.id = s.module_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY s.global_seq LIMIT 1`,
      )
      .get(...params) as Step | undefined) ?? null
  );
}

export interface OutlineNode {
  moduleSeq: number;
  moduleTitle: string;
  lessons: { lessonSeq: number; lessonTitle: string; steps: { seq: number; title: string; id: string }[] }[];
}

export function getOutline(db: DB, courseId: string): OutlineNode[] {
  const rows = db
    .prepare(
      `SELECT m.seq AS moduleSeq, m.title AS moduleTitle,
              l.seq AS lessonSeq, l.title AS lessonTitle,
              s.seq AS stepSeq, s.title AS stepTitle, s.id AS stepId
         FROM modules m
         JOIN lessons l ON l.module_id = m.id
         LEFT JOIN steps s ON s.lesson_id = l.id
        WHERE m.course_id = ?
        ORDER BY m.seq, l.seq, s.seq`,
    )
    .all(courseId) as {
    moduleSeq: number;
    moduleTitle: string;
    lessonSeq: number;
    lessonTitle: string;
    stepSeq: number | null;
    stepTitle: string | null;
    stepId: string | null;
  }[];

  const out: OutlineNode[] = [];
  for (const r of rows) {
    let mod = out.find((m) => m.moduleSeq === r.moduleSeq);
    if (!mod) {
      mod = { moduleSeq: r.moduleSeq, moduleTitle: r.moduleTitle, lessons: [] };
      out.push(mod);
    }
    let lesson = mod.lessons.find((l) => l.lessonSeq === r.lessonSeq);
    if (!lesson) {
      lesson = { lessonSeq: r.lessonSeq, lessonTitle: r.lessonTitle, steps: [] };
      mod.lessons.push(lesson);
    }
    if (r.stepId && r.stepTitle && r.stepSeq !== null) {
      lesson.steps.push({ seq: r.stepSeq, title: r.stepTitle, id: r.stepId });
    }
  }
  return out;
}

/**
 * FTS5 treats bare punctuation and operators as syntax, and caller speech is
 * full of both. Everything is reduced to quoted terms joined by OR.
 */
function toFtsQuery(raw: string): string | null {
  const terms = raw
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((t) => t.replace(/'/g, ''))
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .slice(0, 12);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(' OR ');
}

const STOPWORDS = new Set([
  'the', 'and', 'but', 'for', 'are', 'was', 'were', 'this', 'that', 'with', 'have', 'has',
  'not', 'you', 'your', 'ive', 'its', 'from', 'what', 'when', 'why', 'how', 'about', 'into',
  'they', 'them', 'there', 'here', 'been', 'does', 'did', 'doing', 'can', 'cant', 'could',
  'should', 'would', 'like', 'just', 'get', 'got', 'now', 'out', 'off', 'all', 'any',
]);

/**
 * Lexical search over one course.
 *
 * Scoped by `course_id` in the SQL rather than filtered afterwards: a caller
 * must never be able to pull another creator's material into the conversation.
 */
export function searchCurriculum(
  db: DB,
  courseId: string,
  query: string,
  opts: { limit?: number; nearStepId?: string | null } = {},
): SearchHit[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const limit = opts.limit ?? 6;

  const rows = db
    .prepare(
      `SELECT ref_kind AS refKind, ref_id AS refId, step_id AS stepId, title, body, bm25(curriculum_fts) AS rank
         FROM curriculum_fts
        WHERE curriculum_fts MATCH ? AND course_id = ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(fts, courseId, limit * 3) as {
    refKind: SearchHit['refKind'];
    refId: string;
    stepId: string | null;
    title: string;
    body: string;
    rank: number;
  }[];

  // bm25 returns lower-is-better. Re-rank with two coaching priors: a
  // troubleshooting entry beats prose when someone reports a symptom, and
  // material near where the caller already stands beats material far away.
  const scored = rows.map((r) => {
    let score = -r.rank;
    if (r.refKind === 'problem') score *= 1.5;
    if (r.refKind === 'step') score *= 1.2;
    if (opts.nearStepId && r.stepId === opts.nearStepId) score *= 2;
    return { ...r, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ rank: _rank, ...rest }) => rest);
}

/** Troubleshooting entries for one step, matched against a reported symptom. */
export function matchProblems(db: DB, stepId: string, symptom: string): StepProblem[] {
  const all = db
    .prepare('SELECT * FROM step_problems WHERE step_id = ? ORDER BY seq')
    .all(stepId) as StepProblem[];
  if (all.length === 0) return [];

  const words = new Set(
    symptom
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
  if (words.size === 0) return all;

  // Only genuine overlaps come back. Handing the coach the nearest unrelated
  // entry would be worse than handing it nothing: it reads as the creator's
  // documented answer to a problem the creator never wrote about. An empty
  // result lets the caller widen the search or admit the gap.
  return all
    .map((p) => {
      const hay = `${p.symptom} ${p.cause ?? ''}`.toLowerCase();
      let overlap = 0;
      for (const w of words) if (hay.includes(w)) overlap++;
      return { p, overlap };
    })
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .map((x) => x.p);
}
