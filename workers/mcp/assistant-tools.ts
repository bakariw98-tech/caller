import type { SqlDb } from '../db/types.js';
import type { Env } from '../env.js';
import type { Creator } from '../../src/domain/types.js';
import type { McpAssistantSession } from './auth.js';
import type { ToolDefinition, ToolResult } from './tools.js';
import { indexKnowledge } from '../routes/leadgen.js';
import { extractOfferDetails } from '../leadgen/offer-extract.js';
import { syncChannel } from '../youtube/ingest.js';
import { id as newId, now } from '../../src/util/ids.js';
import { getAccessToken, buildRawMessage, sendMessage } from '../email/gmail.js';

/**
 * The creator's own assistant — the tool set behind both "talk to it from
 * the dashboard" and "paste a key into your own agent". One set serves
 * both on purpose: they are two doors into the same room, and a second
 * copy would drift.
 *
 * Every tool here is scoped to ONE creator by construction. Handlers take
 * the creator_id from the resolved session and never from an argument, so
 * there is no reachable path to another creator's data even if the model
 * asks for one — the same reason resolve_prospect matches a call_code
 * against the DB rather than trusting a spoken name (see qual-tools.ts).
 *
 * The read tools live here; write tools are added alongside them. The
 * split that matters is not read-vs-write but reversible-vs-not: deleting
 * knowledge, removing an offer and sending mail are called out in the
 * assistant's instructions as things to read back and confirm out loud
 * first, because a misheard word should not be able to destroy something.
 */
export const ASSISTANT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_overview',
    description:
      "The creator's current numbers and setup state — how much material the coach can answer from, how many " +
      'offers exist, how many people have written in, whether an inbox is connected and whether voice escalation ' +
      'is on. Call this before answering any "how are things going" or "is X set up" question rather than ' +
      'recalling what you were told earlier in the conversation; it may have changed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_knowledge',
    description:
      'Find items in the knowledge base by a word or phrase, so you can talk about or edit a specific one. ' +
      'Returns each match with the id you need to edit or delete it. Search before editing — never guess an id.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A word or phrase to look for in the question or the answer.' },
        limit: { type: 'integer', description: 'How many to return. Defaults to 10, max 50.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_offers',
    description:
      'Everything the creator currently sells or gives away, with the ids needed to edit or remove one, and ' +
      'every sales-truth field a qualification call would speak from.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_prospects',
    description:
      'People who have written in, newest first, with what the conversation has learned about each — situation, ' +
      'real problem, goal, whether they qualified. Includes the prospect id needed to act on one. Email ' +
      'addresses are returned here so the creator can be told who a lead is; never invent one that is not in ' +
      'this result.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many to return. Defaults to 10, max 50.' },
        qualified_only: { type: 'boolean', description: 'Only people who have reached qualified.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'edit_knowledge_item',
    description:
      'Change the question, the answer, or where the free material stops (the boundary) for one knowledge item. ' +
      'Look it up with search_knowledge first — this needs its real id, never a guessed one. Read back what you ' +
      "are about to change and get a spoken yes before calling this if the change is substantial, not just a typo fix.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The knowledge item id, from search_knowledge.' },
        problem: { type: 'string', description: 'New question text. Omit to leave unchanged.' },
        guidance: { type: 'string', description: 'New answer text. Omit to leave unchanged.' },
        boundary: {
          type: 'string',
          description:
            'Where free material stops and an offer picks up. Pass an empty string to clear it — meaning this ' +
            'item goes back to answering in full and never pitching. Omit to leave unchanged.',
        },
        boundary_offer_id: {
          type: 'string',
          description: 'The offer id (from list_offers) that picks up past the boundary. Required if boundary is set to non-empty.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_knowledge_item',
    description:
      'Permanently remove one knowledge item — the coach can no longer answer from it. This cannot be undone. ' +
      'Read back exactly which item (by its question) you are about to delete and wait for a clear spoken yes ' +
      'before calling this.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The knowledge item id, from search_knowledge.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lookup_offer_from_content',
    description:
      "Reads the creator's own material (and the offer's sales page, if a URL is given) to draft an offer's " +
      'sales-truth fields — who it is for, what it covers, price, objections, and more — grounded in what the ' +
      'creator has actually said or what the page actually states, never invented. Use this before add_offer ' +
      'when the creator names something they already sell rather than asking them to dictate every field.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "The offer's name, exactly as the creator says it." },
        url: { type: 'string', description: "The offer's sales page, if the creator gives one. Optional." },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_offer',
    description:
      "Adds a new offer to the creator's dashboard. Prefer calling lookup_offer_from_content first and using " +
      'what it finds rather than inventing fields yourself — the price especially should come from the creator ' +
      'directly or from a real page, never a guess.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        is_free: { type: 'boolean', description: 'True for something given away free; false (default) for something sold.' },
        who_for: { type: 'string' },
        covers: { type: 'string' },
        price_text: { type: 'string', description: 'e.g. "$390 one-time" or "$49/month". Literal only, never estimated.' },
        url: { type: 'string' },
        not_who_for: { type: 'string' },
        objections_and_responses: { type: 'string' },
        recommend_when: { type: 'string' },
        dont_recommend_when: { type: 'string' },
        cta_tier: { type: 'string', enum: ['low_ticket', 'course', 'high_ticket_application', 'very_high_ticket'] },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_offer',
    description: 'Changes one or more fields on an existing offer. Look it up with list_offers first for its real id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The offer id, from list_offers.' },
        name: { type: 'string' },
        who_for: { type: 'string' },
        covers: { type: 'string' },
        price_text: { type: 'string' },
        url: { type: 'string' },
        not_who_for: { type: 'string' },
        objections_and_responses: { type: 'string' },
        recommend_when: { type: 'string' },
        dont_recommend_when: { type: 'string' },
        cta_tier: { type: 'string', enum: ['low_ticket', 'course', 'high_ticket_application', 'very_high_ticket'] },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_offer',
    description:
      'Removes an offer — it will no longer be recommended, and any knowledge boundary pointing at it stops ' +
      'routing. This cannot be undone. Read back the offer name and get a clear spoken yes before calling this.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The offer id, from list_offers.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_profile',
    description: "Changes the creator's own business name, the name the coach signs as, who they teach, or how they sound.",
    inputSchema: {
      type: 'object',
      properties: {
        business_name: { type: 'string' },
        coach_name: { type: 'string' },
        audience: { type: 'string' },
        teaching_style: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_voice_escalation',
    description:
      'Turns voice escalation on or off, or changes the objection-handling posture. Turning it on requires a ' +
      'qualify-purpose phone number and a connected inbox to already exist — if either is missing, this fails ' +
      'and tells you which; relay that to the creator rather than retrying blindly.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        objection_handling_posture: { type: 'string', enum: ['soft', 'assertive'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'email_prospect',
    description:
      'Sends a real email to one of the creator\'s own leads, from the creator\'s connected inbox. You write the ' +
      'subject and body yourself, in your own words — but you never type an email address. Pass the prospect_id ' +
      'from list_prospects or search results; the actual address is resolved from the creator\'s own records, ' +
      'never from anything you write. Every fact you put in the email (an offer name, a price, a link) has to ' +
      'come from a tool result in this conversation, never invented. This is irreversible the moment it sends — ' +
      'read back who it is going to and what it says, in plain language, and get a clear spoken yes before ' +
      'calling this.',
    inputSchema: {
      type: 'object',
      properties: {
        prospect_id: { type: 'string', description: 'The prospect id, from list_prospects or search — never a typed-out address.' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain text. Written by you, but every fact in it must be grounded in an earlier tool result.' },
      },
      required: ['prospect_id', 'subject', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'connect_youtube',
    description:
      "Connects (or re-syncs) the creator's YouTube channel by handle or URL so every video becomes searchable " +
      'knowledge. Safe to call again on an already-connected channel to pick up new uploads.',
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string', description: 'An @handle, a channel URL, or a UC… channel id.' } },
      required: ['channel'],
      additionalProperties: false,
    },
  },
];

export interface AssistantToolContext {
  db: SqlDb;
  env: Env;
  session: McpAssistantSession;
}

const CTA_TIERS = new Set(['low_ticket', 'course', 'high_ticket_application', 'very_high_ticket']);

export async function callAssistantTool(
  ctx: AssistantToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'get_overview':
      return getOverview(ctx);
    case 'search_knowledge':
      return searchKnowledge(ctx, args);
    case 'list_offers':
      return listOffers(ctx);
    case 'list_prospects':
      return listProspects(ctx, args);
    case 'edit_knowledge_item':
      return editKnowledgeItem(ctx, args);
    case 'delete_knowledge_item':
      return deleteKnowledgeItem(ctx, args);
    case 'lookup_offer_from_content':
      return lookupOfferFromContent(ctx, args);
    case 'add_offer':
      return addOffer(ctx, args);
    case 'edit_offer':
      return editOffer(ctx, args);
    case 'remove_offer':
      return removeOffer(ctx, args);
    case 'update_profile':
      return updateProfile(ctx, args);
    case 'set_voice_escalation':
      return setVoiceEscalation(ctx, args);
    case 'connect_youtube':
      return connectYoutube(ctx, args);
    case 'email_prospect':
      return emailProspect(ctx, args);
    default:
      return { data: { error: `Unknown tool: ${name}` }, isError: true };
  }
}

/** Clamps a model-supplied row limit into a sane range. */
function limitOf(raw: unknown, fallback = 10, max = 50): number {
  const n = typeof raw === 'number' ? Math.floor(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

async function getOverview(ctx: AssistantToolContext): Promise<ToolResult> {
  const cid = ctx.session.creator_id;
  const creator = await ctx.db
    .prepare(
      `SELECT business_name, coach_name, audience, teaching_style, status, youtube_channel,
              voice_qualification_mode, objection_handling_posture
         FROM creators WHERE id = ?`,
    )
    .get<Record<string, unknown>>(cid);
  if (!creator) return { data: { error: 'creator not found' }, isError: true };

  const one = async (sql: string): Promise<number> => {
    const row = await ctx.db.prepare(sql).get<{ n: number }>(cid);
    return row?.n ?? 0;
  };

  const [knowledge, boundaries, offers, prospects, qualified, email] = await Promise.all([
    one('SELECT COUNT(*) AS n FROM knowledge_items WHERE creator_id = ?'),
    one('SELECT COUNT(*) AS n FROM knowledge_items WHERE creator_id = ? AND boundary IS NOT NULL'),
    one('SELECT COUNT(*) AS n FROM offers WHERE creator_id = ? AND active = 1'),
    one('SELECT COUNT(*) AS n FROM prospects WHERE creator_id = ?'),
    one('SELECT COUNT(*) AS n FROM prospects WHERE creator_id = ? AND qualified_at IS NOT NULL'),
    ctx.db.prepare('SELECT gmail_address FROM email_connections WHERE creator_id = ?').get<{ gmail_address: string }>(cid),
  ]);

  return {
    data: {
      business_name: creator.business_name,
      answering_as: creator.coach_name,
      audience: creator.audience,
      teaching_style: creator.teaching_style,
      status: creator.status,
      knowledge_items: knowledge,
      items_routing_to_an_offer: boundaries,
      offers,
      people_who_wrote_in: prospects,
      qualified,
      inbox_connected: email ? email.gmail_address : null,
      youtube_channel: creator.youtube_channel ?? null,
      voice_escalation_on: Number(creator.voice_qualification_mode) === 1,
      objection_posture: creator.objection_handling_posture,
    },
  };
}

async function searchKnowledge(ctx: AssistantToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { data: { matches: [], guidance: 'Give a word or phrase to search for.' } };

  // LIKE rather than the embedding retrieval the coach uses: the creator is
  // looking for a specific item they already have in mind ("the one about
  // hooks"), which is a lookup, not a relevance ranking problem.
  const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const rows = await ctx.db
    .prepare(
      `SELECT k.id, k.problem, k.guidance, k.boundary, o.name AS boundary_offer
         FROM knowledge_items k
         LEFT JOIN offers o ON o.id = k.boundary_offer_id
        WHERE k.creator_id = ?
          AND (k.problem LIKE ? ESCAPE '\\' OR k.guidance LIKE ? ESCAPE '\\')
        ORDER BY k.created_at DESC
        LIMIT ?`,
    )
    .all<Record<string, unknown>>(ctx.session.creator_id, like, like, limitOf(args.limit));

  return {
    data: {
      matches: rows,
      count: rows.length,
      ...(rows.length ? {} : { guidance: 'Nothing matched. Tell them so rather than describing an item from memory.' }),
    },
  };
}

async function listOffers(ctx: AssistantToolContext): Promise<ToolResult> {
  const rows = await ctx.db
    .prepare(
      `SELECT id, name, kind, is_free, who_for, covers, price_text, url,
              not_who_for, objections_and_responses, recommend_when, dont_recommend_when, cta_tier
         FROM offers WHERE creator_id = ? AND active = 1 ORDER BY created_at`,
    )
    .all<Record<string, unknown>>(ctx.session.creator_id);
  return { data: { offers: rows, count: rows.length } };
}

async function listProspects(ctx: AssistantToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const rows = await ctx.db
    .prepare(
      `SELECT id, email, situation, diagnosed_problem, goal, tried, blocked_on, urgency,
              exchanges, qualified_at, offer_pitched, clicked_offer, first_seen_at
         FROM prospects
        WHERE creator_id = ?${args.qualified_only ? ' AND qualified_at IS NOT NULL' : ''}
        ORDER BY last_seen_at DESC
        LIMIT ?`,
    )
    .all<Record<string, unknown>>(ctx.session.creator_id, limitOf(args.limit));
  return { data: { prospects: rows, count: rows.length } };
}

/** A string arg to store, or null to clear the column, or undefined to leave it untouched. */
export function optionalString(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s || null;
}

async function editKnowledgeItem(ctx: AssistantToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const itemId = typeof args.id === 'string' ? args.id.trim() : '';
  if (!itemId) return { data: { error: 'id is required — look it up with search_knowledge first' }, isError: true };

  const existing = await ctx.db
    .prepare('SELECT id FROM knowledge_items WHERE id = ? AND creator_id = ?')
    .get<{ id: string }>(itemId, ctx.session.creator_id);
  if (!existing) return { data: { error: 'No knowledge item with that id for this creator. Search again — do not guess an id.' }, isError: true };

  const sets: string[] = [];
  const vals: unknown[] = [];
  let reindex = false;

  if (typeof args.problem === 'string' && args.problem.trim()) {
    sets.push('problem = ?');
    vals.push(args.problem.trim());
    reindex = true;
  }
  if (typeof args.guidance === 'string' && args.guidance.trim()) {
    sets.push('guidance = ?');
    vals.push(args.guidance.trim());
    reindex = true;
  }
  if ('boundary' in args) {
    const boundary = optionalString(args.boundary);
    sets.push('boundary = ?');
    vals.push(boundary ?? null);
    if (!boundary) {
      // A boundary with no offer behind it can never route — clearing one
      // clears the other, same rule the dashboard's own PATCH route uses.
      sets.push('boundary_offer_id = ?');
      vals.push(null);
    } else if (typeof args.boundary_offer_id === 'string' && args.boundary_offer_id.trim()) {
      sets.push('boundary_offer_id = ?');
      vals.push(args.boundary_offer_id.trim());
    }
  }

  if (!sets.length) return { data: { error: 'Nothing to change — give at least one field.' }, isError: true };

  vals.push(itemId, ctx.session.creator_id);
  await ctx.db.prepare(`UPDATE knowledge_items SET ${sets.join(', ')} WHERE id = ? AND creator_id = ?`).run(...vals);

  // Re-embed through the exact same path the dashboard's own PATCH route
  // uses — force=false only touches rows the edit actually invalidated,
  // since a plain UPDATE does not clear the embedding column itself.
  if (reindex) {
    await ctx.db.prepare('UPDATE knowledge_items SET embedding = NULL WHERE id = ?').run(itemId);
    await indexKnowledge(ctx.env, ctx.db, ctx.session.creator_id, false);
  }

  return { data: { saved: true, id: itemId } };
}

async function deleteKnowledgeItem(ctx: AssistantToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const itemId = typeof args.id === 'string' ? args.id.trim() : '';
  if (!itemId) return { data: { error: 'id is required' }, isError: true };

  const res = await ctx.db
    .prepare('DELETE FROM knowledge_items WHERE id = ? AND creator_id = ?')
    .run(itemId, ctx.session.creator_id);
  return { data: { deleted: (res.changes) > 0 } };
}

async function lookupOfferFromContent(ctx: AssistantToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return { data: { error: 'name is required' }, isError: true };
  const url = typeof args.url === 'string' ? args.url.trim() : undefined;

  const creator = await ctx.db
    .prepare('SELECT * FROM creators WHERE id = ?')
    .get<Creator>(ctx.session.creator_id);
  if (!creator) return { data: { error: 'creator not found' }, isError: true };

  const { draft, pagesRead, scrapeErrors } = await extractOfferDetails({
    db: ctx.db,
    ai: ctx.env.AI,
    apiBase: ctx.env.XAI_API_BASE,
    apiKey: ctx.env.XAI_API_KEY,
    model: ctx.env.XAI_TEXT_MODEL,
    creator,
    offerName: name,
    offerUrl: url,
  });

  if (!draft.found) {
    return {
      data: {
        found: false,
        guidance: `Nothing about "${name}" was found in the creator's material${url ? ' or on that page' : ''}. Ask them to describe it themselves rather than inventing details.`,
        scrape_errors: scrapeErrors,
      },
    };
  }

  return { data: { found: true, draft, pages_read: pagesRead, scrape_errors: scrapeErrors } };
}

async function addOffer(ctx: AssistantToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return { data: { error: 'name is required' }, isError: true };

  const offerId = newId('offer');
  await ctx.db
    .prepare(
      `INSERT INTO offers
         (id, creator_id, kind, name, who_for, covers, price_text, url, is_free, active, created_at,
          not_who_for, objections_and_responses, recommend_when, dont_recommend_when, cta_tier)
       VALUES (?, ?, 'course', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      offerId,
      ctx.session.creator_id,
      name,
      optionalString(args.who_for) ?? null,
      optionalString(args.covers) ?? null,
      optionalString(args.price_text) ?? null,
      optionalString(args.url) ?? null,
      args.is_free ? 1 : 0,
      now(),
      optionalString(args.not_who_for) ?? null,
      optionalString(args.objections_and_responses) ?? null,
      optionalString(args.recommend_when) ?? null,
      optionalString(args.dont_recommend_when) ?? null,
      CTA_TIERS.has(String(args.cta_tier)) ? String(args.cta_tier) : 'course',
    );
  return { data: { saved: true, id: offerId, name } };
}

async function editOffer(ctx: AssistantToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const offerId = typeof args.id === 'string' ? args.id.trim() : '';
  if (!offerId) return { data: { error: 'id is required — look it up with list_offers first' }, isError: true };

  const fields = ['name', 'who_for', 'covers', 'price_text', 'url', 'not_who_for', 'objections_and_responses', 'recommend_when', 'dont_recommend_when'];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of fields) {
    if (key in args) {
      sets.push(`${key} = ?`);
      vals.push(optionalString(args[key]) ?? null);
    }
  }
  if ('cta_tier' in args) {
    sets.push('cta_tier = ?');
    vals.push(CTA_TIERS.has(String(args.cta_tier)) ? String(args.cta_tier) : 'course');
  }
  if (!sets.length) return { data: { error: 'Nothing to change — give at least one field.' }, isError: true };

  vals.push(offerId, ctx.session.creator_id);
  const res = await ctx.db
    .prepare(`UPDATE offers SET ${sets.join(', ')} WHERE id = ? AND creator_id = ?`)
    .run(...vals);
  if ((res.changes) === 0) return { data: { error: 'No offer with that id for this creator.' }, isError: true };
  return { data: { saved: true, id: offerId } };
}

async function removeOffer(ctx: AssistantToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const offerId = typeof args.id === 'string' ? args.id.trim() : '';
  if (!offerId) return { data: { error: 'id is required' }, isError: true };

  // Soft-delete, same as the dashboard's own DELETE route: knowledge_items
  // may still point at this offer as what lies past a boundary, and a hard
  // delete would silently turn those into boundaries that route nowhere.
  const res = await ctx.db
    .prepare('UPDATE offers SET active = 0 WHERE id = ? AND creator_id = ?')
    .run(offerId, ctx.session.creator_id);
  return { data: { removed: (res.changes) > 0 } };
}

async function updateProfile(ctx: AssistantToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const fields = ['business_name', 'coach_name', 'audience', 'teaching_style'];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of fields) {
    if (key in args) {
      sets.push(`${key} = ?`);
      vals.push(optionalString(args[key]) ?? null);
    }
  }
  if (!sets.length) return { data: { error: 'Nothing to change — give at least one field.' }, isError: true };

  vals.push(now(), ctx.session.creator_id);
  await ctx.db.prepare(`UPDATE creators SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals);
  return { data: { saved: true } };
}

async function setVoiceEscalation(ctx: AssistantToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const cid = ctx.session.creator_id;

  if (args.enabled === true) {
    const qualifyNumber = await ctx.db
      .prepare("SELECT 1 FROM phone_numbers WHERE creator_id = ? AND purpose = 'qualify' LIMIT 1")
      .get(cid);
    const gmail = await ctx.db.prepare('SELECT 1 FROM email_connections WHERE creator_id = ?').get(cid);
    if (!qualifyNumber) {
      return { data: { error: 'A qualify-purpose phone number has to be registered first — that still needs the dashboard, tell the creator.' }, isError: true };
    }
    if (!gmail) {
      return { data: { error: 'An inbox has to be connected first — that needs a Google login the creator has to click through themselves, not something you can do for them.' }, isError: true };
    }
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  if ('enabled' in args) {
    sets.push('voice_qualification_mode = ?');
    vals.push(args.enabled ? 1 : 0);
  }
  if (args.objection_handling_posture === 'soft' || args.objection_handling_posture === 'assertive') {
    sets.push('objection_handling_posture = ?');
    vals.push(args.objection_handling_posture);
  }
  if (!sets.length) return { data: { error: 'Nothing to change.' }, isError: true };

  vals.push(cid);
  await ctx.db.prepare(`UPDATE creators SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return { data: { saved: true } };
}

async function connectYoutube(ctx: AssistantToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const channel = typeof args.channel === 'string' ? args.channel.trim() : '';
  if (!channel) return { data: { error: 'channel (an @handle or channel URL) is required' }, isError: true };
  if (!ctx.env.TRANSCRIPT_API_KEY) return { data: { error: 'YouTube ingestion is not configured on this deployment.' }, isError: true };

  try {
    const result = await syncChannel(ctx.db, ctx.session.creator_id, ctx.env.TRANSCRIPT_API_KEY, channel);
    return { data: { saved: true, ...result } };
  } catch (err) {
    return { data: { error: err instanceof Error ? err.message : String(err) }, isError: true };
  }
}

/**
 * Sends a real email as the creator, to one of their own leads.
 *
 * The honesty gate that matters most here: the model supplies a
 * prospect_id, never an address. Everything after that resolves purely
 * from the database — the recipient's real stored email, the creator's
 * connected inbox and display name — exactly the discipline
 * findOfferByName() uses in qual-tools.ts to refuse a model's own
 * description of an offer in favor of the real row. There is no code path
 * here that ever puts a model-typed string into the `to:` header.
 */
async function emailProspect(ctx: AssistantToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const prospectId = typeof args.prospect_id === 'string' ? args.prospect_id.trim() : '';
  const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
  const body = typeof args.body === 'string' ? args.body.trim() : '';
  if (!prospectId || !subject || !body) {
    return { data: { error: 'prospect_id, subject, and body are all required.' }, isError: true };
  }

  const prospect = await ctx.db
    .prepare('SELECT id, email, name FROM prospects WHERE id = ? AND creator_id = ?')
    .get<{ id: string; email: string; name: string | null }>(prospectId, ctx.session.creator_id);
  if (!prospect) {
    return {
      data: { error: 'No lead with that id for this creator. Look them up with list_prospects first — do not guess an id or an address.' },
      isError: true,
    };
  }

  const conn = await ctx.db
    .prepare('SELECT gmail_address, refresh_token FROM email_connections WHERE creator_id = ?')
    .get<{ gmail_address: string; refresh_token: string }>(ctx.session.creator_id);
  if (!conn) {
    return { data: { error: 'No inbox is connected for this creator yet — that needs a Google login clicked through on the dashboard, not something you can do for them.' }, isError: true };
  }

  const creator = await ctx.db.prepare('SELECT coach_name FROM creators WHERE id = ?').get<{ coach_name: string }>(ctx.session.creator_id);

  // Threads into whatever conversation already exists with this lead —
  // the most recent message of any kind — rather than starting a
  // disconnected new thread out of nowhere. A genuinely first-ever
  // message to them just sends as a fresh thread.
  const priorMsg = await ctx.db
    .prepare(
      `SELECT gmail_message_id, gmail_thread_id FROM prospect_messages
        WHERE prospect_id = ? AND gmail_thread_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get<{ gmail_message_id: string | null; gmail_thread_id: string | null }>(prospectId);

  let accessToken: string;
  try {
    accessToken = await getAccessToken(
      { clientId: ctx.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: ctx.env.GOOGLE_OAUTH_CLIENT_SECRET },
      conn.refresh_token,
    );
  } catch (err) {
    return { data: { error: `Could not access the connected inbox: ${err instanceof Error ? err.message : String(err)}` }, isError: true };
  }

  const raw = buildRawMessage({
    to: prospect.email,
    from: conn.gmail_address,
    fromName: creator?.coach_name ?? null,
    subject,
    bodyText: body,
    inReplyTo: priorMsg?.gmail_message_id ?? null,
    references: priorMsg?.gmail_message_id ?? null,
  });

  try {
    await sendMessage(accessToken, raw, priorMsg?.gmail_thread_id ?? undefined);
  } catch (err) {
    return { data: { error: `The send failed: ${err instanceof Error ? err.message : String(err)}` }, isError: true };
  }

  // Confirms only what actually happened — the resolved address (never
  // echoed back from the model's own input) and the subject, so the
  // model's spoken confirmation to the creator is itself grounded in a
  // tool result rather than repeating what it assumed it just sent.
  return {
    data: {
      sent: true,
      to: prospect.email,
      to_name: prospect.name,
      subject,
    },
  };
}
