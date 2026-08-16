import type { SqlDb } from '../db/types.js';
import { id, now } from '../../src/util/ids.js';
import type { Creator, Customer, Enrollment, Step } from '../../src/domain/types.js';
import {
  findStepByPosition,
  getStep,
  matchProblems,
  searchCurriculum,
  type StepDetail,
} from '../curriculum/repository.js';
import {
  appendTransition,
  completeAndAdvance,
  describeProgress,
  openProblems,
} from '../state/transitions.js';
import { balanceSeconds } from '../billing/wallet.js';
import type { McpSession } from './auth.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Same tool surface and descriptions as src/mcp/tools.ts — see that file for the rationale. */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_caller_state',
    description:
      "Who you are speaking with and exactly where they are in the course. Call this first, before " +
      "assuming anything about the caller. You have no way to see who is calling — ask them for their " +
      "passcode (they got one when they signed up) and pass it here as passcode. Once you have it, keep " +
      "passing that same passcode to every other tool for the rest of this call, since nothing else " +
      "carries who they are from one tool call to the next.",
    inputSchema: {
      type: 'object',
      properties: {
        passcode: { type: 'string', description: "The caller's passcode, once you've asked for it." },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_current_step',
    description:
      "The full material for the step the caller is standing on: instructions, what the result should " +
      "look like, how to know it is done, and the problems the creator says people hit here. Pass the " +
      "same passcode you already collected this call.",
    inputSchema: {
      type: 'object',
      properties: { passcode: { type: 'string', description: 'The passcode collected earlier this call.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_step_by_position',
    description:
      'Material for a specific place in the course, for when the caller names one — "module four", ' +
      '"the second step of lesson three". Give whichever of module, lesson and step numbers you were told.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'integer', description: 'Module number, 1-based.' },
        lesson: { type: 'integer', description: 'Lesson number within the module, 1-based.' },
        step: { type: 'integer', description: 'Step number within the lesson, 1-based.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_curriculum',
    description:
      "Search the creator's material when the caller asks about something you cannot place in the " +
      'sequence. Pass their own words. Returns nothing when the material does not cover it — say so ' +
      'rather than filling the gap yourself.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: "What to look for, in the caller's own words." } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'diagnose_problem',
    description:
      'The troubleshooting the creator wrote for a symptom at a specific step. Use this whenever the ' +
      'caller reports that something went wrong, before reasoning about the cause yourself. Pass the ' +
      "passcode too, if you have it — it helps find the problem for the step they're actually on.",
    inputSchema: {
      type: 'object',
      properties: {
        symptom: { type: 'string', description: 'What the caller says is happening.' },
        module: { type: 'integer', description: 'Module number, if they named one.' },
        step: { type: 'integer', description: 'Step number, if they named one.' },
        passcode: { type: 'string', description: 'The passcode collected earlier this call, if you have it.' },
      },
      required: ['symptom'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_progress',
    description:
      "Record what changed for this caller, the moment it changes — not at the end of the call, since " +
      'calls drop. Two of these matter most and only you can know them: call resolved_problem the ' +
      'moment the caller confirms a fix worked, and completed_step the moment they finish a step (that ' +
      'also moves them to the next one). If a call ends without these, their next call starts from ' +
      'stale information. Also use started_step and noted_preference where they fit. You do not need ' +
      'to record a problem when you look one up — that is already recorded for you. Requires the ' +
      'passcode you collected earlier this call.',
    inputSchema: {
      type: 'object',
      properties: {
        event: {
          type: 'string',
          enum: ['started_step', 'hit_problem', 'resolved_problem', 'completed_step', 'noted_preference'],
        },
        problem: { type: 'string', description: 'What went wrong, for hit_problem or resolved_problem.' },
        resolution: { type: 'string', description: 'What fixed it, for resolved_problem.' },
        note: { type: 'string', description: 'Short note worth carrying into the next call.' },
        passcode: { type: 'string', description: 'The passcode collected earlier this call.' },
      },
      required: ['event'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_human',
    description:
      'Hand the caller to a person. Use when the material genuinely does not cover what they need, or ' +
      'when they ask for a human. Set transfer to true only if they want to be connected right now.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the curriculum could not answer this.' },
        question: { type: 'string', description: "The caller's question, for the creator to follow up." },
        passcode: { type: 'string', description: 'The passcode collected earlier this call, if you have it.' },
        transfer: { type: 'boolean', description: 'True to connect them to a person now.' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

export interface ToolContext {
  db: SqlDb;
  session: McpSession;
  /** Requests the owning Durable Object perform a live SIP REFER transfer. */
  transferCall?: (targetE164: string) => Promise<void>;
  logEvent?: (type: string, payload: Record<string, unknown>, stepId?: string | null) => Promise<void>;
}

export interface ToolResult {
  data: unknown;
  isError?: boolean;
}

export async function callTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'get_caller_state':
      return getCallerState(ctx, args);
    case 'get_current_step':
      return getCurrentStep(ctx, args);
    case 'get_step_by_position':
      return getStepByPosition(ctx, args);
    case 'search_curriculum':
      return doSearch(ctx, args);
    case 'diagnose_problem':
      return doDiagnose(ctx, args);
    case 'record_progress':
      return doRecordProgress(ctx, args);
    case 'request_human':
      return doRequestHuman(ctx, args);
    default:
      return { data: { error: `Unknown tool: ${name}` }, isError: true };
  }
}

interface Identity {
  customer: Customer | null;
  enrollment: Enrollment | null;
}

/**
 * Resolves who the tools are dealing with, two possible ways:
 *
 *  1. Session-bound (this platform's own webhook path): the caller was
 *     identified from real caller ID before the call even reached the model,
 *     and the token already carries customer_id/enrollment_id. No argument
 *     needed.
 *  2. Passcode (any integration that never gives this platform caller ID at
 *     all — see mcp/tools.ts's TOOL_DEFINITIONS descriptions): the model was
 *     told to ask the caller for their passcode and pass it as an argument.
 *     There is no per-call session on that path, so this repeats on every
 *     tool call that needs to know who's calling — see docs/XAI-API-NOTES.md
 *     for why that repetition is the actual constraint, not an oversight.
 *
 * Session identity wins when both are somehow present, since it came from a
 * channel the caller cannot misstate.
 */
async function resolveIdentity(ctx: ToolContext, args: Record<string, unknown>): Promise<Identity> {
  if (ctx.session.customer_id) {
    const customer = await ctx.db.prepare('SELECT * FROM customers WHERE id = ?').get<Customer>(ctx.session.customer_id);
    const enrollment = ctx.session.enrollment_id
      ? await ctx.db.prepare('SELECT * FROM enrollments WHERE id = ?').get<Enrollment>(ctx.session.enrollment_id)
      : null;
    return { customer: customer ?? null, enrollment: enrollment ?? null };
  }

  const passcode = typeof args.passcode === 'string' ? args.passcode.trim() : '';
  if (!passcode) return { customer: null, enrollment: null };

  const customer = await ctx.db
    .prepare('SELECT * FROM customers WHERE creator_id = ? AND passcode = ?')
    .get<Customer>(ctx.session.creator_id, passcode);
  if (!customer) {
    await ctx.logEvent?.('passcode_not_found', {});
    return { customer: null, enrollment: null };
  }

  const enrollment = await ctx.db
    .prepare('SELECT * FROM enrollments WHERE customer_id = ? AND course_id = ?')
    .get<Enrollment>(customer.id, ctx.session.course_id);
  return { customer, enrollment: enrollment ?? null };
}

function renderStep(detail: StepDetail) {
  return {
    position: `Module ${detail.moduleSeq}, Lesson ${detail.lessonSeq}, Step ${detail.step.seq}`,
    module: detail.moduleTitle,
    lesson: detail.lessonTitle,
    title: detail.step.title,
    instructions: detail.step.instructions,
    expected_result: detail.step.expected_result,
    completion_criteria: detail.step.completion_criteria,
    common_problems: detail.problems.map((p) => ({ symptom: p.symptom, cause: p.cause, fix: p.fix })),
    next_step: detail.nextStepTitle,
  };
}

/** No identity yet — either the passcode wasn't asked for, or it didn't match anyone. */
const NOT_IDENTIFIED = {
  identified: false,
  guidance:
    'This caller has not been identified. Do not reveal any account or progress information. Ask for ' +
    'their passcode — everyone gets one when they sign up. If they say they never signed up, or the ' +
    'passcode does not match anyone, tell them where to sign up and do not guess at their identity.',
};

async function getCallerState(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const { customer, enrollment } = await resolveIdentity(ctx, args);
  if (!customer || !enrollment) return { data: NOT_IDENTIFIED };

  const current = enrollment.current_step_id ? await getStep(ctx.db, enrollment.current_step_id) : null;
  const open = await openProblems(ctx.db, enrollment.id);
  const balance = await balanceSeconds(ctx.db, customer.id, ctx.session.creator_id);

  return {
    data: {
      identified: true,
      first_name: customer.name?.split(/\s+/)[0] ?? null,
      position: current
        ? `Module ${current.moduleSeq}, Lesson ${current.lessonSeq}, Step ${current.step.seq}: ${current.step.title}`
        : enrollment.status === 'completed'
          ? 'Has finished the course'
          : 'Has not started yet',
      progress_summary: await describeProgress(ctx.db, enrollment),
      unresolved_problems: open.map((p) => p.problem).filter(Boolean),
      minutes_remaining: Math.floor(balance / 60),
    },
  };
}

async function getCurrentStep(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const { enrollment } = await resolveIdentity(ctx, args);
  if (!enrollment) return { data: NOT_IDENTIFIED };
  if (!enrollment.current_step_id) {
    return { data: { message: 'This caller has not started the course. Begin at the first step.' } };
  }
  const detail = await getStep(ctx.db, enrollment.current_step_id);
  if (!detail) return { data: { message: 'That step is no longer in the current version of the course.' } };
  await ctx.logEvent?.('step_viewed', { step: detail.step.title }, detail.step.id);
  return { data: renderStep(detail) };
}

async function getStepByPosition(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const pos = {
    module: typeof args.module === 'number' ? args.module : undefined,
    lesson: typeof args.lesson === 'number' ? args.lesson : undefined,
    step: typeof args.step === 'number' ? args.step : undefined,
  };
  if (pos.module === undefined && pos.lesson === undefined && pos.step === undefined) {
    return { data: { error: 'Give at least one of module, lesson or step.' }, isError: true };
  }

  const step = await findStepByPosition(ctx.db, ctx.session.course_id, pos);
  if (!step) {
    return {
      data: {
        found: false,
        message:
          'There is no such position in this course. Tell the caller you cannot find that and ask them ' +
          'to describe what they are working on instead.',
      },
    };
  }
  const detail = (await getStep(ctx.db, step.id))!;
  await ctx.logEvent?.('step_viewed', { step: detail.step.title }, step.id);
  return { data: renderStep(detail) };
}

async function doSearch(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query : '';
  if (!query.trim()) return { data: { error: 'query is required' }, isError: true };

  const { enrollment } = await resolveIdentity(ctx, args);
  const hits = await searchCurriculum(ctx.db, ctx.session.course_id, query, {
    nearStepId: enrollment?.current_step_id ?? null,
    limit: 5,
  });

  await ctx.logEvent?.('search', { query, hits: hits.length });

  if (hits.length === 0) {
    return {
      data: {
        found: false,
        message:
          "The creator's material does not cover this. Tell the caller plainly that it is outside what " +
          'you have, and do not answer from general knowledge.',
      },
    };
  }

  return { data: { found: true, results: hits.map((h) => ({ kind: h.refKind, title: h.title, content: h.body })) } };
}

/**
 * Records that the caller hit a problem, inferred from the coach asking to
 * diagnose one. See src/mcp/tools.ts's copy of this function for the full
 * reasoning — in short, a real call diagnosed three problems and recorded
 * none of them, because `record_progress` depended on the model remembering
 * to narrate its own bookkeeping mid-conversation. Anything inferable from a
 * tool the coach already has a reason to call is inferred server-side instead.
 *
 * Idempotent by (step, first 60 chars of problem), matching how
 * `openProblems` keys them.
 */
async function autoRecordProblem(
  ctx: ToolContext,
  enrollment: Enrollment | null,
  step: Step | null,
  symptom: string,
): Promise<void> {
  if (!enrollment || !step) return;

  const open = await openProblems(ctx.db, enrollment.id);
  const alreadyOpen = open.some(
    (p) =>
      (p.to_step_id ?? p.from_step_id) === step.id &&
      (p.problem ?? '').toLowerCase().slice(0, 60) === symptom.toLowerCase().slice(0, 60),
  );
  if (alreadyOpen) return;

  await appendTransition(ctx.db, {
    enrollmentId: enrollment.id,
    eventType: 'hit_problem',
    fromStepId: step.id,
    toStepId: step.id,
    problem: symptom,
    source: 'inferred',
    callId: ctx.session.call_id,
  });
}

async function doDiagnose(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const symptom = typeof args.symptom === 'string' ? args.symptom : '';
  if (!symptom.trim()) return { data: { error: 'symptom is required' }, isError: true };

  const { enrollment } = await resolveIdentity(ctx, args);
  let step: Step | null = null;

  if (typeof args.module === 'number' || typeof args.step === 'number') {
    step = await findStepByPosition(ctx.db, ctx.session.course_id, {
      module: typeof args.module === 'number' ? args.module : undefined,
      step: typeof args.step === 'number' ? args.step : undefined,
    });
  }
  if (!step && enrollment?.current_step_id) {
    step = (await ctx.db.prepare('SELECT * FROM steps WHERE id = ?').get<Step>(enrollment.current_step_id)) ?? null;
  }

  const matches = step ? await matchProblems(ctx.db, step.id, symptom) : [];
  await ctx.logEvent?.('problem_reported', { symptom, matched: matches.length }, step?.id ?? null);
  await autoRecordProblem(ctx, enrollment, step, symptom);

  if (matches.length > 0) {
    return {
      data: {
        found: true,
        step: step ? step.title : null,
        troubleshooting: matches.map((m) => ({ symptom: m.symptom, cause: m.cause, fix: m.fix })),
        guidance: 'Work through the closest match first. Give one action, then check the result.',
      },
    };
  }

  const hits = await searchCurriculum(ctx.db, ctx.session.course_id, symptom, { nearStepId: step?.id ?? null, limit: 3 });
  if (hits.length > 0) {
    return {
      data: {
        found: true,
        from_elsewhere: true,
        results: hits.map((h) => ({ kind: h.refKind, title: h.title, content: h.body })),
        guidance:
          'This came from elsewhere in the course, not from the troubleshooting for their step. Check it ' +
          'fits what they described before offering it.',
      },
    };
  }

  return {
    data: {
      found: false,
      message:
        'The creator has not documented this problem. Say so plainly, offer what the step does say the ' +
        'result should look like, and consider request_human.',
    },
  };
}

async function doRecordProgress(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const { enrollment } = await resolveIdentity(ctx, args);
  if (!enrollment) return { data: NOT_IDENTIFIED };

  const event = String(args.event ?? '');
  const problem = typeof args.problem === 'string' ? args.problem : null;
  const resolution = typeof args.resolution === 'string' ? args.resolution : null;
  const note = typeof args.note === 'string' ? args.note : null;
  const currentStepId = enrollment.current_step_id;

  switch (event) {
    case 'completed_step': {
      const { completed, advancedTo } = await completeAndAdvance(ctx.db, enrollment, { callId: ctx.session.call_id, note });
      await ctx.logEvent?.('step_completed', { step: completed?.title ?? null }, completed?.id ?? null);
      return {
        data: {
          recorded: true,
          completed: completed?.title ?? null,
          now_on: advancedTo ? advancedTo.title : 'Nothing — they have finished the last step of the course.',
        },
      };
    }
    case 'hit_problem':
    case 'resolved_problem':
    case 'started_step':
    case 'noted_preference': {
      await appendTransition(ctx.db, {
        enrollmentId: enrollment.id,
        eventType: event,
        fromStepId: currentStepId,
        toStepId: currentStepId,
        problem,
        resolution,
        note,
        callId: ctx.session.call_id,
      });
      if (event === 'hit_problem') await ctx.logEvent?.('problem_recorded', { problem }, currentStepId);
      return { data: { recorded: true } };
    }
    default:
      return { data: { error: `Unknown event: ${event}` }, isError: true };
  }
}

async function doRequestHuman(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const reason = typeof args.reason === 'string' ? args.reason : 'unspecified';
  const question = typeof args.question === 'string' ? args.question : null;
  const wantsTransfer = args.transfer === true;

  const creator = await ctx.db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(ctx.session.creator_id);
  const { customer, enrollment } = await resolveIdentity(ctx, args);

  await ctx.db
    .prepare(
      `INSERT INTO escalations (id, creator_id, customer_id, call_id, step_id, reason, question, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(id('esc'), ctx.session.creator_id, customer?.id ?? null, ctx.session.call_id, enrollment?.current_step_id ?? null, reason, question, now());

  if (enrollment) {
    await appendTransition(ctx.db, {
      enrollmentId: enrollment.id,
      eventType: 'escalated',
      fromStepId: enrollment.current_step_id,
      toStepId: enrollment.current_step_id,
      note: reason,
      callId: ctx.session.call_id,
    });
  }
  await ctx.logEvent?.('escalation', { reason, transfer: wantsTransfer }, enrollment?.current_step_id ?? null);

  const policy = creator?.escalation_policy ?? 'offer_human';
  const canTransfer = policy !== 'ticket_only' && Boolean(creator?.escalation_phone) && Boolean(ctx.transferCall);

  if (wantsTransfer && canTransfer) {
    try {
      await ctx.transferCall!(creator!.escalation_phone!);
      return { data: { transferring: true, say: 'Let them know you are putting them through now, then stop speaking.' } };
    } catch (err) {
      return {
        data: {
          transferring: false,
          logged: true,
          say: `The transfer did not go through. Tell them their question has been passed to ${creator?.business_name ?? 'the team'} and someone will follow up.`,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  return {
    data: {
      transferring: false,
      logged: true,
      say: `Their question has been passed to ${creator?.business_name ?? 'the team'}. Tell them someone will follow up, and give them whatever the curriculum does cover in the meantime.`,
    },
  };
}
