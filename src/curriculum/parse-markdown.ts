import { courseSchema, type ParsedCourse, type ParsedProblem } from './schema.js';

/**
 * Line-oriented parser for the authoring format creators submit.
 *
 *   # Course: Sourdough Mastery
 *   Outcome: A consistently open-crumb loaf
 *   Audience: Home bakers who already keep a starter
 *   Methodology: Temperature-controlled bulk fermentation
 *
 *   ## Module: Starter Health
 *   Summary: Getting a starter strong enough to leaven.
 *
 *   ### Lesson: Reading your starter
 *
 *   #### Step: Feed at 1:5:5
 *   Instructions: Combine 20g starter, 100g flour, 100g water.
 *   Expected result: Doubles in 6-8 hours at 24C.
 *   Completion criteria: Passes the float test twice running.
 *   Prerequisites: Build a starter
 *   Problem: Starter never doubles
 *     Cause: Kitchen below 22C
 *     Fix: Proof in the oven with only the light on.
 *
 *   ## Reference: Hydration table
 *   Body: 70% hydration means 700g water per 1000g flour.
 *
 * Field values continue across lines until the next field key or heading, so
 * long instructions can be written as normal paragraphs.
 */

const HEADING = /^(#{1,4})\s*(course|module|lesson|step|reference)\s*(?:\d+)?\s*:?\s*(.*)$/i;
const FIELD = /^\s*(outcome|audience|methodology|summary|instructions|expected result|completion criteria|prerequisites|problem|cause|fix|body|kind)\s*:\s*(.*)$/i;

type Cursor = {
  course: ParsedCourse;
  moduleIndex: number;
  lessonIndex: number;
  stepIndex: number;
  scope: 'course' | 'module' | 'lesson' | 'step' | 'reference';
  referenceIndex: number;
  problem: ParsedProblem | null;
};

export class CurriculumParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'CurriculumParseError';
  }
}

export function parseCurriculumMarkdown(source: string): ParsedCourse {
  const lines = source.split(/\r?\n/);

  const draft: ParsedCourse = {
    title: '',
    modules: [],
    references: [],
  } as unknown as ParsedCourse;

  const cur: Cursor = {
    course: draft,
    moduleIndex: -1,
    lessonIndex: -1,
    stepIndex: -1,
    referenceIndex: -1,
    scope: 'course',
    problem: null,
  };

  let pendingField: { key: string; buffer: string[] } | null = null;

  const flushField = () => {
    if (!pendingField) return;
    const value = pendingField.buffer.join('\n').trim();
    if (value) applyField(cur, pendingField.key, value);
    pendingField = null;
  };

  const flushProblem = () => {
    if (!cur.problem) return;
    const step = currentStep(cur);
    if (step && cur.problem.symptom && cur.problem.fix) {
      step.problems.push(cur.problem);
    }
    cur.problem = null;
  };

  for (const [i, rawLine] of lines.entries()) {
    const lineNo = i + 1;
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      // Blank lines belong to whatever multi-line value is open.
      if (pendingField) pendingField.buffer.push('');
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushField();
      flushProblem();
      const kind = (heading[2] ?? '').toLowerCase();
      const title = (heading[3] ?? '').trim();
      if (!title) throw new CurriculumParseError(`${kind} heading has no title`, lineNo);
      openScope(cur, kind, title, lineNo);
      continue;
    }

    const field = FIELD.exec(line);
    if (field) {
      const key = (field[1] ?? '').toLowerCase();
      const rest = (field[2] ?? '').trim();

      if (key === 'problem') {
        flushField();
        flushProblem();
        if (cur.scope !== 'step') {
          throw new CurriculumParseError('Problem: must appear inside a Step', lineNo);
        }
        cur.problem = { symptom: rest, fix: '' };
        continue;
      }

      if (key === 'cause' || key === 'fix') {
        flushField();
        if (!cur.problem) {
          throw new CurriculumParseError(`${key}: must follow a Problem:`, lineNo);
        }
        if (key === 'cause') cur.problem.cause = rest;
        else cur.problem.fix = rest;
        pendingField = { key: `problem.${key}`, buffer: [rest] };
        continue;
      }

      flushField();
      pendingField = { key, buffer: [rest] };
      continue;
    }

    // Continuation of the value currently being read.
    if (pendingField) {
      pendingField.buffer.push(line.trim());
      continue;
    }

    // Prose with no field key. Attach it to the nearest natural home rather than
    // dropping it, so a creator's stray paragraph is never silently discarded.
    attachLooseProse(cur, line.trim(), lineNo);
  }

  flushField();
  flushProblem();

  if (!draft.title) {
    throw new CurriculumParseError('No "# Course: <title>" heading found', 1);
  }

  return courseSchema.parse(draft);
}

function openScope(cur: Cursor, kind: string, title: string, lineNo: number): void {
  switch (kind) {
    case 'course':
      cur.course.title = title;
      cur.scope = 'course';
      return;

    case 'module':
      cur.course.modules.push({ title, lessons: [] });
      cur.moduleIndex = cur.course.modules.length - 1;
      cur.lessonIndex = -1;
      cur.stepIndex = -1;
      cur.scope = 'module';
      return;

    case 'lesson': {
      if (cur.moduleIndex < 0) {
        // A lesson before any module heading gets an implicit container rather
        // than throwing away the whole subtree.
        cur.course.modules.push({ title: 'Course content', lessons: [] });
        cur.moduleIndex = cur.course.modules.length - 1;
      }
      const mod = cur.course.modules[cur.moduleIndex]!;
      mod.lessons.push({ title, steps: [] });
      cur.lessonIndex = mod.lessons.length - 1;
      cur.stepIndex = -1;
      cur.scope = 'lesson';
      return;
    }

    case 'step': {
      if (cur.moduleIndex < 0 || cur.lessonIndex < 0) {
        throw new CurriculumParseError(
          'Step appears before any Lesson. Steps must sit inside a lesson so the coach can locate them.',
          lineNo,
        );
      }
      const lesson = cur.course.modules[cur.moduleIndex]!.lessons[cur.lessonIndex]!;
      lesson.steps.push({ title, prerequisites: [], problems: [] });
      cur.stepIndex = lesson.steps.length - 1;
      cur.scope = 'step';
      return;
    }

    case 'reference':
      cur.course.references.push({ title, body: '', kind: 'reference' });
      cur.referenceIndex = cur.course.references.length - 1;
      cur.scope = 'reference';
      return;

    default:
      throw new CurriculumParseError(`Unknown section type: ${kind}`, lineNo);
  }
}

function currentStep(cur: Cursor) {
  if (cur.moduleIndex < 0 || cur.lessonIndex < 0 || cur.stepIndex < 0) return null;
  return cur.course.modules[cur.moduleIndex]?.lessons[cur.lessonIndex]?.steps[cur.stepIndex] ?? null;
}

function applyField(cur: Cursor, key: string, value: string): void {
  if (key === 'problem.cause') {
    if (cur.problem) cur.problem.cause = value;
    return;
  }
  if (key === 'problem.fix') {
    if (cur.problem) cur.problem.fix = value;
    return;
  }

  switch (cur.scope) {
    case 'course':
      if (key === 'outcome') cur.course.outcome = value;
      else if (key === 'audience') cur.course.audience = value;
      else if (key === 'methodology') cur.course.methodology = value;
      return;

    case 'module': {
      const mod = cur.course.modules[cur.moduleIndex];
      if (mod && key === 'summary') mod.summary = value;
      return;
    }

    case 'lesson': {
      const lesson = cur.course.modules[cur.moduleIndex]?.lessons[cur.lessonIndex];
      if (lesson && key === 'summary') lesson.summary = value;
      return;
    }

    case 'step': {
      const step = currentStep(cur);
      if (!step) return;
      if (key === 'instructions') step.instructions = value;
      else if (key === 'expected result') step.expected_result = value;
      else if (key === 'completion criteria') step.completion_criteria = value;
      else if (key === 'prerequisites') {
        step.prerequisites = value
          .split(/[;,\n]/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      return;
    }

    case 'reference': {
      const ref = cur.course.references[cur.referenceIndex];
      if (!ref) return;
      if (key === 'body') ref.body = value;
      else if (key === 'kind') {
        const k = value.toLowerCase();
        if (k === 'faq' || k === 'glossary' || k === 'principle' || k === 'reference') ref.kind = k;
      }
      return;
    }
  }
}

/** Prose with no explicit key still belongs somewhere; never drop a creator's words. */
function attachLooseProse(cur: Cursor, text: string, lineNo: number): void {
  switch (cur.scope) {
    case 'step': {
      const step = currentStep(cur);
      if (!step) return;
      step.instructions = step.instructions ? `${step.instructions}\n${text}` : text;
      return;
    }
    case 'lesson': {
      const lesson = cur.course.modules[cur.moduleIndex]?.lessons[cur.lessonIndex];
      if (lesson) lesson.summary = lesson.summary ? `${lesson.summary}\n${text}` : text;
      return;
    }
    case 'module': {
      const mod = cur.course.modules[cur.moduleIndex];
      if (mod) mod.summary = mod.summary ? `${mod.summary}\n${text}` : text;
      return;
    }
    case 'reference': {
      const ref = cur.course.references[cur.referenceIndex];
      if (ref) ref.body = ref.body ? `${ref.body}\n${text}` : text;
      return;
    }
    case 'course':
      // Preamble before the first module becomes course-level methodology notes.
      cur.course.methodology = cur.course.methodology ? `${cur.course.methodology}\n${text}` : text;
      return;
    default:
      throw new CurriculumParseError(`Unplaceable text: ${text.slice(0, 40)}`, lineNo);
  }
}
