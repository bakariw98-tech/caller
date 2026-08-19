import type { SqlDb } from '../db/types.js';
import type { McpQualSession } from './auth.js';
import type { ToolDefinition, ToolResult } from './tools.js';
import { applyProspectSignals } from '../leadgen/prospects.js';
import { loadFullOffers, type FullOfferRow } from '../leadgen/reply.js';
import { ctaPhrase } from '../leadgen/call-prompt.js';

/**
 * The three tools a qualification call gets — a disjoint set from
 * TOOL_DEFINITIONS in tools.ts. Kept in a separate file/dispatcher rather
 * than merged into that one: the coach's tools and these never run in the
 * same call, they gate on a different session shape (McpQualSession vs
 * McpSession), and mixing them would mean every coach handler gains a
 * qualify-session branch it can never actually take. See workers/routes/
 * mcp.ts for how resolveToken()'s tagged result picks which of these two
 * dispatchers a given call goes through.
 */
export const QUAL_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'resolve_prospect',
    description:
      'Who you are speaking with. Call this the moment they give you the short code from their invite email — ' +
      "never proceed to real discovery before this resolves. If it doesn't match, ask them to double check it " +
      'rather than guessing who they are.',
    inputSchema: {
      type: 'object',
      properties: {
        call_code: { type: 'string', description: 'The short code they read you from their email.' },
      },
      required: ['call_code'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_qualification_signal',
    description:
      'Persist what you have just learned about this person, the moment you learn it — not saved up for the ' +
      'end of the call. Its response tells you whether you have earned the right to discuss a specific offer: ' +
      'pass considering_offer_name once you believe one might fit, and if the response says qualifies:true ' +
      'and returns that offer\'s details, those returned details are the only facts you may state about it.',
    inputSchema: {
      type: 'object',
      properties: {
        situation: { type: 'string', description: 'What they do, how long, what they are working with.' },
        diagnosed_problem: { type: 'string', description: 'The real bottleneck you have identified, not just what they reported.' },
        goal: { type: 'string', description: 'What they actually want this to produce.' },
        tried: { type: 'string', description: 'What they have already tried.' },
        blocked_on: { type: 'string', description: 'What they say is stopping them.' },
        knowledge_level: { type: 'string', description: 'What they already understand.' },
        urgency: { type: 'string', description: 'Why this matters to them, and by when.' },
        objections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Any reservations or doubts they have voiced.',
        },
        considering_offer_name: {
          type: 'string',
          description: "The exact name of an offer you are considering recommending, once you believe one fits — from the offers list you were given at the start of the call.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'record_call_outcome',
    description:
      'Record how the call actually went. Call this once things resolve — an offer discussed, an objection ' +
      'raised, a next step agreed to or not. This is how the creator sees what really happens on these calls, ' +
      'and next_step_accepted decides which follow-up email goes out afterward.',
    inputSchema: {
      type: 'object',
      properties: {
        offer_presented: { type: 'boolean', description: 'True if you named and discussed a specific offer.' },
        objection_raised: { type: 'boolean', description: 'True if they voiced any real reservation.' },
        next_step_accepted: { type: 'boolean', description: 'True if they agreed to take the actual next step you offered.' },
        accepted_offer_name: {
          type: 'string',
          description: 'The exact name of the offer they accepted, when next_step_accepted is true.',
        },
      },
      additionalProperties: false,
    },
  },
];

export interface QualToolContext {
  db: SqlDb;
  session: McpQualSession;
}

export async function callQualTool(ctx: QualToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'resolve_prospect':
      return resolveProspect(ctx, args);
    case 'record_qualification_signal':
      return recordQualificationSignal(ctx, args);
    case 'record_call_outcome':
      return recordCallOutcome(ctx, args);
    default:
      return { data: { error: `Unknown tool: ${name}` }, isError: true };
  }
}

const NOT_RESOLVED = {
  resolved: false,
  guidance:
    'No prospect matches that code for this creator. Ask them to read it back again slowly, or confirm they ' +
    'actually got a call invite email — do not guess who you are speaking with.',
};

async function resolveProspect(ctx: QualToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const code = typeof args.call_code === 'string' ? args.call_code.trim() : '';
  if (!code) return { data: NOT_RESOLVED };

  const prospect = await ctx.db
    .prepare('SELECT * FROM prospects WHERE creator_id = ? AND call_code = ?')
    .get<Record<string, any>>(ctx.session.creator_id, code);
  if (!prospect) return { data: NOT_RESOLVED };

  // Session-bound from here on: every later tool call in this conversation
  // re-reads mcp_qual_sessions via resolveToken(), so writing prospect_id
  // here is what carries identity forward without asking the caller to
  // repeat their code — the same mechanism the coach's session.customer_id
  // already relies on.
  await ctx.db.prepare('UPDATE mcp_qual_sessions SET prospect_id = ? WHERE token_hash = ?').run(prospect.id, ctx.session.token_hash);
  await ctx.db.prepare('UPDATE calls SET prospect_id = ? WHERE id = ?').run(prospect.id, ctx.session.call_id);

  const returningWithContext = Boolean(prospect.situation || prospect.diagnosed_problem || prospect.goal);

  return {
    data: {
      resolved: true,
      first_name: prospect.name?.split(/\s+/)[0] ?? null,
      returning_with_known_context: returningWithContext,
      known_context: returningWithContext
        ? {
            situation: prospect.situation,
            diagnosed_problem: prospect.diagnosed_problem,
            goal: prospect.goal,
            tried: prospect.tried,
            urgency: prospect.urgency,
          }
        : null,
    },
  };
}

async function findOfferByName(db: SqlDb, creatorId: string, name: string | undefined): Promise<FullOfferRow | null> {
  const trimmed = name?.trim().toLowerCase();
  if (!trimmed) return null;
  const offers = await loadFullOffers(db, creatorId);
  return offers.find((o) => o.name.trim().toLowerCase() === trimmed) ?? null;
}

const NO_PROSPECT_YET = {
  recorded: false,
  qualifies: false,
  guidance: 'No prospect resolved yet — call resolve_prospect with the code they give you before recording anything.',
};

async function recordQualificationSignal(ctx: QualToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.session.prospect_id) return { data: NO_PROSPECT_YET };

  const prospect = await ctx.db.prepare('SELECT * FROM prospects WHERE id = ?').get<Record<string, any>>(ctx.session.prospect_id);
  if (!prospect) return { data: NO_PROSPECT_YET };

  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const objections = Array.isArray(args.objections) ? args.objections.filter((x): x is string => typeof x === 'string') : [];

  const result = await applyProspectSignals(
    ctx.db,
    prospect,
    {
      situation: str(args.situation),
      diagnosed_problem: str(args.diagnosed_problem),
      goal: str(args.goal),
      tried: str(args.tried),
      blocked_on: str(args.blocked_on),
      knowledge_level: str(args.knowledge_level),
      urgency: str(args.urgency),
      objections,
    },
    // A live call is many tool calls per one real interaction, not one
    // exchange per call — see ApplyProspectSignalsOptions' own doc comment.
    { exchangesDelta: 0 },
  );

  if (!result.qualifiedNow) {
    return {
      data: {
        recorded: true,
        qualifies: false,
        guidance: 'Not enough is known yet to responsibly recommend anything. Keep discovering — situation, the real problem, and what they want all need to be genuinely understood first.',
      },
    };
  }

  const consideredName = typeof args.considering_offer_name === 'string' ? args.considering_offer_name : undefined;
  const offer = await findOfferByName(ctx.db, ctx.session.creator_id, consideredName);

  if (!consideredName) {
    return {
      data: {
        recorded: true,
        qualifies: true,
        guidance: 'You now have enough to honestly discuss whether an offer fits. Reflect the diagnosis back and get it confirmed before naming anything. Once you believe a specific offer fits, call this again with considering_offer_name set to get its real details.',
        offer: null,
      },
    };
  }

  if (!offer) {
    return {
      data: {
        recorded: true,
        qualifies: true,
        guidance: `"${consideredName}" does not match any of this creator's active offers by that exact name. Do not state pricing or claims about it — use the exact name from the offers list you were given at the start of the call.`,
        offer: null,
      },
    };
  }

  return {
    data: {
      recorded: true,
      qualifies: true,
      offer: {
        name: offer.name,
        covers: offer.covers,
        who_for: offer.who_for,
        price_text: offer.price_text,
        cta: ctaPhrase(offer.cta_tier),
      },
    },
  };
}

async function recordCallOutcome(ctx: QualToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const offerPresented = args.offer_presented === true ? 1 : 0;
  const objectionRaised = args.objection_raised === true ? 1 : 0;
  const nextStepAccepted = args.next_step_accepted === true ? 1 : 0;

  let acceptedOfferId: string | null = null;
  if (nextStepAccepted && typeof args.accepted_offer_name === 'string') {
    const offer = await findOfferByName(ctx.db, ctx.session.creator_id, args.accepted_offer_name);
    acceptedOfferId = offer?.id ?? null;
  }

  await ctx.db
    .prepare(
      `UPDATE calls
          SET offer_presented = MAX(offer_presented, ?), objection_raised = MAX(objection_raised, ?),
              next_step_accepted = MAX(next_step_accepted, ?),
              accepted_offer_id = COALESCE(?, accepted_offer_id)
        WHERE id = ?`,
    )
    .run(offerPresented, objectionRaised, nextStepAccepted, acceptedOfferId, ctx.session.call_id);

  return { data: { recorded: true } };
}
