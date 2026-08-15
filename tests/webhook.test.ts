import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createTestDb } from '../src/db/index.js';
import {
  claimWebhookId,
  normalizeE164,
  parseIncomingCall,
  verifyWebhook,
  WebhookVerificationError,
} from '../src/xai/webhook.js';
import { now } from '../src/util/ids.js';

const SECRET = 'whsec_dGVzdC1zZWNyZXQtdmFsdWUtZm9yLXNpZ25pbmc=';

function sign(webhookId: string, timestamp: number, body: string, secret = SECRET): string {
  const raw = Buffer.from(secret.slice(6), 'base64');
  return `v1,${createHmac('sha256', raw).update(`${webhookId}.${timestamp}.${body}`).digest('base64')}`;
}

const BODY = JSON.stringify({
  object: 'event',
  id: 'evt_123',
  type: 'realtime.call.incoming',
  created_at: 1750000000,
  data: {
    call_id: '00000000-0000-0000-0000-000000000000',
    sip_headers: [
      { name: 'From', value: '+14155550100' },
      { name: 'To', value: '+18005550199' },
    ],
  },
});

describe('webhook verification', () => {
  it('accepts a correctly signed request', () => {
    const ts = now();
    const res = verifyWebhook({
      headers: {
        'webhook-id': 'evt_123',
        'webhook-timestamp': String(ts),
        'webhook-signature': sign('evt_123', ts, BODY),
      },
      rawBody: BODY,
      signingSecret: SECRET,
    });
    expect(res.webhookId).toBe('evt_123');
  });

  it('rejects a tampered body', () => {
    const ts = now();
    const signature = sign('evt_123', ts, BODY);
    expect(() =>
      verifyWebhook({
        headers: { 'webhook-id': 'evt_123', 'webhook-timestamp': String(ts), 'webhook-signature': signature },
        rawBody: BODY.replace('+14155550100', '+14155550999'),
        signingSecret: SECRET,
      }),
    ).toThrow(WebhookVerificationError);
  });

  it('rejects a stale timestamp, so a captured request cannot be replayed', () => {
    const old = now() - 3600;
    expect(() =>
      verifyWebhook({
        headers: {
          'webhook-id': 'evt_123',
          'webhook-timestamp': String(old),
          'webhook-signature': sign('evt_123', old, BODY),
        },
        rawBody: BODY,
        signingSecret: SECRET,
      }),
    ).toThrow(/tolerance/);
  });

  it('rejects a signature made with a different secret', () => {
    const ts = now();
    expect(() =>
      verifyWebhook({
        headers: {
          'webhook-id': 'evt_123',
          'webhook-timestamp': String(ts),
          'webhook-signature': sign('evt_123', ts, BODY, 'whsec_b3RoZXItc2VjcmV0'),
        },
        rawBody: BODY,
        signingSecret: SECRET,
      }),
    ).toThrow(WebhookVerificationError);
  });

  it('accepts one valid signature among several during rotation', () => {
    const ts = now();
    const header = `${sign('evt_123', ts, BODY, 'whsec_b3RoZXItc2VjcmV0')} ${sign('evt_123', ts, BODY)}`;
    expect(() =>
      verifyWebhook({
        headers: { 'webhook-id': 'evt_123', 'webhook-timestamp': String(ts), 'webhook-signature': header },
        rawBody: BODY,
        signingSecret: SECRET,
      }),
    ).not.toThrow();
  });

  it('rejects a request with no signature headers', () => {
    expect(() => verifyWebhook({ headers: {}, rawBody: BODY, signingSecret: SECRET })).toThrow(
      /Missing webhook-id/,
    );
  });
});

describe('replay protection', () => {
  it('claims an id once and refuses it thereafter', () => {
    const db = createTestDb();
    expect(claimWebhookId(db, 'evt_123', 'realtime.call.incoming')).toBe(true);
    expect(claimWebhookId(db, 'evt_123', 'realtime.call.incoming')).toBe(false);
  });
});

describe('payload parsing', () => {
  it('pulls the call id and both numbers out of the SIP headers', () => {
    const event = parseIncomingCall(JSON.parse(BODY))!;
    expect(event.callId).toBe('00000000-0000-0000-0000-000000000000');
    expect(event.from).toBe('+14155550100');
    expect(event.to).toBe('+18005550199');
  });

  it('ignores event types that are not incoming calls', () => {
    expect(parseIncomingCall({ type: 'realtime.call.ended', data: { call_id: 'x' } })).toBeNull();
  });

  it('normalises the shapes SIP From headers arrive in', () => {
    expect(normalizeE164('sip:+14155550100@sip.voice.x.ai')).toBe('+14155550100');
    expect(normalizeE164('"Dana" <sip:14155550100@example.com>')).toBe('+14155550100');
    expect(normalizeE164('tel:+14155550100')).toBe('+14155550100');
    expect(normalizeE164('(415) 555-0100')).toBe('+14155550100');
    expect(normalizeE164(null)).toBeNull();
  });
});
