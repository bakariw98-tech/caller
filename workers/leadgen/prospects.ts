import type { SqlDb } from '../db/types.js';
import { now } from '../../src/util/ids.js';
import { scoreProspect } from './reply.js';
import { isQualified } from './prompt.js';

/**
 * Everything that touches a `prospects` row's discovery fields, shared by
 * two callers that must not drift apart: `runLeadgenPipeline()` (email —
 * one turn per reply) and the `record_qualification_signal` MCP tool
 * (a live qualification call — several tool calls per conversation, as
 * fields become known). Extracted from `pipeline.ts`, which used to do
 * this inline, once a second caller needed the identical merge logic —
 * see that function's own history for why "two copies of a COALESCE
 * merge" is exactly the kind of thing that quietly diverges.
 */

/** Empty string -> null before persisting. See applyProspectSignals()'s comment for why this matters. */
export function nullIfBlank(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

export function safeArr(json: unknown): string[] {
  if (typeof json !== 'string') return [];
  try {
    const p = JSON.parse(json);
    return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export interface ProspectSignalInput {
  situation?: string | null;
  goal?: string | null;
  tried?: string | null;
  blocked_on?: string | null;
  diagnosed_problem?: string | null;
  knowledge_level?: string | null;
  urgency?: string | null;
  objections?: string[];
  topics?: string[];
  requested_offer?: boolean;
  hit_boundary?: boolean;
  /** Distinct from hit_boundary — see QualificationSignals' own doc comment in reply.ts. */
  qualifies_for_offer?: boolean;
}

export interface ApplyProspectSignalsOptions {
  /**
   * How much to bump `exchanges` by. Default 1, matching one email reply
   * being one exchange. A live call passes 0 for its mid-call signal
   * captures — several tool calls in one conversation are not several
   * exchanges — and lets the post-call recap (which runs through the
   * normal email pipeline) supply the one real bump for "this was one
   * interaction", exactly as an email reply already does.
   */
  exchangesDelta?: number;
  /**
   * Sets offer_pitched via MAX (never cleared once set). Email computes
   * this itself from routedOfferId/sharedFreeResource — a paid
   * recommendation, never a free resource, counts as "pitched". A
   * qualification call's `record_call_outcome` tool passes this directly
   * once the model reports an offer was actually named on the call.
   */
  offerPitched?: boolean;
  /** COALESCEd into name — never overwrites a name already on file. */
  name?: string | null;
}

export interface ApplyProspectSignalsResult {
  qualifiedNow: boolean;
  score: number;
}

/**
 * Merges newly-learned discovery signals into a prospect's row and
 * recomputes score/qualified_at from the result. Does not touch
 * `prospect_messages` — a phone call's mid-conversation signal captures
 * are not individual messages the way an email reply is; the one message
 * a call produces is the post-call follow-up, written by whichever caller
 * triggers that separately.
 */
export async function applyProspectSignals(
  db: SqlDb,
  prospect: Record<string, any>,
  signals: ProspectSignalInput,
  opts: ApplyProspectSignalsOptions = {},
): Promise<ApplyProspectSignalsResult> {
  const objections = [...new Set([...safeArr(prospect.objections_json), ...(signals.objections ?? [])])];
  const topics = [...new Set([...safeArr(prospect.topics_json), ...(signals.topics ?? [])])];
  const exchanges = (prospect.exchanges ?? 0) + (opts.exchangesDelta ?? 1);

  // Stored as one column for scoring purposes even though the signal can
  // come from two distinct reasons — a content gap versus a self-disclosed
  // fit with an offer. Both mean the same thing to a creator glancing at
  // the prospects list: this person is worth their attention.
  const hitBoundary = prospect.hit_boundary || signals.hit_boundary || signals.qualifies_for_offer ? 1 : 0;

  const mergedSituation = signals.situation ?? prospect.situation;
  const mergedDiagnosedProblem = signals.diagnosed_problem ?? prospect.diagnosed_problem;
  const mergedGoal = signals.goal ?? prospect.goal;

  const score = scoreProspect({
    exchanges,
    hit_boundary: hitBoundary,
    clicked_offer: prospect.clicked_offer,
    situation: mergedSituation,
    blocked_on: signals.blocked_on ?? prospect.blocked_on,
    goal: mergedGoal,
  });

  // The same rule the AI itself uses to decide a recommendation is earned
  // (isQualified() in prompt.ts) — never a separately-maintained
  // definition. Passed as NULL when not (yet) met, so COALESCE below
  // leaves an existing qualified_at alone and leaves an unqualified one
  // NULL — this can only ever be set once, never cleared or overwritten.
  const qualifiedNow = isQualified({
    situation: mergedSituation,
    diagnosed_problem: mergedDiagnosedProblem,
    goal: mergedGoal,
  });

  await db
    .prepare(
      `UPDATE prospects
          SET situation = COALESCE(?, situation), goal = COALESCE(?, goal), tried = COALESCE(?, tried),
              blocked_on = COALESCE(?, blocked_on), diagnosed_problem = COALESCE(?, diagnosed_problem),
              knowledge_level = COALESCE(?, knowledge_level), urgency = COALESCE(?, urgency),
              requested_offer = MAX(requested_offer, ?), offer_pitched = MAX(offer_pitched, ?),
              objections_json = ?, topics_json = ?,
              exchanges = ?, hit_boundary = ?, score = ?, last_seen_at = ?, name = COALESCE(name, ?),
              qualified_at = COALESCE(qualified_at, ?)
        WHERE id = ?`,
    )
    .run(
      nullIfBlank(signals.situation),
      nullIfBlank(signals.goal),
      nullIfBlank(signals.tried),
      nullIfBlank(signals.blocked_on),
      nullIfBlank(signals.diagnosed_problem),
      nullIfBlank(signals.knowledge_level),
      nullIfBlank(signals.urgency),
      signals.requested_offer ? 1 : 0,
      opts.offerPitched ? 1 : 0,
      JSON.stringify(objections),
      JSON.stringify(topics),
      exchanges,
      hitBoundary,
      score,
      now(),
      opts.name ?? null,
      qualifiedNow ? now() : null,
      prospect.id,
    );

  return { qualifiedNow, score };
}
