import type { DB } from '../db/index.js';
import { transact } from '../db/index.js';
import { id, now } from '../util/ids.js';
import { auditStructure, hasBlockingIssues, type ParsedCourse, type StructureIssue } from './schema.js';

export interface IngestResult {
  courseId: string;
  moduleCount: number;
  lessonCount: number;
  stepCount: number;
  problemCount: number;
  referenceCount: number;
  issues: StructureIssue[];
}

export class StructureLostError extends Error {
  constructor(readonly issues: StructureIssue[]) {
    const errs = issues.filter((i) => i.severity === 'error');
    super(
      `Curriculum failed its structure audit with ${errs.length} blocking issue(s):\n` +
        errs.map((i) => `  - ${i.path}: ${i.message}`).join('\n'),
    );
    this.name = 'StructureLostError';
  }
}

/**
 * Persists a parsed course as a tree.
 *
 * `force` exists for previewing a half-finished import; a course that fails the
 * audit is stored but must not be published, because the coach's whole value is
 * knowing which step somebody is standing on.
 */
export function ingestCourse(
  db: DB,
  creatorId: string,
  parsed: ParsedCourse,
  opts: { force?: boolean } = {},
): IngestResult {
  const issues = auditStructure(parsed);
  if (hasBlockingIssues(issues) && !opts.force) {
    throw new StructureLostError(issues);
  }

  return transact(db, () => {
    const ts = now();
    const prior = db
      .prepare('SELECT MAX(version) AS v FROM courses WHERE creator_id = ? AND title = ?')
      .get(creatorId, parsed.title) as { v: number | null };

    const courseId = id('course');
    db.prepare(
      `INSERT INTO courses (id, creator_id, title, outcome, audience, methodology, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      courseId,
      creatorId,
      parsed.title,
      parsed.outcome ?? null,
      parsed.audience ?? null,
      parsed.methodology ?? null,
      (prior.v ?? 0) + 1,
      ts,
    );

    const insertModule = db.prepare(
      'INSERT INTO modules (id, course_id, seq, title, summary) VALUES (?, ?, ?, ?, ?)',
    );
    const insertLesson = db.prepare(
      'INSERT INTO lessons (id, module_id, course_id, seq, title, summary) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertStep = db.prepare(
      `INSERT INTO steps
         (id, lesson_id, module_id, course_id, seq, global_seq, title, instructions,
          expected_result, completion_criteria, prerequisites_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertProblem = db.prepare(
      'INSERT INTO step_problems (id, step_id, course_id, seq, symptom, cause, fix) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertReference = db.prepare(
      'INSERT INTO references_docs (id, course_id, title, body, kind) VALUES (?, ?, ?, ?, ?)',
    );
    const insertFts = db.prepare(
      'INSERT INTO curriculum_fts (body, title, course_id, ref_kind, ref_id, step_id) VALUES (?, ?, ?, ?, ?, ?)',
    );

    let globalSeq = 0;
    let stepCount = 0;
    let lessonCount = 0;
    let problemCount = 0;

    for (const [mi, mod] of parsed.modules.entries()) {
      const moduleId = id('mod');
      insertModule.run(moduleId, courseId, mi + 1, mod.title, mod.summary ?? null);
      if (mod.summary) {
        insertFts.run(mod.summary, mod.title, courseId, 'module', moduleId, null);
      }

      for (const [li, lesson] of mod.lessons.entries()) {
        const lessonId = id('lesson');
        lessonCount++;
        insertLesson.run(lessonId, moduleId, courseId, li + 1, lesson.title, lesson.summary ?? null);
        if (lesson.summary) {
          insertFts.run(lesson.summary, lesson.title, courseId, 'lesson', lessonId, null);
        }

        for (const [si, step] of lesson.steps.entries()) {
          const stepId = id('step');
          globalSeq++;
          stepCount++;
          insertStep.run(
            stepId,
            lessonId,
            moduleId,
            courseId,
            si + 1,
            globalSeq,
            step.title,
            step.instructions ?? null,
            step.expected_result ?? null,
            step.completion_criteria ?? null,
            JSON.stringify(step.prerequisites ?? []),
          );

          // Index the step's own language so search can find it, but retrieval
          // prefers structural lookup — search is the fallback, not the path.
          const stepBody = [step.instructions, step.expected_result, step.completion_criteria]
            .filter(Boolean)
            .join('\n');
          if (stepBody) insertFts.run(stepBody, step.title, courseId, 'step', stepId, stepId);

          for (const [pi, problem] of step.problems.entries()) {
            const problemId = id('prob');
            problemCount++;
            insertProblem.run(
              problemId,
              stepId,
              courseId,
              pi + 1,
              problem.symptom,
              problem.cause ?? null,
              problem.fix,
            );
            // Symptom text carries the caller's own words far better than the
            // instructions do, so troubleshooting rows are indexed separately.
            insertFts.run(
              [problem.symptom, problem.cause, problem.fix].filter(Boolean).join('\n'),
              `${step.title}: ${problem.symptom}`,
              courseId,
              'problem',
              problemId,
              stepId,
            );
          }
        }
      }
    }

    for (const ref of parsed.references) {
      const refId = id('ref');
      insertReference.run(refId, courseId, ref.title, ref.body, ref.kind);
      insertFts.run(ref.body, ref.title, courseId, 'reference', refId, null);
    }

    return {
      courseId,
      moduleCount: parsed.modules.length,
      lessonCount,
      stepCount,
      problemCount,
      referenceCount: parsed.references.length,
      issues,
    };
  });
}
