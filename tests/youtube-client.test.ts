import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseLengthText,
  resolveChannel,
  listChannelVideos,
  getTranscript,
  TranscriptApiQuotaError,
  TranscriptApiError,
} from '../workers/youtube/client.js';

describe('parseLengthText', () => {
  it('parses mm:ss', () => {
    expect(parseLengthText('15:22')).toBe(15 * 60 + 22);
  });

  it('parses h:mm:ss', () => {
    expect(parseLengthText('1:02:33')).toBe(1 * 3600 + 2 * 60 + 33);
  });

  it('returns null for missing or unparseable text', () => {
    expect(parseLengthText(undefined)).toBeNull();
    expect(parseLengthText(null)).toBeNull();
    expect(parseLengthText('LIVE')).toBeNull();
    expect(parseLengthText('')).toBeNull();
  });
});

describe('transcriptapi.com client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the bearer token and returns the parsed channel id', async () => {
    let seenAuth: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
        expect(url).toContain('/youtube/channel/resolve?input=%40TED');
        return new Response(JSON.stringify({ channel_id: 'UC123', resolved_from: '@TED' }), { status: 200 });
      }),
    );

    const result = await resolveChannel({ apiKey: 'sk_test' }, '@TED');
    expect(result.channel_id).toBe('UC123');
    expect(seenAuth).toBe('Bearer sk_test');
  });

  it('passes a continuation token instead of channel on a follow-up page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('continuation=tok123');
        expect(url).not.toContain('channel=');
        return new Response(JSON.stringify({ results: [], continuation_token: null, has_more: false }), { status: 200 });
      }),
    );
    await listChannelVideos({ apiKey: 'sk_test' }, { continuation: 'tok123' });
  });

  it('raises TranscriptApiQuotaError distinctly on 402', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('out of credits', { status: 402 })));
    await expect(getTranscript({ apiKey: 'sk_test' }, 'abc123')).rejects.toBeInstanceOf(TranscriptApiQuotaError);
  });

  it('raises the plain error type on other failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })));
    const err = await getTranscript({ apiKey: 'sk_test' }, 'abc123').catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptApiError);
    expect(err).not.toBeInstanceOf(TranscriptApiQuotaError);
  });
});
