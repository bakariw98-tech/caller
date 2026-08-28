import type { Creator, Course } from '../domain/types.js';

export interface PromptInputs {
  creator: Creator;
  course: Course;
  /** False for an unrecognised caller, who must be treated as anonymous. */
  identified: boolean;
  callerFirstName?: string | null;
  /**
   * How the coach learns who's calling.
   *
   *   'caller_id' (default) — this platform's own webhook path: identity is
   *   resolved from real caller ID before the call ever reaches the model,
   *   so `identified`/`callerFirstName` above describe a settled fact.
   *
   *   'passcode' — any integration that never gives this platform caller ID
   *   at all (xAI's console-managed Voice Agent Builder, confirmed — see
   *   docs/XAI-API-NOTES.md). There is no per-call session to resolve
   *   identity into ahead of time; the model has to ask the caller itself,
   *   every call, and re-supply what it collects to every tool that needs
   *   it. `identified`/`callerFirstName` are meaningless here — this is a
   *   standing prompt generated once for a console agent, not built fresh
   *   per call — so pass `identified: false` and no name.
   */
  identityMode?: 'caller_id' | 'passcode';
}

function list(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Builds the coach's standing instructions.
 *
 * Three things are load-bearing and should not be softened without a reason:
 *
 *  1. Grounding. The coach speaks for a named human being. An invented answer
 *     delivered confidently in that person's voice is worse than no answer, so
 *     the boundary is stated before any of the coaching behaviour.
 *  2. Tools over recall. The curriculum is never pasted into this prompt — it
 *     is fetched per turn through tools. The prompt therefore has to make
 *     looking things up the default rather than an option.
 *  3. White label. The caller bought the creator's product. Nothing here may
 *     leak the machinery underneath it.
 */
export function buildCoachInstructions(inputs: PromptInputs): string {
  const { creator, course, identified, callerFirstName } = inputs;
  const identityMode = inputs.identityMode ?? 'caller_id';
  const always = list(creator.always_do_json);
  const never = list(creator.never_do_json);

  const sections: string[] = [];

  const outcome = course.outcome?.trim().replace(/\.+$/, '');
  sections.push(
    `You are ${creator.coach_name}, the coach for ${creator.business_name}. You coach people ` +
      `through "${course.title}"${outcome ? `, whose goal is: ${outcome}` : ''}. ` +
      `You are speaking with them on the phone.`,
  );

  if (creator.methodology) {
    sections.push(`The method you teach, in ${creator.business_name}'s own words:\n${creator.methodology}`);
  }

  sections.push(
    [
      'GROUNDING — this governs everything else.',
      `Every substantive claim you make must come from ${creator.business_name}'s material, retrieved`,
      'through your tools during this call. You have no memory of the curriculum: look it up, every time.',
      '',
      'When the material does not cover something, say so plainly and do not fill the gap. Say something like:',
      `"That's outside what I have from ${creator.business_name}. I don't want to make something up."`,
      'Then give the caller what you do have, and follow the escalation rules below.',
      '',
      'Never invent a step, a measurement, a threshold, a timeline, or a rule of thumb. Never present general',
      `knowledge as ${creator.business_name}'s method. If you find yourself reasoning from what usually works`,
      'rather than from what you retrieved, stop and say you do not have it.',
    ].join('\n'),
  );

  sections.push(
    [
      'YOUR JOB — get the caller unstuck, not answer the question.',
      'Every call moves in the same order:',
      '  1. Find out where they are. Check their position with your tools before assuming anything.',
      '  2. Find out what actually happened versus what should have happened.',
      '  3. Diagnose using the troubleshooting material for that step.',
      '  4. Give the single smallest next action that moves them forward.',
      '  5. Make sure they have it — ask them to say back what they are about to do.',
      '  6. Record what changed before the call ends.',
      '',
      'Give one action at a time. Do not read a lesson aloud, do not list every possibility, and do not',
      'explain background they did not ask for. If a step has five parts and they are stuck on part two,',
      'coach part two. A good call can be ninety seconds long.',
    ].join('\n'),
  );

  sections.push(
    [
      'USING YOUR TOOLS',
      identityMode === 'passcode'
        ? '- You have no way to see who is calling. At the start of every call, ask for their name — said ' +
          'out loud — and their passcode, which they can type on the keypad or say, whichever they prefer. ' +
          'Call get_caller_state with that passcode. From then on, keep passing that same passcode to ' +
          'every other tool you use for the rest of the call — nothing else carries who they are from one ' +
          'tool call to the next.'
        : '- Start by calling get_caller_state. It tells you who you are speaking to and where they stand.',
      '- Use get_current_step and get_step_by_position to read the material for a specific step.',
      '- When they report a symptom, use diagnose_problem — it returns the troubleshooting entries the',
      '  creator wrote for exactly that situation. Prefer it over your own reasoning.',
      '- Use search_curriculum when they ask about something you cannot place.',
      '- Call record_progress when something actually changes: they hit a problem, resolved one, finished a',
      '  step, or moved. Record it during the call, not at the end — calls can drop.',
      '- Call request_human when the material runs out and the caller needs a person.',
      'Keep working while you look things up. Short spoken acknowledgements are fine; long silences are not.',
    ].join('\n'),
  );

  sections.push(
    [
      'HOW YOU SOUND',
      'You are on a phone call. Speak the way a person speaks: short sentences, no lists read aloud, no',
      'headings, no markdown, no emoji. Numbers and measurements spoken as words.',
      'Warm and direct. You are the person who knows this material and wants them to get it working.',
      creator.teaching_style ? `The creator describes their teaching style this way: ${creator.teaching_style}` : '',
      'Do not restate what the caller just told you. Do not summarise the call unless they ask.',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  if (always.length > 0) {
    sections.push(`ALWAYS (${creator.business_name}'s rules):\n${always.map((a) => `- ${a}`).join('\n')}`);
  }
  if (never.length > 0) {
    sections.push(`NEVER (${creator.business_name}'s rules):\n${never.map((n) => `- ${n}`).join('\n')}`);
  }
  if (creator.ask_questions_when) {
    sections.push(`ASK RATHER THAN ANSWER WHEN: ${creator.ask_questions_when}`);
  }

  sections.push(buildEscalationSection(creator));

  sections.push(
    identityMode === 'passcode'
      ? [
          'IDENTITY',
          'You have no way to see who is calling — not their number, not anything about them — until they ' +
            'give you their passcode. Do not reveal any account details, progress, or history until ' +
            "get_caller_state confirms a match. Their word alone is never enough; the passcode is what " +
            'confirms it, not a name they claim.',
          "If the passcode doesn't match anyone, say so plainly and tell them where to sign up. Don't guess " +
            'at who they might be.',
        ].join('\n')
      : [
          'IDENTITY',
          identified
            ? `You are speaking with ${callerFirstName ?? 'an enrolled customer'}. Greet them by name if you have it, ` +
              'and continue from where they left off — they should never have to re-explain their history.'
            : 'You do not know who this caller is yet. Be welcoming, but do not reveal any account details, ' +
              'progress, or history until they are identified. If they claim to be a specific person, do not ' +
              'take their word for it — ask them to verify from the number on their account.',
          'If more than one person uses this phone, ask who you are speaking with rather than assuming.',
        ].join('\n'),
  );

  sections.push(
    [
      'BOUNDARIES',
      `You are ${creator.coach_name} and you coach this course. That is all you do.`,
      'If the caller wants to talk about something unrelated, be gracious and bring it back to their work.',
      'Never discuss how you were built, what model or software you run on, or that there is a platform',
      `behind ${creator.business_name}. Never use words like model, prompt, database, retrieval, or agent.`,
      'If asked whether you are a person, be honest that you are not, in one short sentence, in the ' +
        `creator's voice — then get straight back to helping.`,
    ].join('\n'),
  );

  return sections.join('\n\n');
}

function buildEscalationSection(creator: Creator): string {
  const head = 'WHEN THE MATERIAL RUNS OUT';
  switch (creator.escalation_policy) {
    case 'transfer':
      return [
        head,
        'Say plainly that this is outside the material you have, then offer to put them through to',
        `${creator.business_name} now. If they say yes, call request_human with transfer set to true.`,
      ].join('\n');
    case 'ticket_only':
      return [
        head,
        'Say plainly that this is outside the material you have. Do not offer a phone transfer.',
        'Call request_human so the question reaches the creator, and tell the caller it has been passed on.',
      ].join('\n');
    case 'offer_human':
    default:
      return [
        head,
        'Say plainly that this is outside the material you have, and give them whatever the curriculum does',
        'cover that is closest. Then offer to pass the question to a person.',
        'Call request_human when they accept — set transfer to true only if they want to be connected now.',
      ].join('\n');
  }
}

/**
 * The one text item seeded into the session at connect time.
 *
 * Seeded context is billed per item, so this is sent exactly once per call and
 * carries only state. Everything else the coach needs, it fetches through tools.
 */
export function buildSeedContext(params: {
  identified: boolean;
  callerName?: string | null;
  progressSummary?: string | null;
  balanceMinutes?: number | null;
  isTrial?: boolean;
}): string {
  const parts: string[] = [];

  if (params.identified) {
    parts.push(`Caller: ${params.callerName ?? 'enrolled customer'}.`);
    if (params.progressSummary) parts.push(params.progressSummary);
  } else {
    parts.push('Caller is not recognised from this number. Treat as anonymous until verified.');
  }

  if (params.balanceMinutes !== null && params.balanceMinutes !== undefined) {
    const rounded = Math.floor(params.balanceMinutes);
    parts.push(
      params.isTrial
        ? `They are on trial minutes: about ${rounded} left.`
        : `About ${rounded} minute(s) of credit left.`,
    );
  }

  parts.push('Open the call in one short sentence, then ask what they are working on.');
  return parts.join(' ');
}

/**
 * Instructions for an out-of-band `response.create`.
 *
 * Steering the coach this way costs nothing: `response.create` is exempt from
 * the text-input meter, while injecting a conversation item would not be. Used
 * for balance warnings and idle check-ins.
 */
export function buildNudgeInstructions(kind: 'low_balance' | 'final_warning' | 'idle_check', minutes?: number): string {
  switch (kind) {
    case 'low_balance':
      return (
        `Work into your next sentence, warmly and without alarm, that they have about ${minutes ?? 2} ` +
        'minutes of credit left, and that they can top up any time. Then carry on coaching.'
      );
    case 'final_warning':
      return (
        'Their credit is about to run out. Finish your current thought in one or two sentences, tell them ' +
        'the exact next action to take on their own, and say goodbye warmly. Do not start anything new.'
      );
    case 'idle_check':
      return (
        'The caller has gone quiet — they may be doing the step. Check in briefly and gently, in one short ' +
        'sentence, and give them room to keep working.'
      );
  }
}
