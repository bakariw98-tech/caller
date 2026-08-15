import 'dotenv/config';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Env ${name} must be numeric, got: ${raw}`);
  return parsed;
}

export const config = {
  xai: {
    apiKey: process.env.XAI_API_KEY ?? '',
    apiBase: process.env.XAI_API_BASE ?? 'https://api.x.ai',
    realtimeUrl: process.env.XAI_REALTIME_URL ?? 'wss://api.x.ai/v1/realtime',
    voiceModel: process.env.XAI_VOICE_MODEL ?? 'grok-voice-latest',
    webhookSigningSecret: process.env.XAI_WEBHOOK_SIGNING_SECRET ?? '',
  },
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
  port: num('PORT', 3000),
  mcp: {
    tokenSecret: process.env.MCP_TOKEN_SECRET ?? 'dev-insecure-secret',
    // Tokens outlive the session cap so a long call can never lose its tools.
    tokenTtlSeconds: num('MCP_TOKEN_TTL_SECONDS', 8000),
  },
  sms: {
    provider: (process.env.SMS_PROVIDER ?? 'console') as 'console' | 'twilio',
    from: process.env.SMS_FROM ?? '',
    apiKey: process.env.SMS_API_KEY ?? '',
    accountSid: process.env.SMS_ACCOUNT_SID ?? '',
  },
  economics: {
    minPricePerMinuteCents: num('PLATFORM_MIN_PRICE_PER_MINUTE_CENTS', 50),
    audioCostPerMinuteCents: num('PLATFORM_AUDIO_COST_PER_MINUTE_CENTS', 6),
  },
  call: {
    maxSessionSeconds: num('MAX_SESSION_SECONDS', 7200),
    lowBalanceWarningSeconds: num('LOW_BALANCE_WARNING_SECONDS', 120),
    finalWarningSeconds: num('FINAL_WARNING_SECONDS', 30),
    idleTimeoutMs: num('IDLE_TIMEOUT_MS', 12000),
  },
  databasePath: process.env.DATABASE_PATH ?? './data/caller.db',
  env: process.env.NODE_ENV ?? 'development',
  // Guards the creator-facing console. v1 onboards one creator by hand, so a
  // shared token is enough; real accounts arrive with multi-creator self-serve.
  adminToken: process.env.ADMIN_TOKEN ?? '',
} as const;

/** Fail fast on the values that must be real before answering a live call. */
export function assertLiveConfig(): void {
  req('XAI_API_KEY', config.xai.apiKey || undefined);
  if (config.mcp.tokenSecret === 'dev-insecure-secret') {
    throw new Error('MCP_TOKEN_SECRET must be set to a real secret outside development');
  }
  if (!config.publicBaseUrl.startsWith('https://')) {
    throw new Error('PUBLIC_BASE_URL must be an https URL reachable by xAI');
  }
}
