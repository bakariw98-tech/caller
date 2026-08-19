import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Manual hex encode/decode rather than Buffer#toString('hex')/Buffer.from(hex,'hex') —
 * @cloudflare/workers-types shims Buffer's type as `any` and drops the
 * encoding-argument overloads (same issue documented on randomToken() in
 * src/util/ids.ts), so those calls fail to typecheck here even though they
 * would work at runtime under nodejs_compat.
 */
function toHex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex: string): Buffer {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) throw new Error('invalid hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return Buffer.from(bytes);
}

/**
 * The first real password hasher in this codebase. `hashCode` in
 * src/identity/otp.ts is plain unsalted SHA-256 over `phone:code` — fine
 * for a 6-digit OTP that expires in minutes and is rate-limited, not
 * adequate for a password someone reuses for months.
 *
 * PBKDF2-SHA256 via node:crypto rather than a new dependency: this repo
 * already runs with `nodejs_compat` (wrangler.toml) and already uses
 * node:crypto for hmacHex/safeEqual in src/util/ids.ts, so this is the
 * same trusted primitive, not a new one.
 *
 * 100,000 iterations, not OWASP's higher current recommendation — found
 * live, not guessed: Workers' nodejs_compat pbkdf2Sync shim hard-rejects
 * any iteration count above 100,000 ("iteration counts above 100000 are
 * not supported"), a real platform ceiling this passed local `vitest`
 * (plain Node, no such cap) without ever hitting. Still a real,
 * meaningfully expensive cost for an attacker with a stolen hash — the
 * iteration count is stored per-hash (see hashPassword's return format)
 * specifically so this ceiling lifting later doesn't invalidate every
 * password already on file.
 */
const ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const DIGEST = 'sha256';

/**
 * Returns one self-contained string — `pbkdf2:<iterations>:<saltHex>:<hashHex>`
 * — so a future iteration-count bump doesn't invalidate every password
 * already on file; verifyPassword() reads the count back out rather than
 * assuming today's constant.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
  return `pbkdf2:${ITERATIONS}:${toHex(salt)}:${toHex(hash)}`;
}

/**
 * Never throws on a malformed stored value (a creator with no password
 * set yet, or a hand-edited DB row) — treats it as a non-match rather than
 * a 500, since this sits directly on the login path.
 */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = fromHex(parts[2]!);
    expected = fromHex(parts[3]!);
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = pbkdf2Sync(password, salt, iterations, expected.length, DIGEST);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
