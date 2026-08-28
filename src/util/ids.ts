import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';

/** Prefixed, sortable-enough identifiers that are readable in logs. */
export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * Uses the Web Crypto API rather than node:crypto's `randomBytes(...).toString('base64url')`.
 * This file is shared between the Node build (better-sqlite3) and the
 * Cloudflare Workers build, and `Buffer`'s type resolves inconsistently
 * between the two toolchains — @cloudflare/workers-types declares the global
 * `Buffer` value as `any` for its nodejs_compat shim, which drops the
 * encoding-argument overload of `.toString()` that @types/node provides.
 * `crypto.getRandomValues` + `btoa` are standard Web APIs available
 * unmodified in both runtimes, so this sidesteps the conflict rather than
 * fighting tsconfig `types` resolution.
 */
export function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let binary = '';
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/** Constant-time compare that tolerates length mismatch without throwing. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
