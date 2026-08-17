import { chatCompletionJson, USD_PER_TICK } from '../xai/client.js';

/**
 * Turns a creator's free content into knowledge a cold prospect's question can
 * be answered from.
 *
 * Sibling to curriculum/structure.ts rather than a reuse of it, because the
 * two index for different readers. A student knows they are on step four, so
 * curriculum is indexed by sequence. A prospect has watched one video and
 * arrives with a situation — "does this apply to me", "where would I even
 * start" — and no idea which of two hundred videos addressed it. So knowledge
 * here is indexed by **problem**, and sequence is irrelevant.
 *
 * Three things this does that curriculum extraction does not:
 *
 *  1. **Deduplicates.** Creators repeat their core ideas across dozens of
 *     videos. Ten near-identical explanations of one framework should collapse
 *     into one item carrying all ten source references, or retrieval returns
 *     the same answer ten times and the reply reads like a search results page.
 *
 *  2. **Captures the methodology, not just the text.** Named frameworks,
 *     coined terms, the creator's characteristic sequence of thinking. This is
 *     what makes a reply sound like *them* rather than like a competent
 *     stranger, and voice is the whole product here.
 *
 *  3. **Tags the boundary.** Where the free material genuinely stops on a
 *     topic, and which paid offer picks it up. Routing fires on this and
 *     nothing else. The alternative — letting the model decide mid-reply when
 *     to start selling — is precisely how a creator's audience learns to
 *     distrust their name.
 *
 * Same extractive discipline as structure.ts, and for a sharper reason: this
 * text goes out under the creator's name to people deciding whether to trust
 * them. An invented claim here is a lie told in someone else's voice to a
 * stranger who has no way to check it. A missing boundary means the material
 * genuinely covers the topic — which is a fine answer and must not be
 * invented into a sales opportunity.
 */

export type ContentKind = 'video_transcript' | 'podcast' | 'blog' | 'newsletter' | 'framework' | 'lead_magnet' | 'faq';

export interface FreeContentSource {
  kind: ContentKind;
  title?: string;
  url?: string;
  text: string;
}

export interface OfferSummary {
  id: string;
  name: string;
  who_for?: string | null;
  covers?: string | null;
}

export interface ExtractedKnowledge {
  problem: string;
  who_for?: string;
  guidance: string;
  framework_terms: string[];
  source_refs: string[];
  source_quote: string;
  boundary?: string;
  boundary_offer_name?: string;
}

export interface ExtractionResult {
  methodology: string | null;
  terminology: string[];
  items: ExtractedKnowledge[];
  usage: { promptTokens: number; completionTokens: number; costUsd: number };
}

export class NoUsableContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoUsableContentError';
  }
}

const MAX_TOTAL_CHARS = 1_000_000;

const itemJson = {
  type: 'object',
  properties: {
    problem: {
      type: 'string',
      description:
        "The situation or question this addresses, phrased the way a prospect would arrive with it, not as a lesson title.",
    },
    who_for: { type: 'string', description: 'Who this applies to, if the content says.' },
    guidance: { type: 'string', description: "What the creator actually says about it, in their framing." },
    framework_terms: {
      type: 'array',
      items: { type: 'string' },
      description: 'Named frameworks or coined terms the creator uses here, exactly as they say them.',
    },
    source_refs: {
      type: 'array',
      items: { type: 'string' },
      description: 'Every source that covers this, by title. More than one when the creator repeats the idea.',
    },
    source_quote: { type: 'string', description: 'Verbatim span from the content.' },
    boundary: {
      type: 'string',
      description:
        'ONLY if the content itself stops short here — what it does not cover. Omit entirely when the free content answers this fully.',
    },
    boundary_offer_name: {
      type: 'string',
      description: 'Which supplied offer picks up past that boundary. Only alongside boundary.',
    },
  },
  required: ['problem', 'guidance', 'framework_terms', 'source_refs', 'source_quote'],
  additionalProperties: false,
} as const;

const resultJson = {
  type: 'object',
  properties: {
    methodology: {
      type: 'string',
      description: "The creator's overall approach in their own words, if the content expresses one.",
    },
    terminology: {
      type: 'array',
      items: { type: 'string' },
      description: 'Named frameworks and coined terms across all the content.',
    },
    items: { type: 'array', items: itemJson },
  },
  required: ['terminology', 'items'],
  additionalProperties: false,
} as const;

const SYSTEM = `You extract a creator's free content into knowledge for answering questions from people who have NOT bought anything.

You are EXTRACTIVE, never generative. This text will be sent under the
creator's name to strangers deciding whether to trust them. Anything invented
is a lie told in someone else's voice.

Index by PROBLEM, not by sequence. Your reader is a prospect who watched one
video and arrived with a situation, not a student on step four. Phrase each
problem the way they would actually ask it.

DEDUPLICATE. Creators repeat core ideas across dozens of videos. If several
sources make the same point, emit ONE item listing all of them in source_refs.
Do not emit near-duplicates — retrieval would return the same answer several
times and the reply would read like search results instead of a person.

CAPTURE THE METHODOLOGY, not just the facts. Named frameworks, coined terms,
the creator's characteristic way of sequencing an explanation. Record terms
exactly as they say them, never normalised into generic phrasing.

GUIDANCE IS TEACHING, NOT PROMOTION. guidance records what the creator
actually teaches a reader to do or understand. A sentence that only points at
a paid product ("that's all covered in X", "link below") teaches nothing — it
belongs in boundary, never in guidance. When one source explains a topic and
another merely defers on it, merge them so guidance keeps the substance and
boundary records the deferral. Copying a promotional line into guidance makes
every future reply on that topic a canned pitch, which is precisely the
failure this whole design exists to prevent.

THE BOUNDARY — this is the most consequential field:
- Set boundary ONLY where the content itself visibly stops short: it names
  something without explaining it, defers to a paid product, or gives the what
  while explicitly withholding the how.
- If the free content answers the question fully, OMIT boundary. That is the
  common case and a good outcome. A missing boundary means "answer this and
  do not sell", and it must never be invented to create a sales opening.
- Never invent a limitation the content does not actually have.
- Only attach boundary_offer_name when a supplied offer genuinely covers what
  lies past that boundary. Never stretch an offer to fit.

Other rules:
- Never invent a step, number, threshold, timeframe or claim.
- source_quote must be verbatim from the content. If you cannot quote it, do
  not emit the item.
- Drop filler: greetings, sponsor reads, "smash that subscribe", tangents.
- Omit any optional field the content does not support. Empty is correct.`;

const KIND_LABEL: Record<ContentKind, string> = {
  video_transcript: 'VIDEO TRANSCRIPT',
  podcast: 'PODCAST EPISODE',
  blog: 'BLOG POST',
  newsletter: 'NEWSLETTER',
  framework: 'FREE FRAMEWORK',
  lead_magnet: 'LEAD MAGNET',
  faq: 'FAQ',
};

export async function extractFreeContent(params: {
  apiBase: string;
  apiKey: string;
  model: string;
  sources: FreeContentSource[];
  offers: OfferSummary[];
}): Promise<ExtractionResult> {
  const usable = params.sources.filter((s) => s.text.trim().length > 0);
  if (usable.length === 0) throw new NoUsableContentError('No content to work from — every source was empty.');

  const total = usable.reduce((n, s) => n + s.text.length, 0);
  if (total > MAX_TOTAL_CHARS) {
    throw new NoUsableContentError(
      `That is ${Math.round(total / 1000)}k characters, over the ${Math.round(MAX_TOTAL_CHARS / 1000)}k limit for one pass. Ingest it in batches.`,
    );
  }

  // Offers are supplied so boundaries can point at the right one — but they
  // are stated as facts the model may only match against, never embellish.
  const offerBlock = params.offers.length
    ? [
        'The creator sells the following. Use these ONLY to attach a boundary to the right one.',
        'Never claim an offer covers something not listed here.',
        ...params.offers.map(
          (o) => `- "${o.name}"${o.who_for ? ` — for: ${o.who_for}` : ''}${o.covers ? ` — covers: ${o.covers}` : ''}`,
        ),
      ].join('\n')
    : 'The creator has supplied no offers. Do not set boundary_offer_name on anything.';

  const user = [
    offerBlock,
    '',
    'Extract the following free content.',
    '',
    ...usable.map((s, i) => {
      const head = `----- SOURCE ${i + 1} — ${KIND_LABEL[s.kind]}${s.title ? ` — ${s.title}` : ''}${s.url ? ` (${s.url})` : ''} -----`;
      return `${head}\n${s.text.trim()}`;
    }),
  ].join('\n\n');

  const { value, usage } = await chatCompletionJson<{
    methodology?: string;
    terminology: string[];
    items: ExtractedKnowledge[];
  }>(params.apiBase, params.apiKey, {
    model: params.model,
    system: SYSTEM,
    user,
    schemaName: 'free_content_knowledge',
    schema: resultJson as unknown as Record<string, unknown>,
  });

  return {
    methodology: value.methodology ?? null,
    terminology: value.terminology ?? [],
    items: value.items ?? [],
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      costUsd: (usage.cost_in_usd_ticks ?? 0) * USD_PER_TICK,
    },
  };
}
