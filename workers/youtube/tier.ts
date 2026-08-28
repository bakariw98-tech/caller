/**
 * Quality tiering from free metadata alone — title and duration, both
 * available from `/youtube/channel/videos` at enumeration time, before a
 * single transcript credit is spent. See workers/leadgen/dedupe.ts and the
 * ingestion plan for how tier feeds acquisition order and retrieval boost.
 *
 * Tier 3 (skipped, never queued for transcript): Shorts and content types
 * that are structurally unlikely to carry reusable teaching — vlogs,
 * announcements, Q&A/AMA, livestreams, unboxings, hauls, reactions.
 *
 * Tier 1 (fetched first): titles that signal a self-contained tutorial or
 * framework — "how to", a guide, step-by-step, a numbered list of tips or
 * mistakes, a named system.
 *
 * Tier 2 (fetched after tier 1): everything else of non-trivial length.
 * Most channels' catalog back-fills into this tier — a case study, a
 * product review, a long-form conversation — and it is still worth
 * transcribing, just not first.
 */

export interface TierableVideo {
  title: string;
  /** Null when transcriptapi.com's listing omitted a parseable length. Treated as tier-2-eligible rather than penalized for missing data. */
  lengthSeconds: number | null;
}

export interface TierResult {
  tier: 1 | 2 | 3;
  reason: string;
}

/** Below this, YouTube's own product distinction is "Shorts" — a vertical clip, not a video with room for a taught concept. */
const SHORT_SECONDS = 90;

const SKIP_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bvlog\b/i, reason: 'vlog' },
  { pattern: /\bannouncement\b/i, reason: 'announcement' },
  { pattern: /\bchannel\s+update\b/i, reason: 'announcement' },
  { pattern: /\bq\s*&?\s*a\b/i, reason: 'q&a' },
  { pattern: /\bask\s+me\s+anything\b/i, reason: 'q&a' },
  { pattern: /\bama\b/i, reason: 'q&a' },
  { pattern: /\blive\s*stream\b/i, reason: 'livestream' },
  { pattern: /\(live\)/i, reason: 'livestream' },
  { pattern: /\blive\s*q\s*&?\s*a\b/i, reason: 'livestream' },
  { pattern: /\bday\s+in\s+(the|my)\s+life\b/i, reason: 'vlog' },
  { pattern: /\bunboxing\b/i, reason: 'unboxing' },
  { pattern: /\bhaul\b/i, reason: 'haul' },
  { pattern: /\breact(ing|s|ion)?\s+to\b/i, reason: 'reaction' },
];

const TIER1_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bhow\s+to\b/i, reason: 'how-to' },
  { pattern: /\bguide\b/i, reason: 'guide' },
  { pattern: /\bstep[\s-]by[\s-]step\b/i, reason: 'step-by-step' },
  { pattern: /\bmistakes?\b/i, reason: 'mistakes' },
  { pattern: /\bframework\b/i, reason: 'framework' },
  { pattern: /\bsystem\b/i, reason: 'system' },
  { pattern: /\btutorial\b/i, reason: 'tutorial' },
  { pattern: /\b\d+\s+(ways?|tips?|steps?|things?|reasons?|secrets?|rules?|hacks?|lessons?)\b/i, reason: 'numbered-list' },
  { pattern: /^\d+\s/, reason: 'numbered-list' },
];

/**
 * Pure and exported so the heuristics are testable against real titles
 * rather than tuned blind. Order matters: a short-duration check runs
 * before title patterns because a 45-second clip titled "How To Fix Your
 * Starter" is still a Short, not a tutorial.
 */
export function tierVideo(video: TierableVideo): TierResult {
  if (video.lengthSeconds !== null && video.lengthSeconds < SHORT_SECONDS) {
    return { tier: 3, reason: 'short' };
  }

  for (const { pattern, reason } of SKIP_PATTERNS) {
    if (pattern.test(video.title)) return { tier: 3, reason };
  }

  for (const { pattern, reason } of TIER1_PATTERNS) {
    if (pattern.test(video.title)) return { tier: 1, reason };
  }

  return { tier: 2, reason: 'general' };
}
