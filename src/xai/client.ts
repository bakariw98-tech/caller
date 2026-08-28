import { config } from '../config.js';

export class XaiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`xAI API ${status}: ${message}`);
    this.name = 'XaiApiError';
  }
}

async function request<T>(path: string, init: RequestInit & { method: string }): Promise<T> {
  const res = await fetch(`${config.xai.apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.xai.apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new XaiApiError(text.slice(0, 400), res.status, text);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export interface ProvisionedNumber {
  phone_number_id: string;
  phone_number?: string;
  sip_host?: string;
  webhook_id?: string;
  /** Returned exactly once. Losing it means re-provisioning the number. */
  signing_secret?: string;
  [key: string]: unknown;
}

/**
 * Registers a phone number for API-controlled SIP calls.
 *
 * The response carries the webhook signing secret and will never carry it
 * again, so callers must persist it in the same breath.
 */
export async function createPhoneNumber(params: {
  name: string;
  webhookUrl: string;
  areaCode?: string;
  agentId?: string;
}): Promise<ProvisionedNumber> {
  const body: Record<string, unknown> = {
    origin: 'xai_provisioned',
    name: params.name,
    webhook: { url: params.webhookUrl },
  };
  if (params.areaCode) body.area_code = params.areaCode;
  if (params.agentId) body.agent_id = params.agentId;

  return request<ProvisionedNumber>('/v2/phone-numbers', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Transfers a live call via SIP REFER.
 *
 * `tel:` targets reach the PSTN, `sip:` targets an endpoint. This is native to
 * the Voice Agent API — there is no bridge to build for it.
 */
export async function referCall(callId: string, targetUri: string): Promise<void> {
  await request(`/v1/realtime/calls/${encodeURIComponent(callId)}/refer`, {
    method: 'POST',
    body: JSON.stringify({ target_uri: targetUri }),
  });
}

export async function hangupCall(callId: string): Promise<void> {
  await request(`/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, { method: 'POST' });
}

export interface Voice {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export async function listVoices(): Promise<Voice[]> {
  const res = await request<{ voices?: Voice[]; data?: Voice[] }>('/v1/tts/voices', { method: 'GET' });
  return res.voices ?? res.data ?? [];
}

export function telUri(e164: string): string {
  const trimmed = e164.trim();
  return trimmed.startsWith('tel:') ? trimmed : `tel:${trimmed}`;
}
