import { z } from 'zod';

/**
 * The canonical shape of an ingested course. Both the Markdown parser and any
 * programmatic importer must produce this — it is the contract that keeps the
 * curriculum a tree instead of a pile of text.
 */

export const problemSchema = z.object({
  symptom: z.string().min(1),
  cause: z.string().optional(),
  fix: z.string().min(1),
});

export const stepSchema = z.object({
  title: z.string().min(1),
  instructions: z.string().optional(),
  expected_result: z.string().optional(),
  completion_criteria: z.string().optional(),
  prerequisites: z.array(z.string()).default([]),
  problems: z.array(problemSchema).default([]),
});

export const lessonSchema = z.object({
  title: z.string().min(1),
  summary: z.string().optional(),
  steps: z.array(stepSchema).default([]),
});

export const moduleSchema = z.object({
  title: z.string().min(1),
  summary: z.string().optional(),
  lessons: z.array(lessonSchema).default([]),
});

export const referenceSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  kind: z.enum(['reference', 'faq', 'glossary', 'principle']).default('reference'),
});

export const courseSchema = z.object({
  title: z.string().min(1),
  outcome: z.string().optional(),
  audience: z.string().optional(),
  methodology: z.string().optional(),
  modules: z.array(moduleSchema).default([]),
  references: z.array(referenceSchema).default([]),
});

export type ParsedProblem = z.infer<typeof problemSchema>;
export type ParsedStep = z.infer<typeof stepSchema>;
export type ParsedLesson = z.infer<typeof lessonSchema>;
export type ParsedModule = z.infer<typeof moduleSchema>;
export type ParsedCourse = z.infer<typeof courseSchema>;

export interface StructureIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

/**
 * Structural audit run before a course goes live.
 *
 * A curriculum that parses but has no steps, or steps with no expected result,
 * degrades the coach into a generic chatbot: it can talk about the material but
 * cannot tell whether a caller's result is correct or what to do next. Those
 * cases are errors, not warnings, and block publication.
 */
export function auditStructure(course: ParsedCourse): StructureIssue[] {
  const issues: StructureIssue[] = [];
  let stepCount = 0;

  if (course.modules.length === 0) {
    issues.push({
      severity: 'error',
      path: course.title,
      message: 'Course has no modules. Nothing here describes a sequence to coach through.',
    });
  }

  for (const [mi, mod] of course.modules.entries()) {
    const modPath = `module ${mi + 1} "${mod.title}"`;
    if (mod.lessons.length === 0) {
      issues.push({ severity: 'error', path: modPath, message: 'Module has no lessons.' });
    }

    for (const [li, lesson] of mod.lessons.entries()) {
      const lessonPath = `${modPath} > lesson ${li + 1} "${lesson.title}"`;
      if (lesson.steps.length === 0) {
        issues.push({
          severity: 'error',
          path: lessonPath,
          message: 'Lesson has no steps. The coach cannot place a caller inside prose.',
        });
      }

      for (const [si, step] of lesson.steps.entries()) {
        stepCount++;
        const stepPath = `${lessonPath} > step ${si + 1} "${step.title}"`;
        if (!step.instructions) {
          issues.push({
            severity: 'error',
            path: stepPath,
            message: 'Step has no instructions. There is nothing to tell the caller to do.',
          });
        }
        if (!step.expected_result) {
          issues.push({
            severity: 'error',
            path: stepPath,
            message:
              'Step has no expected result. Without it the coach cannot judge whether the ' +
              'caller\'s outcome is wrong, which is the most common reason people call.',
          });
        }
        if (!step.completion_criteria) {
          issues.push({
            severity: 'warning',
            path: stepPath,
            message: 'Step has no completion criteria; advancement will rely on the caller\'s say-so.',
          });
        }
        if (step.problems.length === 0) {
          issues.push({
            severity: 'warning',
            path: stepPath,
            message: 'Step lists no common problems; troubleshooting here will fall back to search.',
          });
        }
      }
    }
  }

  if (stepCount === 0) {
    issues.push({
      severity: 'error',
      path: course.title,
      message: 'Course contains zero steps after parsing — the structure was lost.',
    });
  }

  return issues;
}

export function hasBlockingIssues(issues: StructureIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
