/**
 * Same shape as src/coach/session-config.ts, parameterised instead of reading
 * the config singleton (Workers has no process.env-backed global config;
 * everything comes from the per-request Env).
 */
export interface SessionConfigInputs {
  instructions: string;
  voice: string;
  mcpToken: string;
  mcpUrl: string;
  reasoningEffort?: 'high' | 'none';
  idleTimeoutMs: number;
}

export function buildSessionUpdate(inputs: SessionConfigInputs): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      voice: inputs.voice,
      instructions: inputs.instructions,
      'reasoning.effort': inputs.reasoningEffort ?? 'none',
      turn_detection: {
        type: 'server_vad',
        threshold: 0.85,
        silence_duration_ms: 500,
        prefix_padding_ms: 333,
        idle_timeout_ms: inputs.idleTimeoutMs,
      },
      tools: [
        {
          type: 'mcp',
          server_url: inputs.mcpUrl,
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
    },
  };
}

export function buildSeedItem(text: string): Record<string, unknown> {
  return {
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  };
}

export function buildResponseCreate(instructions?: string): Record<string, unknown> {
  return instructions
    ? { type: 'response.create', response: { instructions } }
    : { type: 'response.create' };
}
