import { config } from '../config.js';

export interface SessionConfigInputs {
  instructions: string;
  voice: string;
  /** Per-call bearer token; scopes every MCP call xAI makes to this one caller. */
  mcpToken: string;
  reasoningEffort?: 'high' | 'none';
  idleTimeoutMs?: number | null;
}

/**
 * Builds the `session.update` payload.
 *
 * Two things are worth knowing about a SIP `call_id` session:
 *
 * - We are a control channel, not a media relay. xAI terminates the phone leg
 *   itself, so audio never crosses this socket and no audio format is set here.
 *   (This is the opposite of the Media Streams pattern, where the server does
 *   relay every frame.)
 * - MCP tools are server-side. xAI connects to our MCP endpoint directly rather
 *   than routing tool calls back down this socket, which is why the token is
 *   embedded in the tool definition and why tool results never touch our
 *   WebSocket — or the text-input meter.
 */
export function buildSessionUpdate(inputs: SessionConfigInputs): Record<string, unknown> {
  const session: Record<string, unknown> = {
    voice: inputs.voice,
    instructions: inputs.instructions,
    // Documented as a flat dotted key on the session object rather than a
    // nested object. Most coaching turns are retrieval-grounded, so `none` is
    // the setting to measure first — see docs/COST-MODEL.md.
    'reasoning.effort': inputs.reasoningEffort ?? 'none',
    turn_detection: {
      type: 'server_vad',
      threshold: 0.85,
      silence_duration_ms: 500,
      prefix_padding_ms: 333,
      // Drives a proactive check-in when a caller goes quiet, which on this
      // product usually means they are performing the step rather than gone.
      idle_timeout_ms: inputs.idleTimeoutMs ?? config.call.idleTimeoutMs,
    },
    tools: [
      {
        type: 'mcp',
        server_url: `${config.publicBaseUrl}/mcp`,
        server_label: 'coach',
        server_description:
          "The caller's position in the course, the creator's curriculum, and progress recording.",
        authorization: `Bearer ${inputs.mcpToken}`,
        allowed_tools: [
          'get_caller_state',
          'get_current_step',
          'get_step_by_position',
          'search_curriculum',
          'diagnose_problem',
          'record_progress',
          'request_human',
        ],
      },
    ],
  };

  return { type: 'session.update', session };
}

/** One seeded state item per call. Billable, so it is sent exactly once. */
export function buildSeedItem(text: string): Record<string, unknown> {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  };
}

/** Exempt from the text meter, which makes it the cheap way to steer mid-call. */
export function buildResponseCreate(instructions?: string): Record<string, unknown> {
  return instructions
    ? { type: 'response.create', response: { instructions } }
    : { type: 'response.create' };
}
