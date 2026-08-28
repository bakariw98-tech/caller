/**
 * Minimal transcriptapi.com client — just the surface whole-channel
 * ingestion needs: resolve a handle to a channel id, paginate its uploads,
 * and fetch a transcript. fetch() against the documented REST endpoints,
 * same approach as workers/email/gmail.ts and for the same reason (no SDK
 * assumes Node; this runs on Workers).
 *
 * Two of the four calls are free (resolve, info) and cost nothing to call
 * speculatively. Enumeration is ~1 credit per ~100-video page. Transcripts
 * are 1 credit each and are the only per-video spend — see
 * workers/youtube/tier.ts for how that spend is gated by title+duration
 * before this client is ever asked for a transcript.
 */

const API_BASE = 'https://transcriptapi.com/api/v2';

export interface TranscriptApiConfig {
  apiKey: string;
  /** Override for tests; defaults to the real API. */
  baseUrl?: string;
}

export class TranscriptApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** 402 specifically — the account is out of credits. Callers distinguish this from a bad request or a missing transcript so ingestion can pause cleanly rather than fail every remaining video one at a time. */
export class TranscriptApiQuotaError extends TranscriptApiError {}

async function apiFetch<T>(config: TranscriptApiConfig, path: string, params: Record<string, string | undefined>): Promise<T> {
  const url = new URL(`${config.baseUrl ?? API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${config.apiKey}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 402) throw new TranscriptApiQuotaError(`transcriptapi.com: out of credits (${body})`.trim(), 402);
    throw new TranscriptApiError(`transcriptapi.com ${path} failed: ${res.status} ${body}`.trim(), res.status);
  }
  return res.json() as Promise<T>;
}

export interface ResolvedChannel {
  channel_id: string;
  resolved_from: string;
}

/** Free. Converts an @handle, channel URL, or UC… id to the canonical channel id. */
export function resolveChannel(config: TranscriptApiConfig, input: string): Promise<ResolvedChannel> {
  return apiFetch<ResolvedChannel>(config, '/youtube/channel/resolve', { input });
}

export interface ChannelVideoRaw {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  lengthText?: string;
  viewCountText?: string;
}

export interface ChannelVideosPage {
  results: ChannelVideoRaw[];
  playlist_info?: { title?: string; numVideos?: string };
  continuation_token: string | null;
  has_more: boolean;
}

/**
 * One page of a channel's uploads (~100 videos). Pass `channel` for the
 * first page, then the `continuation_token` from that response for every
 * page after — the two params are mutually exclusive per the API, so
 * callers pick one and this does not try to guess which.
 */
export function listChannelVideos(
  config: TranscriptApiConfig,
  params: { channel: string } | { continuation: string },
): Promise<ChannelVideosPage> {
  return apiFetch<ChannelVideosPage>(config, '/youtube/channel/videos', params as Record<string, string>);
}

export interface VideoInfo {
  video_id: string;
  metadata: { title: string; author_name?: string; author_url?: string; thumbnail_url?: string };
  available_languages: { code: string; name: string }[];
}

/** Free. Not used by the enumeration path (channel/videos already carries title+lengthText) — kept for one-off lookups, e.g. a dashboard preview of a single pasted video URL. */
export function getVideoInfo(config: TranscriptApiConfig, videoUrl: string): Promise<VideoInfo> {
  return apiFetch<VideoInfo>(config, '/youtube/info', { video_url: videoUrl });
}

export interface TranscriptResult {
  video_id: string;
  language: string;
  transcript: { text: string; start: number; duration: number }[];
  length_seconds?: number;
}

/** 1 credit. Plain text is what extraction actually consumes, so timestamps are dropped at the source rather than stripped downstream. */
export function getTranscript(config: TranscriptApiConfig, videoUrl: string): Promise<TranscriptResult> {
  return apiFetch<TranscriptResult>(config, '/youtube/transcript', { video_url: videoUrl, format: 'json', include_timestamp: 'false' });
}

/**
 * `lengthText` from the channel listing is a free byproduct of enumeration
 * ("15:22", "1:02:33", or occasionally just seconds/missing) — parsing it
 * here means tierVideo() never needs a second network call per video just
 * to learn duration. Pure and exported so the parsing itself is testable
 * independent of the network.
 */
export function parseLengthText(lengthText: string | undefined | null): number | null {
  if (!lengthText) return null;
  const parts = lengthText.trim().split(':');
  if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}
