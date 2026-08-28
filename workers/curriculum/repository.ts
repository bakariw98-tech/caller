import type { SqlDb } from '../db/types.js';
import type { Step, StepProblem } from '../../src/domain/types.js';

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

export async function getStep(db: SqlDb, stepId: string): Promise<StepDetail | null> {
  const step = await db.prepare('SELECT * FROM steps WHERE id = ?').get<Step>(stepId);
  if (!step) return null;
  return hydrateStep(db, step);
}

export async function hydrateStep(db: SqlDb, step: Step): Promise<StepDetail> {
  const ctx = await db
    .prepare(
      `SELECT l.title AS lessonTitle, l.seq AS lessonSeq, m.title AS moduleTitle, m.seq AS moduleSeq
         FROM lessons l JOIN modules m ON m.id = l.module_id
        WHERE l.id = ?`,
    )
    .get<{ lessonTitle: string; lessonSeq: number; moduleTitle: string; moduleSeq: number }>(step.lesson_id);

  const problems = await db
    .prepare('SELECT * FROM step_problems WHERE step_id = ? ORDER BY seq')
    .all<StepProblem>(step.id);

  const next = await db
    .prepare('SELECT id, title FROM steps WHERE course_id = ? AND global_seq > ? ORDER BY global_seq LIMIT 1')
    .get<{ id: string; title: string }>(step.course_id, step.global_seq);

  const prev = await db
    .prepare('SELECT id FROM steps WHERE course_id = ? AND global_seq < ? ORDER BY global_seq DESC LIMIT 1')
    .get<{ id: string }>(step.course_id, step.global_seq);

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

export async function firstStep(db: SqlDb, courseId: string): Promise<Step | null> {
  return (
    (await db.prepare('SELECT * FROM steps WHERE course_id = ? ORDER BY global_seq LIMIT 1').get<Step>(
      courseId,
    )) ?? null
  );
}

export async function nextStep(db: SqlDb, step: Step): Promise<Step | null> {
  return (
    (await db
      .prepare('SELECT * FROM steps WHERE course_id = ? AND global_seq > ? ORDER BY global_seq LIMIT 1')
      .get<Step>(step.course_id, step.global_seq)) ?? null
  );
}

export async function findStepByPosition(
  db: SqlDb,
  courseId: string,
  pos: { module?: number; lesson?: number; step?: number },
): Promise<Step | null> {
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
    (await db
      .prepare(
        `SELECT s.* FROM steps s
           JOIN lessons l ON l.id = s.lesson_id
           JOIN modules m ON m.id = s.module_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY s.global_seq LIMIT 1`,
      )
      .get<Step>(...params)) ?? null
  );
}

const STOPWORDS = new Set([
  'the', 'and', 'but', 'for', 'are', 'was', 'were', 'this', 'that', 'with', 'have', 'has',
  'not', 'you', 'your', 'ive', 'its', 'from', 'what', 'when', 'why', 'how', 'about', 'into',
  'they', 'them', 'there', 'here', 'been', 'does', 'did', 'doing', 'can', 'cant', 'could',
  'should', 'would', 'like', 'just', 'get', 'got', 'now', 'out', 'off', 'all', 'any',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((t) => t.replace(/'/g, ''))
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export interface SearchHit {
  refKind: 'step' | 'problem' | 'lesson' | 'module' | 'reference';
  refId: string;
  stepId: string | null;
  title: string;
  body: string;
  score: number;
}

interface Indexable {
  refKind: SearchHit['refKind'];
  refId: string;
  stepId: string | null;
  title: string;
  body: string;
}

/**
 * D1's public docs do not confirm FTS5 support, so this scores candidates in
 * JS rather than depending on an unverified virtual table extension. The
 * curriculum for one creator is small — steps, problems, lessons, modules,
 * references, a few hundred rows at most — so pulling the course's indexable
 * text and scoring in memory is simpler than it would be at any real scale,
 * and there is no scale here to speak of.
 *
 * Same two coaching priors as the Node version: a troubleshooting entry beats
 * prose for a reported symptom, and material near the caller's current step
 * beats material far from it.
 */
export async function searchCurriculum(
  db: SqlDb,
  courseId: string,
  query: string,
  opts: { limit?: number; nearStepId?: string | null } = {},
): Promise<SearchHit[]> {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];
  const limit = opts.limit ?? 6;

  const rows: Indexable[] = [];

  const steps = await db
    .prepare(
      `SELECT id AS refId, title, instructions, expected_result, completion_criteria
         FROM steps WHERE course_id = ?`,
    )
    .all<{ refId: string; title: string; instructions: string | null; expected_result: string | null; completion_criteria: string | null }>(
      courseId,
    );
  for (const s of steps) {
    const body = [s.instructions, s.expected_result, s.completion_criteria].filter(Boolean).join('\n');
    if (body) rows.push({ refKind: 'step', refId: s.refId, stepId: s.refId, title: s.title, body });
  }

  const problems = await db
    .prepare('SELECT id AS refId, step_id AS stepId, symptom, cause, fix FROM step_problems WHERE course_id = ?')
    .all<{ refId: string; stepId: string; symptom: string; cause: string | null; fix: string }>(courseId);
  for (const p of problems) {
    rows.push({
      refKind: 'problem',
      refId: p.refId,
      stepId: p.stepId,
      title: p.symptom,
      body: [p.symptom, p.cause, p.fix].filter(Boolean).join('\n'),
    });
  }

  const lessons = await db
    .prepare(
      `SELECT l.id AS refId, l.title, l.summary
         FROM lessons l JOIN modules m ON m.id = l.module_id
        WHERE l.course_id = ? AND l.summary IS NOT NULL`,
    )
    .all<{ refId: string; title: string; summary: string }>(courseId);
  for (const l of lessons) rows.push({ refKind: 'lesson', refId: l.refId, stepId: null, title: l.title, body: l.summary });

  const modules = await db
    .prepare("SELECT id AS refId, title, summary FROM modules WHERE course_id = ? AND summary IS NOT NULL")
    .all<{ refId: string; title: string; summary: string }>(courseId);
  for (const m of modules) rows.push({ refKind: 'module', refId: m.refId, stepId: null, title: m.title, body: m.summary });

  const refs = await db
    .prepare('SELECT id AS refId, title, body FROM references_docs WHERE course_id = ?')
    .all<{ refId: string; title: string; body: string }>(courseId);
  for (const r of refs) rows.push({ refKind: 'reference', refId: r.refId, stepId: null, title: r.title, body: r.body });

  const scored = rows
    .map((row) => {
      const haystack = tokenize(`${row.title} ${row.body}`);
      const haySet = new Set(haystack);
      let overlap = 0;
      for (const t of queryTerms) if (haySet.has(t)) overlap++;
      if (overlap === 0) return null;

      let score = overlap;
      if (row.refKind === 'problem') score *= 1.5;
      if (row.refKind === 'step') score *= 1.2;
      if (opts.nearStepId && row.stepId === opts.nearStepId) score *= 2;
      return { ...row, score };
    })
    .filter((x): x is SearchHit => x !== null);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Only genuine symptom overlaps come back — see the Node version's test for why. */
export async function matchProblems(db: SqlDb, stepId: string, symptom: string): Promise<StepProblem[]> {
  const all = await db.prepare('SELECT * FROM step_problems WHERE step_id = ? ORDER BY seq').all<StepProblem>(stepId);
  if (all.length === 0) return [];

  const words = new Set(tokenize(symptom));
  if (words.size === 0) return all;

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
