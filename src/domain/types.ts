export interface Creator {
  id: string;
  slug: string;
  business_name: string;
  coach_name: string;
  coach_voice: string;
  brand_json: string;
  welcome_message: string | null;
  outcome: string | null;
  audience: string | null;
  methodology: string | null;
  teaching_style: string | null;
  always_do_json: string;
  never_do_json: string;
  ask_questions_when: string | null;
  escalation_policy: EscalationPolicy;
  escalation_phone: string | null;
  price_per_minute_cents: number;
  status: 'draft' | 'preview' | 'live';
  created_at: number;
  updated_at: number;
}

/** What the coach does when the curriculum does not cover the question. */
export type EscalationPolicy =
  | 'offer_human' // suggest the creator's real phone, transfer on request
  | 'transfer' // transfer immediately via SIP REFER
  | 'ticket_only'; // record an escalation for the creator, no transfer

export interface Course {
  id: string;
  creator_id: string;
  title: string;
  outcome: string | null;
  audience: string | null;
  methodology: string | null;
  version: number;
  created_at: number;
}

export interface Module {
  id: string;
  course_id: string;
  seq: number;
  title: string;
  summary: string | null;
}

export interface Lesson {
  id: string;
  module_id: string;
  course_id: string;
  seq: number;
  title: string;
  summary: string | null;
}

export interface Step {
  id: string;
  lesson_id: string;
  module_id: string;
  course_id: string;
  seq: number;
  global_seq: number;
  title: string;
  instructions: string | null;
  expected_result: string | null;
  completion_criteria: string | null;
  prerequisites_json: string;
}

export interface StepProblem {
  id: string;
  step_id: string;
  course_id: string;
  seq: number;
  symptom: string;
  cause: string | null;
  fix: string;
}

export interface Customer {
  id: string;
  creator_id: string;
  name: string | null;
  phone_e164: string;
  verified_at: number | null;
  preferences_json: string;
  created_at: number;
}

export interface Enrollment {
  id: string;
  customer_id: string;
  course_id: string;
  current_step_id: string | null;
  status: 'active' | 'completed' | 'paused';
  created_at: number;
  updated_at: number;
}

/**
 * The vocabulary of progress. Every row answers "what changed", never "what was
 * said" — the coach reconstructs a caller's situation from these alone.
 */
export type TransitionEvent =
  | 'enrolled'
  | 'started_step'
  | 'hit_problem'
  | 'resolved_problem'
  | 'completed_step'
  | 'advanced'
  | 'moved_back'
  | 'escalated'
  | 'noted_preference';

export interface StateTransition {
  id: string;
  enrollment_id: string;
  seq: number;
  event_type: TransitionEvent;
  from_step_id: string | null;
  to_step_id: string | null;
  problem: string | null;
  resolution: string | null;
  note: string | null;
  source: string;
  call_id: string | null;
  created_at: number;
}

export interface Wallet {
  id: string;
  customer_id: string;
  creator_id: string;
  paid_seconds: number;
  promotional_seconds: number;
  updated_at: number;
}

export interface Call {
  id: string;
  xai_call_id: string | null;
  creator_id: string;
  customer_id: string | null;
  enrollment_id: string | null;
  from_number: string | null;
  to_number: string | null;
  status: 'ringing' | 'active' | 'ended' | 'rejected';
  end_reason: string | null;
  started_at: number;
  connected_at: number | null;
  ended_at: number | null;
  billable_seconds: number;
  seconds_from_promo: number;
  retail_cents: number;
  audio_in_ms: number;
  audio_out_ms: number;
  billed_text_items: number;
  cost_cents_estimate: number;
  entry_step_id: string | null;
  exit_step_id: string | null;
}

export interface PhoneNumber {
  id: string;
  creator_id: string;
  xai_phone_number_id: string;
  e164: string;
  sip_host: string | null;
  webhook_id: string | null;
  origin: 'xai_provisioned' | 'byo_trunk';
  signing_secret: string;
  created_at: number;
}

/** Everything the coach needs to know about who it is talking to. */
export interface CallerContext {
  creator: Creator;
  course: Course;
  customer: Customer;
  enrollment: Enrollment;
  currentStep: Step | null;
  recentTransitions: StateTransition[];
  completedStepIds: string[];
  balanceSeconds: number;
}
