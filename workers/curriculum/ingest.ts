import type { SqlDb } from '../db/types.js';
import { id, now } from '../../src/util/ids.js';
import { auditStructure, hasBlockingIssues, type ParsedCourse, type StructureIssue } from '../../src/curriculum/schema.js';

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
 * Same audit-then-store behaviour as src/curriculum/ingest.ts.
 *
 * Not wrapped in a transaction: D1's atomic path (`batch()`) takes a
 * pre-built array of statements, which doesn't fit this loop's structure
 * cleanly, and curriculum ingestion is an admin-only, low-frequency
 * operation — unlike billing, a partial write here just means re-running the
 * import, not money going missing.
 */
export async function ingestCourse(
  db: SqlDb,
  creatorId: string,
  parsed: ParsedCourse,
  opts: { force?: boolean } = {},
): Promise<IngestResult> {
  const issues = auditStructure(parsed);
  if (hasBlockingIssues(issues) && !opts.force) {
    throw new StructureLostError(issues);
  }

  const ts = now();
  const prior = await db
    .prepare('SELECT MAX(version) AS v FROM courses WHERE creator_id = ? AND title = ?')
    .get<{ v: number | null }>(creatorId, parsed.title);

  const courseId = id('course');
  await db
    .prepare(
      `INSERT INTO courses (id, creator_id, title, outcome, audience, methodology, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(courseId, creatorId, parsed.title, parsed.outcome ?? null, parsed.audience ?? null, parsed.methodology ?? null, (prior?.v ?? 0) + 1, ts);

  let globalSeq = 0;
  let stepCount = 0;
  let lessonCount = 0;
  let problemCount = 0;

  for (const [mi, mod] of parsed.modules.entries()) {
    const moduleId = id('mod');
    await db
      .prepare('INSERT INTO modules (id, course_id, seq, title, summary) VALUES (?, ?, ?, ?, ?)')
      .run(moduleId, courseId, mi + 1, mod.title, mod.summary ?? null);

    for (const [li, lesson] of mod.lessons.entries()) {
      const lessonId = id('lesson');
      lessonCount++;
      await db
        .prepare('INSERT INTO lessons (id, module_id, course_id, seq, title, summary) VALUES (?, ?, ?, ?, ?, ?)')
        .run(lessonId, moduleId, courseId, li + 1, lesson.title, lesson.summary ?? null);

      for (const [si, step] of lesson.steps.entries()) {
        const stepId = id('step');
        globalSeq++;
        stepCount++;
        await db
          .prepare(
            `INSERT INTO steps
               (id, lesson_id, module_id, course_id, seq, global_seq, title, instructions,
                expected_result, completion_criteria, prerequisites_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
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

        for (const [pi, problem] of step.problems.entries()) {
          problemCount++;
          await db
            .prepare(
              'INSERT INTO step_problems (id, step_id, course_id, seq, symptom, cause, fix) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
            .run(id('prob'), stepId, courseId, pi + 1, problem.symptom, problem.cause ?? null, problem.fix);
        }
      }
    }
  }

  for (const ref of parsed.references) {
    await db
      .prepare('INSERT INTO references_docs (id, course_id, title, body, kind) VALUES (?, ?, ?, ?, ?)')
      .run(id('ref'), courseId, ref.title, ref.body, ref.kind);
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
}
