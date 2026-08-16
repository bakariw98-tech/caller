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

export function telUri(e164: string): string {
  const trimmed = e164.trim();
  return trimmed.startsWith('tel:') ? trimmed : `tel:${trimmed}`;
}
