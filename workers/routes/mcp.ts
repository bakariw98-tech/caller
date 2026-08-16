import { Hono } from 'hono';
import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { resolveToken } from '../mcp/auth.js';
import { callTool, TOOL_DEFINITIONS, type ToolContext } from '../mcp/tools.js';
import { id, now } from '../../src/util/ids.js';

export const mcpRoute = new Hono<{ Bindings: Env }>();

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

  // Diagnostic: full incoming header set, visible via `wrangler tail`, to see
  // exactly what the console-managed agent path sends — this is genuinely
  // undocumented territory (see chat), and the fastest way to a real answer
  // is watching a real request rather than guessing from docs. Authorization
  // is redacted to its first 12 chars so a real token never lands in logs.
  const headerDump: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headerDump[k] = k.toLowerCase() === 'authorization' ? `${v.slice(0, 12)}…` : v;
  });
  // JSON.stringify rather than passing the object to console.log directly —
  // Node's default object inspection truncates nested objects (like _meta,
  // exactly where caller context would live) as "[Object]" past a shallow
  // depth. Full text avoids losing that.
  console.log(
    'MCP request',
    JSON.stringify({ method: c.req.method, query: c.req.query(), headers: headerDump, body }, null, 2),
  );

  if (!body) return c.json(error(null, -32700, 'Empty request body'), 400);

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
      const session = await resolveToken(db, env.MCP_TOKEN_SECRET, authHeader);
      if (!session) return error(rpc.id, -32001, 'Unauthorized');
      return result(rpc.id, {
        tools: TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    }

    case 'tools/call': {
      const session = await resolveToken(db, env.MCP_TOKEN_SECRET, authHeader);
      if (!session) return error(rpc.id, -32001, 'Unauthorized');

      const name = String(rpc.params?.name ?? '');
      const args = (rpc.params?.arguments as Record<string, unknown> | undefined) ?? {};

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

      try {
        const out = await callTool(ctx, name, args);
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
