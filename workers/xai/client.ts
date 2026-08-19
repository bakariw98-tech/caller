/** Same three REST calls as src/xai/client.ts, parameterised instead of reading the config singleton. */

export class XaiApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(`xAI API ${status}: ${message}`);
    this.name = 'XaiApiError';
  }
}

async function request<T>(apiBase: string, apiKey: string, path: string, init: RequestInit & { method: string }): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new XaiApiError(text.slice(0, 400), res.status, text);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface ProvisionedNumber {
  phone_number_id: string;
  phone_number?: string;
  sip_host?: string;
  webhook_id?: string;
  signing_secret?: string;
  [key: string]: unknown;
}

export async function createPhoneNumber(
  apiBase: string,
  apiKey: string,
  params: { name: string; webhookUrl: string; areaCode?: string; agentId?: string },
): Promise<ProvisionedNumber> {
  const body: Record<string, unknown> = { origin: 'xai_provisioned', name: params.name, webhook: { url: params.webhookUrl } };
  if (params.areaCode) body.area_code = params.areaCode;
  if (params.agentId) body.agent_id = params.agentId;
  return request<ProvisionedNumber>(apiBase, apiKey, '/v2/phone-numbers', { method: 'POST', body: JSON.stringify(body) });
}

export async function referCall(apiBase: string, apiKey: string, callId: string, targetUri: string): Promise<void> {
  await request(apiBase, apiKey, `/v1/realtime/calls/${encodeURIComponent(callId)}/refer`, {
    method: 'POST',
    body: JSON.stringify({ target_uri: targetUri }),
  });
}

export async function hangupCall(apiBase: string, apiKey: string, callId: string): Promise<void> {
  await request(apiBase, apiKey, `/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, { method: 'POST' });
}

/**
 * Mints a short-lived client secret a browser can use to connect directly
 * to the realtime API over a plain WebSocket, without ever seeing the
 * real XAI_API_KEY. Confirmed live on this account 2026-08-19 (`POST
 * /v1/realtime/client_secrets` → 200, a real `xai-realtime-client-secret-…`
 * value) — worth recording since this account has several other
 * capabilities disabled at the team level (`/v1/agents`,
 * `/v1/realtime/calls`, both 403 — see docs/XAI-API-NOTES.md), so this was
 * a genuine unknown, not an assumption.
 *
 * The connection this secret is used FOR (see workers/routes/talk.ts) was
 * first guessed as WebRTC/SDP, mirroring OpenAI's Realtime API — wrong,
 * confirmed by a live 405 ("Request method must be GET"). The real shape,
 * per docs.x.ai: a plain `wss://` WebSocket, with the secret passed as a
 * connection subprotocol (`xai-client-secret.{value}`) since browsers
 * cannot set WebSocket headers at all, and audio carried as base64 PCM16
 * JSON events over that same socket rather than a native WebRTC track.
 */
export async function mintEphemeralClientSecret(apiBase: string, apiKey: string): Promise<{ value: string; expiresAt: number }> {
  const result = await request<{ value: string; expires_at: number }>(apiBase, apiKey, '/v1/realtime/client_secrets', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return { value: result.value, expiresAt: result.expires_at };
}

export function telUri(e164: string): string {
  const trimmed = e164.trim();
  return trimmed.startsWith('tel:') ? trimmed : `tel:${trimmed}`;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost_in_usd_ticks?: number;
}

/**
 * USD per unit of xAI's `cost_in_usd_ticks`.
 *
 * xAI documents neither this field's unit nor that of the `*_token_price`
 * fields on /v1/language-models, so it was derived rather than assumed: three
 * calls of differing shape solve to 12,500 ticks per uncached prompt token,
 * 2,000 cached, 25,000 completion — exactly the prices that endpoint reports
 * for grok-4.20-non-reasoning. The published rates for those same three are
 * $1.25, $0.20 and $2.50 per million tokens, which fixes one tick at 1e-10 USD
 * on all three independently.
 *
 * This was 1e-9 until it was checked against the docs, which overstated every
 * measured cost tenfold. Worth stating plainly because pricing decisions are
 * meant to be made from these numbers, and a 10x error in the input is a 10x
 * error in the margin.
 *
 * Long-context prompts (>200k tokens) bill at double these rates. Nothing here
 * approaches that — the largest prompt this system builds is a few thousand
 * tokens — so the reported cost would understate a long-context call.
 */
export const USD_PER_TICK = 1e-10;


/**
 * Text inference with a required JSON schema.
 *
 * `strict: true` means the response is guaranteed to match the schema
 * structurally, which removes a whole class of parsing defence — but says
 * nothing about whether the *content* is faithful to the source. That part is
 * the prompt's job, and is why curriculum/structure.ts is written to be
 * extractive. Temperature is pinned to 0: this is an extraction task, and
 * two runs over one document should not disagree.
 */
export async function chatCompletionJson<T>(
  apiBase: string,
  apiKey: string,
  params: {
    model: string;
    system: string;
    user: string;
    schemaName: string;
    schema: Record<string, unknown>;
  },
): Promise<{ value: T; usage: ChatUsage }> {
  const res = await fetch(`${apiBase}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: params.model,
      temperature: 0,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: params.schemaName, strict: true, schema: params.schema },
      },
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new XaiApiError(text.slice(0, 400), res.status, text);

  const body = JSON.parse(text) as {
    choices?: { message?: { content?: string } }[];
    usage?: ChatUsage;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new XaiApiError('No content in completion response', res.status, text.slice(0, 400));

  return { value: JSON.parse(content) as T, usage: body.usage ?? {} };
}
