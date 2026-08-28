import { describe, expect, it } from 'vitest';
import { AUTOMATED_SENDER_PATTERN } from '../workers/email/poll.js';

describe('AUTOMATED_SENDER_PATTERN', () => {
  it('matches every automated sender observed live answering as if it were a lead', () => {
    // Real senders the poller answered before this filter existed — a
    // mailer-daemon bounce, a Reddit notification, an Instacart promo, an
    // Indeed job alert, and a Google security notice — none of them a
    // prospect, all of them burning real xAI cost on a reply nobody reads.
    const observed = [
      'mailer-daemon@googlemail.com',
      'noreply@redditmail.com',
      'no-reply@customers.instacartemail.com',
      'donotreply@match.indeed.com',
      'no-reply@accounts.google.com',
    ];
    for (const addr of observed) expect(AUTOMATED_SENDER_PATTERN.test(addr)).toBe(true);
  });

  it('matches common spelling variants of the same convention', () => {
    for (const addr of ['no-reply@example.com', 'noreply@example.com', 'do-not-reply@example.com', 'donotreply@example.com', 'postmaster@example.com']) {
      expect(AUTOMATED_SENDER_PATTERN.test(addr)).toBe(true);
    }
  });

  it('does not match a real person, even one whose name or domain contains similar substrings', () => {
    for (const addr of [
      'jayone1265@gmail.com',
      'nikebakariw@gmail.com',
      // Must anchor to the start of the local part, not match "noreply"
      // appearing anywhere in the address.
      'noreplyguy@gmail.com',
      'reply@example.com',
    ]) {
      expect(AUTOMATED_SENDER_PATTERN.test(addr)).toBe(false);
    }
  });
});
