import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderCourseToMarkdown } from '../src/curriculum/render-markdown.js';
import { parseCurriculumMarkdown } from '../src/curriculum/parse-markdown.js';
import { auditStructure, hasBlockingIssues, type ParsedCourse } from '../src/curriculum/schema.js';

const SAMPLE = readFileSync('examples/curriculum-sample.md', 'utf8');

describe('render → parse round trip', () => {
  it('survives a full real course unchanged', () => {
    const original = parseCurriculumMarkdown(SAMPLE);
    const reparsed = parseCurriculumMarkdown(renderCourseToMarkdown(original));
    expect(reparsed).toEqual(original);
  });

  it('is stable across repeated round trips', () => {
    const once = renderCourseToMarkdown(parseCurriculumMarkdown(SAMPLE));
    const twice = renderCourseToMarkdown(parseCurriculumMarkdown(once));
    expect(twice).toBe(once);
  });

  it('keeps a clean course passing its audit after the round trip', () => {
    const reparsed = parseCurriculumMarkdown(renderCourseToMarkdown(parseCurriculumMarkdown(SAMPLE)));
    expect(hasBlockingIssues(auditStructure(reparsed))).toBe(false);
  });

  /**
   * The dangerous case: model-written prose containing text that looks like
   * the authoring format's own syntax. If rendering let that through raw, the
   * parser would read it as new fields and silently restructure the course.
   */
  it('neutralises field keys and headings appearing inside values', () => {
    const hostile: ParsedCourse = {
      title: 'Hostile',
      modules: [
        {
          title: 'M',
          lessons: [
            {
              title: 'L',
              steps: [
                {
                  title: 'S',
                  instructions: 'Do the thing.\nFix: this line must not become a field.\n# Course: not a new course',
                  expected_result: 'Problem: this is not a problem entry',
                  prerequisites: [],
                  problems: [{ symptom: 'sym', fix: 'Instructions: still just text' }],
                },
              ],
            },
          ],
        },
      ],
      references: [],
    };

    const reparsed = parseCurriculumMarkdown(renderCourseToMarkdown(hostile));
    const step = reparsed.modules[0]!.lessons[0]!.steps[0]!;

    expect(reparsed.modules).toHaveLength(1);
    expect(reparsed.title).toBe('Hostile');
    expect(step.instructions).toContain('this line must not become a field');
    expect(step.expected_result).toContain('this is not a problem entry');
    expect(step.problems).toHaveLength(1);
    expect(step.problems[0]!.fix).toContain('still just text');
  });

  it('omits empty optional fields rather than emitting blank ones', () => {
    const sparse: ParsedCourse = {
      title: 'Sparse',
      modules: [
        { title: 'M', lessons: [{ title: 'L', steps: [{ title: 'S', prerequisites: [], problems: [] }] }] },
      ],
      references: [],
    };
    const md = renderCourseToMarkdown(sparse);
    expect(md).not.toContain('Instructions:');
    expect(md).not.toContain('Expected result:');

    // The gap survives instead of being papered over — the audit must still
    // catch it, since that is what tells the creator what to fill in.
    expect(hasBlockingIssues(auditStructure(parseCurriculumMarkdown(md)))).toBe(true);
  });

  it('round-trips references with their kind', () => {
    const withRefs: ParsedCourse = {
      title: 'R',
      modules: [
        { title: 'M', lessons: [{ title: 'L', steps: [{ title: 'S', instructions: 'i', expected_result: 'e', prerequisites: [], problems: [] }] }] },
      ],
      references: [
        { title: 'FAQ item', body: 'some answer', kind: 'faq' },
        { title: 'Plain', body: 'body text', kind: 'reference' },
      ],
    };
    const reparsed = parseCurriculumMarkdown(renderCourseToMarkdown(withRefs));
    expect(reparsed.references).toEqual(withRefs.references);
  });
});
