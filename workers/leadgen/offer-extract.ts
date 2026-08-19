import type { SqlDb } from '../db/types.js';
import type { Creator } from '../../src/domain/types.js';
import { chatCompletionJson, type ChatUsage } from '../xai/client.js';
import { loadKnowledge, selectKnowledgeHybrid } from './reply.js';
import { embedQuery, type AiBinding } from './embeddings.js';

export interface OfferExtractionDraft {
  found: boolean;
  who_for: string | null;
  covers: string | null;
  price_text: string | null;
  not_who_for: string | null;
  objections_and_responses: string | null;
  recommend_when: string | null;
  dont_recommend_when: string | null;
  sources: { title: string; url: string | null }[];
}

const EMPTY_DRAFT: OfferExtractionDraft = {
  found: false,
  who_for: null,
  covers: null,
  price_text: null,
  not_who_for: null,
  objections_and_responses: null,
  recommend_when: null,
  dont_recommend_when: null,
  sources: [],
};

interface RawExtraction {
  found: boolean;
  who_for?: string;
  covers?: string;
  price_text?: string;
  not_who_for?: string;
  objections_and_responses?: string;
  recommend_when?: string;
  dont_recommend_when?: string;
  source_indices?: number[];
}

const extractionSchema = {
  type: 'object',
  properties: {
    found: {
      type: 'boolean',
      description: "True only if the material below actually discusses this named offer — not a vague topic match, the offer itself.",
    },
    who_for: { type: 'string', description: 'Who they said this is for, in their own words. Omit if not stated.' },
    covers: { type: 'string', description: 'What it actually includes/covers, per the material. Omit if not stated.' },
    price_text: {
      type: 'string',
      description:
        'A literal dollar amount or price range, exactly as stated — e.g. "$390 one-time" or "$49/month" — and nothing ' +
        'else. If the material only mentions a plan or tier name with no number attached (e.g. "you need the Pro ' +
        'account"), that is NOT a price — omit this field entirely rather than writing the plan name here. Never ' +
        'estimate or infer a number that is not literally present.',
    },
    not_who_for: { type: 'string', description: "Who they said this is NOT for, or who should not buy it. Omit if not stated." },
    objections_and_responses: {
      type: 'string',
      description: 'Any objection or doubt about this offer that the material addresses, and how they answered it — in their own words. Omit if none appear.',
    },
    recommend_when: { type: 'string', description: 'Any situation they described as the right moment/fit for this. Omit if not stated.' },
    dont_recommend_when: { type: 'string', description: 'Any situation they described as the WRONG fit or too early for this. Omit if not stated.' },
    source_indices: {
      type: 'array',
      items: { type: 'integer' },
      description: 'The bracketed [n] numbers of the passages below that actually supported what you extracted. Empty if found is false.',
    },
  },
  required: ['found', 'source_indices'],
  additionalProperties: false,
} as const;

function buildExtractionInstructions(creator: Creator, offerName: string): string {
  return [
    `You are reading through ${creator.business_name}'s own material — videos, transcripts, notes — looking for`,
    `everything it actually says about one specific offer: "${offerName}".`,
    '',
    'You are EXTRACTIVE, never generative. Every field you fill in must trace directly to something actually said',
    'in the passages below. Never invent a price, a feature, a claim, or a fit criterion that is not there. Never',
    'generalize from how this creator talks about OTHER offers or topics — only what is said about this specific',
    'one counts.',
    '',
    'If the material does not clearly discuss this offer by name (or an unmistakable reference to it), set found',
    'to false and leave every other field out entirely. A near-miss on a similarly-named or related offer is not',
    'a match — do not guess. Guessing here is worse than leaving a field blank: whatever you fill in becomes',
    'something an AI states as fact to a real prospect on a live sales call.',
    '',
    'Only include price_text when an actual number or range is stated somewhere in the material. Do not write',
    '"contact for pricing" or invent a plausible-sounding number — omit the field instead.',
    '',
    'source_indices must list the bracketed [n] numbers of passages that genuinely supported what you extracted —',
    'this is how a human reviewer checks your work, so it must be accurate, not decorative.',
  ].join('\n');
}

function emptyDraft(): OfferExtractionDraft {
  return { ...EMPTY_DRAFT };
}

/**
 * Pulls a draft offer record out of a creator's own ingested material
 * (pasted knowledge + YouTube transcripts, whatever is in knowledge_items)
 * by name, so a creator does not have to hand-type the sales-truth
 * playbook for an offer they have already talked about on camera.
 *
 * Returns a DRAFT for the creator to review and edit before saving —
 * never writes to `offers` directly — matching the same discipline
 * /curriculum/structure already uses for the same reason: extraction can
 * misread or over-generalize, and a wrong offer detail here is worse than
 * a wrong curriculum step, because it becomes something the qualification
 * call states as fact to a live prospect (see workers/leadgen/call-prompt.ts's
 * whole honesty-gate design). A human reviews it first, same as every
 * other extraction step in this product.
 */
export async function extractOfferDetails(params: {
  db: SqlDb;
  ai?: AiBinding;
  apiBase: string;
  apiKey: string;
  model: string;
  creator: Creator;
  offerName: string;
}): Promise<{ draft: OfferExtractionDraft; usage: ChatUsage }> {
  const all = await loadKnowledge(params.db, params.creator.id);
  if (!all.length) return { draft: emptyDraft(), usage: {} };

  let queryVector: Float32Array | null = null;
  if (params.ai) {
    try {
      queryVector = await embedQuery(params.ai, params.offerName);
    } catch (err) {
      console.error('offer-extraction query embedding failed, falling back to keyword retrieval', err);
    }
  }
  // A wider net than the usual reply retrieval (6): an offer might be
  // discussed across several different videos/passages, and missing one
  // means an incomplete draft rather than a wrong one — the cheaper failure.
  const relevant = selectKnowledgeHybrid(all, params.offerName, queryVector, 15);
  if (!relevant.length) return { draft: emptyDraft(), usage: {} };

  const user = relevant
    .map((k, i) => `[${i + 1}] ${k.problem}\n${k.guidance}${k.source_url ? `\n(source: ${k.source_url})` : ''}`)
    .join('\n\n');

  const { value, usage } = await chatCompletionJson<RawExtraction>(params.apiBase, params.apiKey, {
    model: params.model,
    system: buildExtractionInstructions(params.creator, params.offerName),
    user,
    schemaName: 'offer_extraction',
    schema: extractionSchema as unknown as Record<string, unknown>,
  });

  if (!value.found) return { draft: emptyDraft(), usage };

  const sourceSet = new Set((value.source_indices ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= relevant.length));
  const sources = [...sourceSet].map((n) => {
    const item = relevant[n - 1]!;
    return { title: item.problem, url: item.source_url ?? null };
  });

  return {
    draft: {
      found: true,
      who_for: value.who_for?.trim() || null,
      covers: value.covers?.trim() || null,
      price_text: value.price_text?.trim() || null,
      not_who_for: value.not_who_for?.trim() || null,
      objections_and_responses: value.objections_and_responses?.trim() || null,
      recommend_when: value.recommend_when?.trim() || null,
      dont_recommend_when: value.dont_recommend_when?.trim() || null,
      sources,
    },
    usage,
  };
}
