import type { SqlDb } from '../db/types.js';
import type { Creator } from '../../src/domain/types.js';
import { chatCompletionJson, type ChatUsage } from '../xai/client.js';
import { loadKnowledge, selectKnowledgeHybrid, type KnowledgeRow } from './reply.js';
import { embedQuery, type AiBinding } from './embeddings.js';
import { scrapeOfferSite } from './page-scrape.js';

export interface OfferExtractionDraft {
  found: boolean;
  url: string | null;
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
  url: null,
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
  url?: string;
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
    url: {
      type: 'string',
      description:
        'The actual checkout/product/landing page URL, ONLY if one is literally stated somewhere in the material — never guess a ' +
        'domain from the offer\'s name, and never complete a partial mention into a full URL. Omit entirely if no real URL appears.',
    },
    who_for: {
      type: 'string',
      description:
        "Who this is genuinely for, the way the creator has actually sold it — synthesized across everything below, not a single " +
        'quote. If they never said "this is for X" as one sentence but every mention makes clear who they are talking to (the ' +
        'problem being solved, the level of experience assumed, the language used), write THAT — the understanding a person who ' +
        'watched all of this would form. Omit only if the material genuinely gives no basis to say who this is for.',
    },
    covers: {
      type: 'string',
      description:
        'What it actually does/includes, pulled together from everything said about it across the material — a coherent picture, ' +
        'not a list of disconnected fragments from different passages stapled together. Omit if not covered at all.',
    },
    price_text: {
      type: 'string',
      description:
        'A literal dollar amount or price range, exactly as stated — e.g. "$390 one-time" or "$49/month" — and nothing ' +
        'else. This one field stays strictly literal: if the material only mentions a plan or tier name with no number ' +
        'attached (e.g. "you need the Pro account"), that is NOT a price — omit this field entirely rather than writing ' +
        'the plan name here. Never estimate or infer a number that is not literally present anywhere.',
    },
    not_who_for: {
      type: 'string',
      description:
        "Who this is clearly NOT for — synthesized the same way as who_for. If the material implies a prerequisite (\"you'll " +
        'need to already have X for this to work") or a stage this assumes past, that counts even without an explicit ' +
        '"this is not for beginners" statement. Omit if the material gives no real basis for this either way.',
    },
    objections_and_responses: {
      type: 'string',
      description:
        'Real doubts or hesitations the creator addressed about this offer, and how they actually answered them — in their own ' +
        'reasoning, drawn together across however many times it came up. Omit if none appear anywhere.',
    },
    recommend_when: {
      type: 'string',
      description:
        'The situation that makes this the right call, per the pattern of how the creator actually talks about it — synthesized, ' +
        'not requiring one explicit sentence. Omit if the material gives no real basis for this.',
    },
    dont_recommend_when: {
      type: 'string',
      description: 'The situation that makes this the WRONG fit or too early, by the same synthesis. Omit if no real basis.',
    },
    source_indices: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Every bracketed [n] passage below that contributed to what you wrote, across all of them — not just one. Empty if found is false.',
    },
  },
  required: ['found', 'source_indices'],
  additionalProperties: false,
} as const;

function buildExtractionInstructions(creator: Creator, offerName: string, hasPage: boolean): string {
  return [
    `You are ${creator.business_name} themselves, reading back through everything you have ever said about one`,
    `specific offer: "${offerName}" — every video, every passage below where you brought it up. Someone who watched`,
    'all of this would come away with a real understanding of who it is for, what it does, and when you would',
    'actually recommend it, even though you never said any one of those things in a single tidy sentence. That is',
    'the understanding you are reconstructing — not hunting for one quote that happens to answer each field.',
    '',
    ...(hasPage
      ? [
          'The material below comes in TWO kinds, and they are good at different things:',
          '',
          "PAGE passages are the offer's own live sales page — what it officially includes, what tiers and prices",
          'actually exist right now, what buyers said in the testimonials, what the FAQ admits. When the page and a',
          'video disagree on a hard fact (a price, a tier, a feature), the PAGE is current and the video may be',
          'months stale — trust the page for the fact. Ignore the parts of a page that are just site furniture:',
          'nav labels, cookie notices, login prompts, footer legal links.',
          '',
          'VIDEO passages are how you actually sell it out loud — who you are really talking to, the objection you',
          'keep answering, the moment you tell someone it is NOT for them. A page will never say "do not buy this',
          'yet"; you do, on camera. For who_for, not_who_for, recommend_when, dont_recommend_when and',
          'objections_and_responses, your own voice in the videos is the better source, and the page fills in the',
          'concrete detail around it.',
          '',
          'Use both. The page alone is a brochure; your videos alone go stale on price and specifics. found should',
          'be true if EITHER kind of material genuinely covers this offer — a real page for it is enough on its own,',
          'even if you never happened to mention it on camera.',
          '',
        ]
      : []),
    'Pull the WHOLE picture together across every passage below that touches this offer, not just the first or',
    'most obvious one. The same offer may come up in five different videos with five different angles — a real',
    'understanding uses all five, not whichever one you read first.',
    '',
    'This is synthesis, not invention: everything you write must still trace back to something actually said or',
    'unmistakably implied across the material — never a feature, a claim, or a fit criterion that isn\'t genuinely',
    'there in some form. The line is "would someone who watched everything below reasonably conclude this", not',
    '"did one sentence say this verbatim". price_text is the one exception that stays strictly literal — see below.',
    '',
    'A trivial variation in how the name is written — plural vs singular, spacing, capitalization, "the" added or',
    'dropped, a minor misspelling — is still the SAME offer if the material is unmistakably talking about that one',
    'thing. Do not reject a match over wording like that; found should still be true.',
    '',
    'What genuinely means found:false is the material not discussing this offer AT ALL, or only discussing a',
    'DIFFERENT, distinctly-named offer that merely sounds similar. That distinction — same thing worded differently',
    'versus an actually different thing — is what you are being careful about, not exact string matching. Guessing',
    'at a different offer\'s details is worse than leaving a field blank: whatever you fill in becomes something an',
    'AI states as fact to a real prospect on a live sales call.',
    '',
    'Only include price_text when an actual number or range is stated somewhere in the material. Do not write',
    '"contact for pricing" or invent a plausible-sounding number — omit the field instead. Every other field may be',
    'synthesized across the whole picture; this one field may not.',
    '',
    'source_indices must list every bracketed [n] passage that genuinely contributed — this is how a human reviewer',
    'checks your work, so list all of them, not just one representative example.',
  ].join('\n');
}

function emptyDraft(): OfferExtractionDraft {
  return { ...EMPTY_DRAFT };
}

/**
 * A literal, case-insensitive substring match against an offer's own
 * name — deliberately separate from, and stronger than, the hybrid
 * retrieval used for general Q&A. That retrieval's keyword signal is
 * exact-token matching with no stemming (see reply.ts's tokenize()), so
 * a query for "Sandcastle" gets NO keyword boost on a passage that only
 * ever says "Sandcastles" — one token, not the other. For general
 * questions that is a reasonable trade; for an offer NAME lookup it is
 * exactly the case that matters most, so this guarantees any passage
 * that actually names the offer is included regardless of where hybrid
 * ranking would have put it. Checks both the name as given and its
 * simple plural/singular counterpart (trailing 's' added or stripped),
 * which covers the exact failure observed live — a real offer whose
 * material said "Sandcastles" was invisible to a "Sandcastle" query.
 */
export function findLiteralNameMatches(rows: KnowledgeRow[], offerName: string): KnowledgeRow[] {
  const name = offerName.trim().toLowerCase();
  if (!name) return [];
  const variants = [name, name.endsWith('s') ? name.slice(0, -1) : `${name}s`];
  return rows.filter((r) => {
    const haystack = `${r.problem} ${r.guidance} ${r.who_for ?? ''}`.toLowerCase();
    return variants.some((v) => v.length > 2 && haystack.includes(v));
  });
}

/**
 * Pulls a draft offer record out of the two things that actually know
 * what an offer is: the creator's own ingested material (pasted
 * knowledge + YouTube transcripts, whatever is in knowledge_items) and,
 * when they paste a link, the offer's live sales page — read at lookup
 * time, not cached, so the price is whatever it is today. Between them
 * a creator does not have to hand-type the sales-truth playbook for
 * something they already sell.
 *
 * The two sources answer different questions and neither replaces the
 * other. The page knows the current price, the real tiers, the
 * testimonials and the FAQ; the transcripts know who the creator is
 * actually talking to, the objection they keep answering, and when they
 * tell someone not to buy yet. buildExtractionInstructions() spells that
 * split out for the model rather than leaving it to infer which to
 * believe when they disagree.
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
  /** The offer's own sales page, if the creator supplied one. Read live. */
  offerUrl?: string;
}): Promise<{
  draft: OfferExtractionDraft;
  usage: ChatUsage;
  pagesRead: { url: string; title: string | null }[];
  scrapeErrors: string[];
}> {
  // The page and the transcripts are independent inputs — either alone is
  // enough to produce a draft, so neither is allowed to short-circuit the
  // other. A creator adding a brand-new offer they have never filmed still
  // gets a real draft from the page; one with no page still gets exactly
  // what this function produced before pages existed.
  const scraped = params.offerUrl?.trim() ? await scrapeOfferSite(params.offerUrl) : { pages: [], errors: [] };
  const pagesRead = scraped.pages.map((p) => ({ url: p.url, title: p.title }));

  const all = await loadKnowledge(params.db, params.creator.id);

  let relevant: KnowledgeRow[] = [];
  if (all.length) {
    let queryVector: Float32Array | null = null;
    if (params.ai) {
      try {
        queryVector = await embedQuery(params.ai, params.offerName);
      } catch (err) {
        console.error('offer-extraction query embedding failed, falling back to keyword retrieval', err);
      }
    }
    // Much wider than the usual reply retrieval (6): this runs once, when a
    // creator adds an offer, not on every turn of a live conversation — the
    // point is to reconstruct the FULL picture of how they have actually
    // sold this thing across every video that touches it, not answer one
    // question from the single best-matching passage. Missing a passage
    // means an incomplete synthesis rather than a wrong one — the cheaper
    // failure, and worth the extra tokens here specifically.
    const hybrid = selectKnowledgeHybrid(all, params.offerName, queryVector, 25);
    // Literal name matches are force-included on top of hybrid ranking, not
    // instead of it, and — unlike hybrid — never capped: every passage that
    // actually names the offer goes in. See findLiteralNameMatches()'s own
    // doc comment for why this second pass exists at all.
    const literal = findLiteralNameMatches(all, params.offerName);
    const seen = new Set(hybrid.map((r) => r.id));
    relevant = [...hybrid, ...literal.filter((r) => !seen.has(r.id))];
  }

  if (!scraped.pages.length && !relevant.length) {
    return { draft: emptyDraft(), usage: {}, pagesRead, scrapeErrors: scraped.errors };
  }

  // One flat, numbered list across both kinds of material, so the model's
  // source_indices resolve the same way regardless of where a passage came
  // from — the creator's "From:" line then links pages and videos alike.
  const passages: { block: string; source: { title: string; url: string | null } }[] = [
    ...scraped.pages.map((p) => ({
      block: `PAGE — ${p.title ?? p.url}\n(${p.url})\n${p.text}`,
      source: { title: p.title ?? p.url, url: p.url },
    })),
    ...relevant.map((k) => ({
      block: `VIDEO — ${k.problem}\n${k.guidance}${k.source_url ? `\n(source: ${k.source_url})` : ''}`,
      source: { title: k.problem, url: k.source_url ?? null },
    })),
  ];

  const user = passages.map((p, i) => `[${i + 1}] ${p.block}`).join('\n\n');

  const { value, usage } = await chatCompletionJson<RawExtraction>(params.apiBase, params.apiKey, {
    model: params.model,
    system: buildExtractionInstructions(params.creator, params.offerName, scraped.pages.length > 0),
    user,
    schemaName: 'offer_extraction',
    schema: extractionSchema as unknown as Record<string, unknown>,
  });

  if (!value.found) return { draft: emptyDraft(), usage, pagesRead, scrapeErrors: scraped.errors };

  const sourceSet = new Set((value.source_indices ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= passages.length));
  const sources = [...sourceSet].map((n) => passages[n - 1]!.source);

  return {
    draft: {
      found: true,
      url: value.url?.trim() || null,
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
    pagesRead,
    scrapeErrors: scraped.errors,
  };
}
