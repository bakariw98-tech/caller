import { Hono } from 'hono';
import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { resolveToken } from '../mcp/auth.js';
import { callTool, TOOL_DEFINITIONS, type ToolContext, type ToolDefinition } from '../mcp/tools.js';
import { callQualTool, QUAL_TOOL_DEFINITIONS, type QualToolContext } from '../mcp/qual-tools.js';
import { callAssistantTool, ASSISTANT_TOOL_DEFINITIONS, type AssistantToolContext } from '../mcp/assistant-tools.js';
import { id, now } from '../../src/util/ids.js';

export const mcpRoute = new Hono<{ Bindings: Env }>();

/**
 * The tool list for a resolved session kind — extracted as a pure function
 * so the fail-closed behavior on an unhandled kind is directly unit
 * testable (tests/mcp-dispatch.test.ts) rather than only checkable by
 * driving the whole Hono route. See tools/list's own comment on why this
 * must never be an else-branch: a new session kind added without a case
 * here must get NOTHING, not silently inherit whichever kind used to be
 * last in the chain.
 */
export function toolDefinitionsForKind(kind: string): ToolDefinition[] {
  switch (kind) {
    case 'coach':
      return TOOL_DEFINITIONS;
    case 'qualify':
      return QUAL_TOOL_DEFINITIONS;
    case 'assistant':
      return ASSISTANT_TOOL_DEFINITIONS;
    default:
      console.error('toolDefinitionsForKind: unhandled session kind', kind);
      return [];
  }
}

const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function result(reqId: string | number | null | undefined, value: unknown) {
  return { jsonrpc: '2.0' as const, id: reqId ?? null, result: value };
}
function error(reqId: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id: reqId ?? null, error: { code, message } };
}

/**
 * MCP endpoint xAI calls directly for tool use — same JSON-RPC surface as
 * src/mcp/server.ts. See that file's header comment for why this endpoint has
 * to be public and self-authenticating: MCP tools on the Voice Agent API are
 * server-side, xAI connects here itself rather than routing tool calls back
 * down the realtime WebSocket.
 */
mcpRoute.post('/mcp', async (c) => {
  const body = (await c.req.json().catch(() => undefined)) as JsonRpcRequest | JsonRpcRequest[] | undefined;

  if (!body) return c.json(error(null, -32700, 'Empty request body'), 400);

  // Was a full dump of every header and the complete JSON body, added to
  // reverse-engineer what xAI's console-managed agent path actually sends —
  // it did that job. Trimmed to method + tool name once third-party agents
  // (Part 3, creator-scoped MCP keys) could reach this endpoint: a
  // qualification call's discovery signals, and now an assistant call's
  // knowledge/offer edits and eventually real email text, would otherwise
  // sit in plaintext logs indefinitely. This still shows exactly which tool
  // fired and roughly when, without the arguments.
  const batchForLog = Array.isArray(body) ? body : [body];
  console.log('MCP request', JSON.stringify(batchForLog.map((r) => ({ method: r.method, tool: r.params?.name }))));

  // Console-managed tool config may only expose a URL field, not custom
  // headers — support the token as a query param too so `?token=...` works
  // as a fallback authorization channel.
  const auth = c.req.header('Authorization') ?? (c.req.query('token') ? `Bearer ${c.req.query('token')}` : undefined);

  const batch = Array.isArray(body) ? body : [body];
  const responses: unknown[] = [];
  for (const rpc of batch) {
    const res = await handleRpc(c.env, auth, rpc);
    if (res !== null) responses.push(res);
  }

  if (responses.length === 0) return c.body(null, 202);
  return c.json(Array.isArray(body) ? responses : responses[0]);
});

mcpRoute.get('/mcp', (c) => c.json({ error: 'Use POST for MCP requests' }, 405));

async function handleRpc(env: Env, authHeader: string | undefined, rpc: JsonRpcRequest): Promise<unknown | null> {
  const db = wrapD1(env.DB);

  switch (rpc.method) {
    case 'initialize':
      return result(rpc.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'coach', version: '0.1.0' },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return result(rpc.id, {});

    case 'tools/list': {
      const resolved = await resolveToken(db, env.MCP_TOKEN_SECRET, authHeader);
      if (!resolved) return error(rpc.id, -32001, 'Unauthorized');
      const defs = toolDefinitionsForKind(resolved.kind);
      return result(rpc.id, {
        // annotations only included when a tool actually sets them — an
        // absent key is the MCP-spec-correct way to say "no hint", not an
        // empty object every client has to special-case.
        tools: defs.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        })),
      });
    }

    case 'tools/call': {
      const resolved = await resolveToken(db, env.MCP_TOKEN_SECRET, authHeader);
      if (!resolved) return error(rpc.id, -32001, 'Unauthorized');

      const name = String(rpc.params?.name ?? '');
      const args = (rpc.params?.arguments as Record<string, unknown> | undefined) ?? {};

      try {
        let out: { data: unknown; isError?: boolean };

        if (resolved.kind === 'coach') {
          const session = resolved.session;
          const ctx: ToolContext = {
            db,
            session,
            transferCall: async (targetE164: string) => {
              const stub = env.CALL_SESSION.get(env.CALL_SESSION.idFromName(session.call_id));
              const res = await stub.fetch('https://call-session/transfer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetE164 }),
              });
              if (!res.ok) throw new Error(`transfer failed: ${await res.text()}`);
            },
            logEvent: async (type, payload, stepId) => {
              await db
                .prepare(
                  `INSERT INTO call_events (id, call_id, creator_id, type, step_id, payload_json, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(id('ev'), session.call_id, session.creator_id, type, stepId ?? null, JSON.stringify(payload), now());
            },
          };
          out = await callTool(ctx, name, args);
        } else if (resolved.kind === 'qualify') {
          const ctx: QualToolContext = { db, session: resolved.session };
          out = await callQualTool(ctx, name, args);
        } else if (resolved.kind === 'assistant') {
          const ctx: AssistantToolContext = { db, env, session: resolved.session };
          out = await callAssistantTool(ctx, name, args);
        } else {
          // Same fail-closed discipline as tools/list above: an unhandled
          // kind must be a loud, explicit error, never fall through to
          // whichever handler happens to be last.
          console.error('tools/call: unhandled session kind', (resolved as { kind: string }).kind);
          return error(rpc.id, -32001, 'Unauthorized');
        }

        return result(rpc.id, { content: [{ type: 'text', text: JSON.stringify(out.data) }], isError: out.isError ?? false });
      } catch (err) {
        console.error('MCP tool failed', name, err);
        return result(rpc.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: true,
                say: 'Tell the caller you are having trouble pulling that up, and ask them to hold a moment.',
              }),
            },
          ],
          isError: true,
        });
      }
    }

    default:
      return error(rpc.id, -32601, `Method not found: ${rpc.method}`);
  }
}
