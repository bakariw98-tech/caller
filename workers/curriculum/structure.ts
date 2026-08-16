import { courseSchema, type ParsedCourse } from '../../src/curriculum/schema.js';
import { chatCompletionJson } from '../xai/client.js';

/**
 * Turns a creator's raw material into structured curriculum.
 *
 * Creators do not write in the authoring format, and asking them to was the
 * single biggest thing standing between "I have a course" and "my coach
 * works". They have a PDF, a Google Doc, a list of questions customers keep
 * asking, a video transcript. This takes those and produces the tree the
 * coach needs.
 *
 * ── The safety property that matters ──────────────────────────────────────
 *
 * Extraction here is far more dangerous than a wrong answer during a call. A
 * call is one conversation; a fabricated step is permanent, wears the
 * creator's name, and gets spoken to every future caller as that creator's
 * own method. A made-up "fix" in a baking course is embarrassing. In a
 * fitness, medical or financial course it is worse than that.
 *
 * So this is extractive, never generative, and the prompt says so in the
 * terms that actually bind behaviour: leaving a field empty is correct,
 * inventing one to look complete is harmful. Gaps are meant to survive — the
 * existing structure audit turns them into the creator's to-do list. Nothing
 * here tries to make output that "passes" the audit, because a model asked
 * to satisfy an audit will invent exactly the fields the audit checks for.
 *
 * Every step and problem also carries a verbatim `source_quote`, so a creator
 * reviewing the draft can see where each piece came from rather than taking
 * it on faith.
 */

export type SourceKind = 'curriculum' | 'guide' | 'faq' | 'roadblocks' | 'transcript' | 'notes';

export interface RawSource {
  kind: SourceKind;
  title?: string;
  text: string;
}

export interface ProvenanceEntry {
  path: string;
  quote: string;
}

export interface StructureResult {
  course: ParsedCourse;
  provenance: ProvenanceEntry[];
  usage: { promptTokens: number; completionTokens: number; costUsd: number };
}

export class NoUsableSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoUsableSourceError';
  }
}

/** Guards cost and latency. Roughly 250k tokens; a very large book, not a course. */
const MAX_TOTAL_CHARS = 1_000_000;

const problemJson = {
  type: 'object',
  properties: {
    symptom: { type: 'string', description: "The problem as the source describes it, in the creator's words." },
    cause: { type: 'string', description: 'Only if the source states a cause.' },
    fix: { type: 'string', description: 'The fix the source actually gives. Never your own advice.' },
    source_quote: { type: 'string', description: 'Verbatim span from the source describing this problem.' },
  },
  required: ['symptom', 'fix', 'source_quote'],
  additionalProperties: false,
} as const;

const stepJson = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    instructions: { type: 'string', description: 'What the learner does. Omit if the source never says.' },
    expected_result: {
      type: 'string',
      description: 'What the result should look like, ONLY if the source states it. Omit otherwise.',
    },
    completion_criteria: {
      type: 'string',
      description: 'How to know the step is done, ONLY if the source states it. Omit otherwise.',
    },
    problems: { type: 'array', items: problemJson },
    source_quote: { type: 'string', description: 'Verbatim span from the source this step is based on.' },
  },
  required: ['title', 'problems', 'source_quote'],
  additionalProperties: false,
} as const;

const lessonJson = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    steps: { type: 'array', items: stepJson },
  },
  required: ['title', 'steps'],
  additionalProperties: false,
} as const;

const moduleJson = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    lessons: { type: 'array', items: lessonJson },
  },
  required: ['title', 'lessons'],
  additionalProperties: false,
} as const;

const referenceJson = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
    kind: { type: 'string', enum: ['reference', 'faq', 'glossary', 'principle'] },
  },
  required: ['title', 'body', 'kind'],
  additionalProperties: false,
} as const;

const courseJson = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    outcome: { type: 'string', description: 'The outcome the course promises, if the source states one.' },
    audience: { type: 'string', description: 'Who it is for, if the source says.' },
    methodology: {
      type: 'string',
      description: "The creator's overall approach in their own words, if the source expresses one.",
    },
    modules: { type: 'array', items: moduleJson },
    references: { type: 'array', items: referenceJson },
  },
  required: ['title', 'modules', 'references'],
  additionalProperties: false,
} as const;

const SYSTEM = `You convert a creator's teaching material into structured curriculum for a phone coach.

You are EXTRACTIVE, never generative. Every field must trace to the source text.

These rules outrank completeness. A sparse, accurate course is a success. A
complete-looking course containing anything the creator did not say is a
failure, because a voice coach will speak it to their customers as their own
method:

- Never invent a step, measurement, threshold, timing, tool, or fix.
- If the source does not state a step's expected result or completion
  criteria, OMIT THE FIELD. Do not infer it, do not generalise it from
  similar steps, do not write something plausible. An omitted field is
  correct and will be surfaced to the creator to fill in. An invented one is
  harmful and may never be caught.
- problems[] may contain only problems the source actually describes, paired
  with the fix the source actually gives. If the source describes none for a
  step, return an empty array. Do not supply common-knowledge troubleshooting.
- Phrase each symptom the way the caller would say it out loud, not the way
  the material narrates it. "My brew tastes like nothing" and "the filter is
  taking forever" are symptoms. "The number one mistake here is squeezing the
  filter" is narration — the symptom underneath it is "I squeezed the filter
  to speed it up". A coach matches a caller's own words against these, so
  narration phrasing makes real problems unfindable at the moment they matter.
- Attach a problem to the one step where the caller would actually hit it. Do
  not copy the same problem onto several steps as a precaution.
- Never merge two different things the source said into one claim.
- source_quote must be a verbatim span copied from the source. If you cannot
  quote it, do not emit the item.

Structure guidance:
- Steps are things a learner DOES, in order. Prefer the source's own ordering.
- Group steps into lessons and lessons into modules following the source's own
  divisions (weeks, phases, chapters, sections). Only introduce a grouping the
  source lacks if there is genuinely no structure, and keep it minimal.
- Material tagged faq or roadblocks is usually troubleshooting: attach each
  item to the step it concerns as a problem. If it does not belong to any
  step, put it in references with kind "faq".
- Standalone explanation that is not a step — principles, glossaries,
  background — belongs in references, not invented into steps.
- Transcripts are spoken and rambling. Extract the teaching; drop the filler,
  greetings and asides. Do not smooth over a gap by filling it in.`;

interface RawStep {
  title: string;
  instructions?: string;
  expected_result?: string;
  completion_criteria?: string;
  problems: { symptom: string; cause?: string; fix: string; source_quote: string }[];
  source_quote: string;
}
interface RawCourseJson {
  title: string;
  outcome?: string;
  audience?: string;
  methodology?: string;
  modules: { title: string; summary?: string; lessons: { title: string; summary?: string; steps: RawStep[] }[] }[];
  references: { title: string; body: string; kind: 'reference' | 'faq' | 'glossary' | 'principle' }[];
}

const KIND_LABEL: Record<SourceKind, string> = {
  curriculum: 'COURSE / CURRICULUM',
  guide: 'HOW-TO GUIDE',
  faq: 'FREQUENTLY ASKED QUESTIONS',
  roadblocks: 'COMMON ROADBLOCKS CUSTOMERS HIT',
  transcript: 'VIDEO / AUDIO TRANSCRIPT',
  notes: 'NOTES',
};

export async function structureCurriculum(
  params: {
    apiBase: string;
    apiKey: string;
    model: string;
    sources: RawSource[];
    courseTitleHint?: string;
  },
): Promise<StructureResult> {
  const usable = params.sources.filter((s) => s.text.trim().length > 0);
  if (usable.length === 0) {
    throw new NoUsableSourceError('No material to work from — every source was empty.');
  }

  const totalChars = usable.reduce((n, s) => n + s.text.length, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    throw new NoUsableSourceError(
      `That is ${Math.round(totalChars / 1000)}k characters of material, over the ${Math.round(
        MAX_TOTAL_CHARS / 1000,
      )}k limit for one pass. Split it into separate courses, or trim the least instructional parts.`,
    );
  }

  // Sources are labelled rather than concatenated blindly: knowing a block is
  // an FAQ versus a curriculum changes where its content correctly belongs.
  const user = [
    params.courseTitleHint ? `The creator calls this course: ${params.courseTitleHint}` : '',
    'Convert the following material into structured curriculum.',
    '',
    ...usable.map((s, i) => {
      const header = `----- SOURCE ${i + 1} — ${KIND_LABEL[s.kind]}${s.title ? ` — ${s.title}` : ''} -----`;
      return `${header}\n${s.text.trim()}`;
    }),
  ]
    .filter(Boolean)
    .join('\n\n');

  const { value, usage } = await chatCompletionJson<RawCourseJson>(params.apiBase, params.apiKey, {
    model: params.model,
    system: SYSTEM,
    user,
    schemaName: 'curriculum',
    schema: courseJson as unknown as Record<string, unknown>,
  });

  // Split provenance out of the tree: the ParsedCourse contract has no place
  // for it, and it is review material rather than curriculum.
  const provenance: ProvenanceEntry[] = [];
  const stripped = {
    title: value.title,
    outcome: value.outcome,
    audience: value.audience,
    methodology: value.methodology,
    references: value.references ?? [],
    modules: (value.modules ?? []).map((m) => ({
      title: m.title,
      summary: m.summary,
      lessons: (m.lessons ?? []).map((l) => ({
        title: l.title,
        summary: l.summary,
        steps: (l.steps ?? []).map((s) => {
          const path = `${m.title} > ${l.title} > ${s.title}`;
          if (s.source_quote) provenance.push({ path, quote: s.source_quote });
          for (const p of s.problems ?? []) {
            if (p.source_quote) provenance.push({ path: `${path} > problem: ${p.symptom}`, quote: p.source_quote });
          }
          return {
            title: s.title,
            instructions: s.instructions,
            expected_result: s.expected_result,
            completion_criteria: s.completion_criteria,
            prerequisites: [],
            problems: (s.problems ?? []).map((p) => ({ symptom: p.symptom, cause: p.cause, fix: p.fix })),
          };
        }),
      })),
    })),
  };

  // Validated against the same zod contract hand-authored curriculum meets,
  // so a malformed extraction fails here rather than downstream.
  const course = courseSchema.parse(stripped);

  return {
    course,
    provenance,
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      costUsd: (usage.cost_in_usd_ticks ?? 0) / 1e9,
    },
  };
}
