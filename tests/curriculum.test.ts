import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCurriculumMarkdown } from '../src/curriculum/parse-markdown.js';
import { auditStructure, hasBlockingIssues } from '../src/curriculum/schema.js';
import { ingestCourse, StructureLostError } from '../src/curriculum/ingest.js';
import { createTestDb } from '../src/db/index.js';
import { findStepByPosition, getStep, matchProblems, searchCurriculum } from '../src/curriculum/repository.js';
import { id, now } from '../src/util/ids.js';

function seedCreator(db: ReturnType<typeof createTestDb>): string {
  const creatorId = id('creator');
  db.prepare(
    `INSERT INTO creators (id, slug, business_name, coach_name, price_per_minute_cents, created_at, updated_at)
     VALUES (?, ?, ?, ?, 75, ?, ?)`,
  ).run(creatorId, `slug-${creatorId}`, 'Test Co', 'Coach', now(), now());
  return creatorId;
}

const SAMPLE = readFileSync('examples/curriculum-sample.md', 'utf8');

describe('curriculum parsing', () => {
  it('recovers the full tree from the authoring format', () => {
    const course = parseCurriculumMarkdown(SAMPLE);

    expect(course.title).toBe('The Open Crumb Method');
    expect(course.modules).toHaveLength(3);
    expect(course.modules[0]!.title).toBe('Starter Strength');

    const steps = course.modules.flatMap((m) => m.lessons.flatMap((l) => l.steps));
    expect(steps.length).toBeGreaterThanOrEqual(6);

    const feed = steps.find((s) => s.title.includes('one to five'))!;
    expect(feed.expected_result).toContain('double');
    expect(feed.problems).toHaveLength(3);
    expect(feed.problems[0]!.fix).toContain('oven');
  });

  it('keeps multi-line values intact', () => {
    const course = parseCurriculumMarkdown(SAMPLE);
    expect(course.methodology).toContain('Temperature drives everything');
    expect(course.methodology).toContain('stay stuck');
  });

  it('captures references separately from steps', () => {
    const course = parseCurriculumMarkdown(SAMPLE);
    expect(course.references.map((r) => r.kind)).toContain('principle');
    expect(course.references.map((r) => r.kind)).toContain('faq');
  });

  it('rejects a step that appears outside a lesson', () => {
    expect(() =>
      parseCurriculumMarkdown('# Course: X\n\n#### Step: Orphan\nInstructions: do a thing\n'),
    ).toThrow(/before any Lesson/);
  });
});

describe('structure audit', () => {
  it('passes a well-formed course', () => {
    const issues = auditStructure(parseCurriculumMarkdown(SAMPLE));
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  it('blocks a course whose steps have no expected result', () => {
    const course = parseCurriculumMarkdown(
      `# Course: Flat
## Module: One
### Lesson: One
#### Step: Do the thing
Instructions: Do it.
`,
    );
    const issues = auditStructure(course);
    expect(hasBlockingIssues(issues)).toBe(true);
    expect(issues.some((i) => i.message.includes('expected result'))).toBe(true);
  });

  it('blocks prose with no steps at all — the flattening case', () => {
    const course = parseCurriculumMarkdown(
      `# Course: Just prose
## Module: Thoughts
### Lesson: More thoughts
Some general advice about baking that never names a step.
`,
    );
    expect(hasBlockingIssues(auditStructure(course))).toBe(true);
  });
});

describe('ingestion and retrieval', () => {
  it('stores the tree and navigates it by position', () => {
    const db = createTestDb();
    const creatorId = seedCreator(db);
    const result = ingestCourse(db, creatorId, parseCurriculumMarkdown(SAMPLE));

    expect(result.stepCount).toBeGreaterThanOrEqual(6);

    const step = findStepByPosition(db, result.courseId, { module: 2, step: 1 })!;
    expect(step.title).toContain('water temperature');

    const detail = getStep(db, step.id)!;
    expect(detail.moduleSeq).toBe(2);
    expect(detail.nextStepTitle).toContain('end of bulk');
    expect(detail.problems.length).toBeGreaterThan(0);
  });

  it('orders steps across module boundaries', () => {
    const db = createTestDb();
    const creatorId = seedCreator(db);
    const { courseId } = ingestCourse(db, creatorId, parseCurriculumMarkdown(SAMPLE));

    const lastOfModule1 = findStepByPosition(db, courseId, { module: 1, step: 2 })!;
    const detail = getStep(db, lastOfModule1.id)!;
    // The next step lives in the following module, not nowhere.
    expect(detail.nextStepId).not.toBeNull();
    const next = getStep(db, detail.nextStepId!)!;
    expect(next.moduleSeq).toBe(2);
  });

  it('refuses to ingest a course that failed the audit', () => {
    const db = createTestDb();
    const creatorId = seedCreator(db);
    const flat = parseCurriculumMarkdown('# Course: Flat\n## Module: M\n### Lesson: L\nJust prose.\n');
    expect(() => ingestCourse(db, creatorId, flat)).toThrow(StructureLostError);
  });

  it('finds troubleshooting from a symptom in the caller\'s own words', () => {
    const db = createTestDb();
    const creatorId = seedCreator(db);
    const { courseId } = ingestCourse(db, creatorId, parseCurriculumMarkdown(SAMPLE));

    const hits = searchCurriculum(db, courseId, 'my dough is soupy and spreading everywhere');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.refKind).toBe('problem');
    expect(hits[0]!.body).toContain('fifty percent');
  });

  it('never returns another creator\'s material', () => {
    const db = createTestDb();
    const a = seedCreator(db);
    const b = seedCreator(db);
    const courseA = ingestCourse(db, a, parseCurriculumMarkdown(SAMPLE)).courseId;
    ingestCourse(db, b, parseCurriculumMarkdown(SAMPLE.replace('The Open Crumb Method', 'Rival Method')));

    const hits = searchCurriculum(db, courseA, 'dough temperature');
    expect(hits.length).toBeGreaterThan(0);
    const owners = new Set(
      hits.map(
        (h) =>
          (
            db.prepare('SELECT course_id FROM curriculum_fts WHERE ref_id = ?').get(h.refId) as {
              course_id: string;
            }
          ).course_id,
      ),
    );
    expect([...owners]).toEqual([courseA]);
  });

  it('ranks the matching problem first for a step-local symptom', () => {
    const db = createTestDb();
    const creatorId = seedCreator(db);
    const { courseId } = ingestCourse(db, creatorId, parseCurriculumMarkdown(SAMPLE));
    const step = findStepByPosition(db, courseId, { module: 1, step: 1 })!;

    const matches = matchProblems(db, step.id, 'it smells like nail polish remover');
    expect(matches[0]!.symptom).toContain('nail polish');
  });

  it('tolerates punctuation and search operators in caller speech', () => {
    const db = createTestDb();
    const creatorId = seedCreator(db);
    const { courseId } = ingestCourse(db, creatorId, parseCurriculumMarkdown(SAMPLE));
    expect(() => searchCurriculum(db, courseId, 'why "won\'t" it rise? OR NOT (bulk)')).not.toThrow();
  });
});
