import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/index.js';
import { resolveToken } from './auth.js';
import { callTool, TOOL_DEFINITIONS, type ToolContext } from './tools.js';
import { getActiveCall } from '../telephony/registry.js';
import { id, now } from '../util/ids.js';

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
 * MCP endpoint that xAI calls directly.
 *
 * Worth being explicit about the shape of this: MCP tools on the Voice Agent
 * API are server-side. xAI opens its own connection here rather than routing
 * tool calls back through the realtime socket, which is why this is a public
 * HTTP surface and why every request must authenticate on its own.
 *
 * It is also why retrieval is free: results return to xAI as tool output, which
 * the text-input meter exempts. Injecting the same material as conversation
 * items would be billed on every turn.
 */
export function registerMcpServer(app: FastifyInstance): void {
  app.post('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as JsonRpcRequest | JsonRpcRequest[] | undefined;
    if (!body) return reply.code(400).send(error(null, -32700, 'Empty request body'));

    // Notifications carry no id and expect no response body.
    const batch = Array.isArray(body) ? body : [body];
    const responses: unknown[] = [];

    for (const rpc of batch) {
      const res = await handleRpc(req, rpc);
      if (res !== null) responses.push(res);
    }

    if (responses.length === 0) return reply.code(202).send();
    return reply.send(Array.isArray(body) ? responses : responses[0]);
  });

  // Streaming transport is not used: every tool here answers in one shot.
  app.get('/mcp', async (_req, reply) => reply.code(405).send({ error: 'Use POST for MCP requests' }));
}

async function handleRpc(req: FastifyRequest, rpc: JsonRpcRequest): Promise<unknown | null> {
  const db = getDb();

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
      // Listing is harmless without a live call, but a bad token still fails so
      // the surface never appears to unauthenticated callers.
      const session = resolveToken(db, req.headers.authorization);
      if (!session) return error(rpc.id, -32001, 'Unauthorized');
      return result(rpc.id, {
        tools: TOOL_DEFINITIONS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    case 'tools/call': {
      const session = resolveToken(db, req.headers.authorization);
      if (!session) return error(rpc.id, -32001, 'Unauthorized');

      const name = String(rpc.params?.name ?? '');
      const args = (rpc.params?.arguments as Record<string, unknown> | undefined) ?? {};

      const live = getActiveCall(session.call_id);
      const ctx: ToolContext = {
        db,
        session,
        transferCall: live ? (target: string) => live.transferTo(target) : undefined,
        logEvent: (type, payload, stepId) => {
          db.prepare(
            `INSERT INTO call_events (id, call_id, creator_id, type, step_id, payload_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id('ev'),
            session.call_id,
            session.creator_id,
            type,
            stepId ?? null,
            JSON.stringify(payload),
            now(),
          );
        },
      };

      try {
        const out = await callTool(ctx, name, args);
        return result(rpc.id, {
          content: [{ type: 'text', text: JSON.stringify(out.data) }],
          isError: out.isError ?? false,
        });
      } catch (err) {
        req.log.error({ err, tool: name }, 'MCP tool failed');
        // Returned as tool content rather than a protocol error: the coach is
        // mid-sentence on a phone call and needs something it can say.
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
