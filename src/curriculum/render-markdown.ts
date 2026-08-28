import type { ParsedCourse } from './schema.js';

/**
 * Renders a ParsedCourse back into the authoring format parse-markdown.ts reads.
 *
 * This exists so machine-extracted curriculum can rejoin the same pipeline
 * hand-authored curriculum uses. Structuring raw material produces a
 * ParsedCourse; rendering it to markdown means the creator reviews and edits
 * ordinary text, and the result goes through the same parser, the same
 * structure audit and the same ingest that has always run. No second
 * ingestion path, no "trust the model" shortcut around the audit, and the
 * creator can fix anything by editing the text directly.
 *
 * Field values are collapsed to a single line. The parser treats a line
 * beginning with a known key (`Instructions:`, `Fix:`, …) or a `#` heading as
 * a new field, and it tolerates leading whitespace, so indenting a
 * continuation line would not protect it. Collapsing is the one rendering
 * that cannot produce a document which reparses differently — which the
 * round-trip tests assert directly.
 */

function line(value: string | undefined | null): string {
  if (!value) return '';
  return value.replace(/\s*\n+\s*/g, ' ').trim();
}

export function renderCourseToMarkdown(course: ParsedCourse): string {
  const out: string[] = [];

  out.push(`# Course: ${line(course.title)}`);
  if (course.outcome) out.push(`Outcome: ${line(course.outcome)}`);
  if (course.audience) out.push(`Audience: ${line(course.audience)}`);
  if (course.methodology) out.push(`Methodology: ${line(course.methodology)}`);

  for (const mod of course.modules) {
    out.push('', `## Module: ${line(mod.title)}`);
    if (mod.summary) out.push(`Summary: ${line(mod.summary)}`);

    for (const lesson of mod.lessons) {
      out.push('', `### Lesson: ${line(lesson.title)}`);
      if (lesson.summary) out.push(`Summary: ${line(lesson.summary)}`);

      for (const step of lesson.steps) {
        out.push('', `#### Step: ${line(step.title)}`);
        if (step.instructions) out.push(`Instructions: ${line(step.instructions)}`);
        if (step.expected_result) out.push(`Expected result: ${line(step.expected_result)}`);
        if (step.completion_criteria) out.push(`Completion criteria: ${line(step.completion_criteria)}`);
        if (step.prerequisites?.length) {
          out.push(`Prerequisites: ${step.prerequisites.map(line).filter(Boolean).join(', ')}`);
        }
        for (const problem of step.problems) {
          out.push(`Problem: ${line(problem.symptom)}`);
          if (problem.cause) out.push(`  Cause: ${line(problem.cause)}`);
          out.push(`  Fix: ${line(problem.fix)}`);
        }
      }
    }
  }

  for (const ref of course.references) {
    out.push('', `## Reference: ${line(ref.title)}`);
    out.push(`Body: ${line(ref.body)}`);
    if (ref.kind && ref.kind !== 'reference') out.push(`Kind: ${ref.kind}`);
  }

  return out.join('\n') + '\n';
}
