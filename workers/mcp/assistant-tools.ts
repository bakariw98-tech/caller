import type { SqlDb } from '../db/types.js';
import type { McpAssistantSession } from './auth.js';
import type { ToolDefinition, ToolResult } from './tools.js';

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
];

export interface AssistantToolContext {
  db: SqlDb;
  session: McpAssistantSession;
}

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
