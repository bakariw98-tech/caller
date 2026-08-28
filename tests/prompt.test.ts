import { describe, expect, it } from 'vitest';
import { buildCoachInstructions } from '../src/coach/prompt.js';
import type { Creator, Course } from '../src/domain/types.js';

function makeCreator(overrides: Partial<Creator> = {}): Creator {
  return {
    id: 'creator_1',
    slug: 'test',
    business_name: 'Test Co',
    coach_name: 'Rosa',
    coach_voice: 'eve',
    brand_json: '{}',
    welcome_message: null,
    outcome: null,
    audience: null,
    methodology: null,
    teaching_style: null,
    always_do_json: '[]',
    never_do_json: '[]',
    ask_questions_when: null,
    escalation_policy: 'offer_human',
    escalation_phone: null,
    price_per_minute_cents: 75,
    status: 'live',
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

const course: Course = {
  id: 'course_1',
  creator_id: 'creator_1',
  title: 'Test Course',
  outcome: null,
  audience: null,
  methodology: null,
  version: 1,
  created_at: 0,
};

describe('buildCoachInstructions — identityMode', () => {
  it('defaults to caller_id mode, unchanged from before identityMode existed', () => {
    const text = buildCoachInstructions({ creator: makeCreator(), course, identified: true, callerFirstName: 'Dana' });
    expect(text).toContain('You are speaking with Dana');
    expect(text).toContain('continue from where they left off');
    expect(text).not.toContain('passcode');
  });

  it('caller_id mode ignores identityMode when explicitly set to that value', () => {
    const text = buildCoachInstructions({
      creator: makeCreator(),
      course,
      identified: false,
      identityMode: 'caller_id',
    });
    expect(text).toContain('You do not know who this caller is yet');
    expect(text).not.toContain('passcode');
  });

  it('passcode mode never claims to see caller ID, regardless of identified/callerFirstName', () => {
    // These would normally mean "greet them by name" in caller_id mode — passcode
    // mode must not do that, since there is no channel that ever resolved identity
    // ahead of the model asking for it itself.
    const text = buildCoachInstructions({
      creator: makeCreator(),
      course,
      identified: true,
      callerFirstName: 'Dana',
      identityMode: 'passcode',
    });
    expect(text).not.toContain('You are speaking with Dana');
    expect(text).toContain('You have no way to see who is calling');
    expect(text).toContain('passcode');
  });

  it('passcode mode instructs collecting and re-passing the passcode to every tool', () => {
    const text = buildCoachInstructions({ creator: makeCreator(), course, identified: false, identityMode: 'passcode' });
    expect(text).toMatch(/keep passing that same passcode to every other tool/i);
    expect(text).toMatch(/type on the keypad or say/i);
  });

  it("passcode mode tells the coach not to guess when the passcode doesn't match", () => {
    const text = buildCoachInstructions({ creator: makeCreator(), course, identified: false, identityMode: 'passcode' });
    expect(text).toMatch(/doesn't match anyone/i);
    expect(text).toMatch(/sign up/i);
  });

  it('creator-specific rules and grounding still apply identically in both modes', () => {
    const creator = makeCreator({
      methodology: 'Temperature first.',
      always_do_json: JSON.stringify(['Ask for the measurement']),
      never_do_json: JSON.stringify(['Never guess']),
    });
    const callerIdText = buildCoachInstructions({ creator, course, identified: false });
    const passcodeText = buildCoachInstructions({ creator, course, identified: false, identityMode: 'passcode' });

    for (const text of [callerIdText, passcodeText]) {
      expect(text).toContain('Temperature first.');
      expect(text).toContain('Ask for the measurement');
      expect(text).toContain('Never guess');
      expect(text).toContain('GROUNDING');
    }
  });
});
