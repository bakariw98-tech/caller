import { createHash, randomInt } from 'node:crypto';
import type { DB } from '../db/index.js';
import { id, now, safeEqual } from '../util/ids.js';
import type { Creator, Customer } from '../domain/types.js';
import { getSmsProvider } from './sms.js';

const CODE_TTL_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 30;

function hashCode(code: string, phone: string): string {
  return createHash('sha256').update(`${phone}:${code}`).digest('hex');
}

export class OtpError extends Error {
  constructor(
    message: string,
    readonly code: 'cooldown' | 'expired' | 'too_many_attempts' | 'invalid' | 'not_found',
  ) {
    super(message);
    this.name = 'OtpError';
  }
}

/**
 * Sends a verification code to a phone number.
 *
 * This is the only way a number becomes linked to an account. Caller ID alone
 * identifies; it never verifies — a spoofed number must not be able to reach
 * somebody else's progress or credits.
 */
export async function startVerification(
  db: DB,
  params: { creatorId: string; phoneE164: string },
): Promise<{ challengeId: string }> {
  const recent = db
    .prepare(
      `SELECT created_at FROM otp_challenges
        WHERE creator_id = ? AND phone_e164 = ? AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(params.creatorId, params.phoneE164) as { created_at: number } | undefined;

  if (recent && now() - recent.created_at < RESEND_COOLDOWN_SECONDS) {
    throw new OtpError('A code was just sent. Wait a moment before asking for another.', 'cooldown');
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const challengeId = id('otp');

  db.prepare(
    `INSERT INTO otp_challenges (id, creator_id, phone_e164, code_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    challengeId,
    params.creatorId,
    params.phoneE164,
    hashCode(code, params.phoneE164),
    now() + CODE_TTL_SECONDS,
    now(),
  );

  const creator = db.prepare('SELECT * FROM creators WHERE id = ?').get(params.creatorId) as
    | Creator
    | undefined;

  // The message is the creator's, not the platform's.
  await getSmsProvider().send(
    params.phoneE164,
    `${code} is your verification code for ${creator?.business_name ?? 'your coach'}.`,
  );

  return { challengeId };
}

/** Verifies a code and links the number to a customer account. */
export function confirmVerification(
  db: DB,
  params: { creatorId: string; phoneE164: string; code: string; name?: string },
): Customer {
  const challenge = db
    .prepare(
      `SELECT * FROM otp_challenges
        WHERE creator_id = ? AND phone_e164 = ? AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(params.creatorId, params.phoneE164) as
    | { id: string; code_hash: string; expires_at: number; attempts: number }
    | undefined;

  if (!challenge) throw new OtpError('No verification in progress for this number.', 'not_found');
  if (challenge.expires_at < now()) throw new OtpError('That code has expired.', 'expired');
  if (challenge.attempts >= MAX_ATTEMPTS) {
    throw new OtpError('Too many attempts. Request a new code.', 'too_many_attempts');
  }

  db.prepare('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?').run(challenge.id);

  if (!safeEqual(challenge.code_hash, hashCode(params.code.trim(), params.phoneE164))) {
    throw new OtpError('That code is not right.', 'invalid');
  }

  db.prepare('UPDATE otp_challenges SET consumed_at = ? WHERE id = ?').run(now(), challenge.id);

  const existing = db
    .prepare('SELECT * FROM customers WHERE creator_id = ? AND phone_e164 = ?')
    .get(params.creatorId, params.phoneE164) as Customer | undefined;

  if (existing) {
    db.prepare('UPDATE customers SET verified_at = ?, name = COALESCE(?, name) WHERE id = ?').run(
      now(),
      params.name ?? null,
      existing.id,
    );
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(existing.id) as Customer;
  }

  const customerId = id('cust');
  db.prepare(
    `INSERT INTO customers (id, creator_id, name, phone_e164, verified_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(customerId, params.creatorId, params.name ?? null, params.phoneE164, now(), now());

  return db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as Customer;
}
