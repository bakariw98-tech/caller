import type { CallSessionDO } from './durable-objects/call-session.js';

/** Bindings and vars declared in wrangler.toml. */
export interface Env {
  DB: D1Database;
  CALL_SESSION: DurableObjectNamespace<CallSessionDO>;
  /** Workers AI — embeddings for semantic retrieval, see leadgen/embeddings.ts. */
  AI: Ai;

  XAI_API_KEY: string;
  XAI_API_BASE: string;
  XAI_REALTIME_HOST: string; // e.g. api.x.ai — used to build the wss:// URL
  XAI_VOICE_MODEL: string;
  XAI_TEXT_MODEL: string; // structuring uploaded curriculum; see curriculum/structure.ts
  XAI_WEBHOOK_SIGNING_SECRET: string; // fallback only; numbers carry their own

  PUBLIC_BASE_URL: string;
  MCP_TOKEN_SECRET: string;
  ADMIN_TOKEN: string;
  /** Signs creator login session tokens — deliberately separate from MCP_TOKEN_SECRET, see workers/auth/session.ts. */
  SESSION_SECRET: string;

  // Gmail transport for the lead engine. One Google Cloud project's OAuth
  // client is shared across every creator; each creator's own refresh token
  // is per-row in email_connections, not here — see workers/schema.sql.
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;

  // transcriptapi.com — YouTube channel enumeration and transcripts for
  // knowledge-base ingestion. See workers/youtube/.
  TRANSCRIPT_API_KEY: string;

  PLATFORM_MIN_PRICE_PER_MINUTE_CENTS: string;
  PLATFORM_AUDIO_COST_PER_MINUTE_CENTS: string;
  MAX_SESSION_SECONDS: string;
  LOW_BALANCE_WARNING_SECONDS: string;
  FINAL_WARNING_SECONDS: string;
  IDLE_TIMEOUT_MS: string;
}

export interface AppConfig {
  minPricePerMinuteCents: number;
  audioCostPerMinuteCents: number;
  maxSessionSeconds: number;
  lowBalanceWarningSeconds: number;
  finalWarningSeconds: number;
  idleTimeoutMs: number;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v ? n : fallback;
}

/** Reads the same tunables src/config.ts hard-codes, from wrangler vars instead of process.env. */
export function loadAppConfig(env: Env): AppConfig {
  return {
    minPricePerMinuteCents: num(env.PLATFORM_MIN_PRICE_PER_MINUTE_CENTS, 50),
    audioCostPerMinuteCents: num(env.PLATFORM_AUDIO_COST_PER_MINUTE_CENTS, 6),
    maxSessionSeconds: num(env.MAX_SESSION_SECONDS, 7200),
    lowBalanceWarningSeconds: num(env.LOW_BALANCE_WARNING_SECONDS, 120),
    finalWarningSeconds: num(env.FINAL_WARNING_SECONDS, 30),
    idleTimeoutMs: num(env.IDLE_TIMEOUT_MS, 12000),
  };
}
