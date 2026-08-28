import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRawMessage, listNewInboxMessages, stripQuotedReply, HistoryGapError } from '../workers/email/gmail.js';

function decodeRaw(raw: string): string {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf-8');
}

/**
 * Splits a decoded raw message into its header block and body the way a real
 * MIME parser does: on the first blank line. Used to assert the message is
 * structurally a header section plus a body, not just that the body text
 * happens to appear somewhere in the string — `toContain` alone missed a
 * real bug where the blank separator got stripped and the body silently
 * merged into the last header, which every mail client then rendered as an
 * empty message even though the text was technically present in the bytes.
 */
function splitMessage(decoded: string): { headers: string; body: string } {
  const sep = decoded.indexOf('\r\n\r\n');
  if (sep === -1) return { headers: decoded, body: '' };
  return { headers: decoded.slice(0, sep), body: decoded.slice(sep + 4) };
}

describe('buildRawMessage', () => {
  it('includes the standard headers and body', () => {
    const raw = buildRawMessage({
      to: 'prospect@example.com',
      from: 'coach@gmail.com',
      fromName: 'Marcus',
      subject: 'Re: pricing',
      bodyText: 'Price the timeline, not the video.',
    });
    const decoded = decodeRaw(raw);
    expect(decoded).toContain('From: Marcus <coach@gmail.com>');
    expect(decoded).toContain('To: prospect@example.com');
    expect(decoded).toContain('Subject: Re: pricing');
    // Structural check, not just substring presence: the body must be
    // separated from the headers by a blank line and be exactly the body,
    // not folded into the last header. This is the exact bug a real reply
    // landing empty in a real inbox exposed — a plain toContain() on the
    // body text alone stayed green even while every message shipped empty.
    const { headers, body } = splitMessage(decoded);
    expect(headers).not.toContain('Price the timeline');
    expect(body).toBe('Price the timeline, not the video.');
  });

  it('threads the reply with In-Reply-To and References when given the original Message-Id', () => {
    const raw = buildRawMessage({
      to: 'prospect@example.com',
      from: 'coach@gmail.com',
      fromName: 'Marcus',
      subject: 'Re: pricing',
      bodyText: 'body text here',
      inReplyTo: '<abc123@mail.gmail.com>',
      references: '<earlier@mail.gmail.com>',
    });
    const decoded = decodeRaw(raw);
    expect(decoded).toContain('In-Reply-To: <abc123@mail.gmail.com>');
    // References must carry the whole chain, not just the newest message, or
    // clients that thread strictly off References lose the thread.
    expect(decoded).toContain('References: <earlier@mail.gmail.com> <abc123@mail.gmail.com>');
    // Threading headers are exactly the case that previously ate the blank
    // separator every time, since they're always present on a reply.
    expect(splitMessage(decoded).body).toBe('body text here');
  });

  it('omits In-Reply-To/References entirely when there is nothing to reply to, but still separates the body', () => {
    const raw = buildRawMessage({ to: 'p@example.com', from: 'c@gmail.com', fromName: null, subject: 'Hi', bodyText: 'body text here' });
    const decoded = decodeRaw(raw);
    expect(decoded).not.toContain('In-Reply-To');
    expect(decoded).not.toContain('References');
    expect(splitMessage(decoded).body).toBe('body text here');
  });

  it('encodes a non-ASCII subject rather than sending raw UTF-8 bytes in a header', () => {
    const raw = buildRawMessage({ to: 'p@example.com', from: 'c@gmail.com', fromName: null, subject: 'Café pricing', bodyText: 'body' });
    const decoded = decodeRaw(raw);
    expect(decoded).toMatch(/Subject: =\?UTF-8\?B\?/);
  });
});

describe('listNewInboxMessages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('collects messagesAdded ids across pages and adopts the last page historyId as the new cursor', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (!url.includes('pageToken')) {
          return new Response(
            JSON.stringify({
              history: [{ messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX', 'UNREAD'] } }] }],
              historyId: '1000',
              nextPageToken: 'p2',
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            history: [{ messagesAdded: [{ message: { id: 'm2', labelIds: ['INBOX'] } }] }],
            historyId: '1001',
          }),
          { status: 200 },
        );
      }),
    );

    const result = await listNewInboxMessages('token', '900');
    expect(result.newMessageIds.sort()).toEqual(['m1', 'm2']);
    // The cursor to persist is the LAST page's historyId, not the first —
    // storing the first page's would re-fetch (and re-answer) m2 forever.
    expect(result.latestHistoryId).toBe('1001');
    expect(calls).toHaveLength(2);
  });

  it('catches a message via labelsAdded, not just messagesAdded', async () => {
    // Found against a real Gmail account, not in the docs: a message that
    // lands somewhere other than INBOX first (Gmail briefly filed it as
    // spam, then reclassified it) generates a labelsAdded history entry for
    // the move, not a second messagesAdded.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            history: [
              { messagesAdded: [{ message: { id: 'm-caught-at-delivery', labelIds: ['INBOX'] } }] },
              { labelsAdded: [{ message: { id: 'm-reclassified', labelIds: ['CATEGORY_PERSONAL', 'INBOX'] } }] },
            ],
            historyId: '2000',
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await listNewInboxMessages('token', '1900');
    expect(result.newMessageIds.sort()).toEqual(['m-caught-at-delivery', 'm-reclassified']);
  });

  it('catches a message from a bare top-level `messages` array with no messagesAdded/labelsAdded at all', async () => {
    // Found against a real live account after the labelsAdded fix still
    // missed a message: Gmail sometimes reports a change as history.messages
    // — no categorised sub-array, no labelIds included — with no other event
    // for that message anywhere in the range. This is the exact shape that
    // left a real inbound email unanswered. Any assumption about which
    // sub-array Gmail uses is an assumption on undocumented behaviour, which
    // is why this no longer tries to enumerate shapes — see the id
    // collection logic and its comment.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            history: [{ id: '62665', messages: [{ id: 'm-bare-shape', threadId: 't1' }] }],
            historyId: '62703',
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await listNewInboxMessages('token', '62600');
    expect(result.newMessageIds).toEqual(['m-bare-shape']);
  });

  it('over-collects rather than filters by label — INBOX membership is decided by the caller from a real message fetch', async () => {
    // Deliberate design change: this function used to filter on labelIds
    // embedded inside the history response, which is exactly the field that
    // turned out to vary or be absent across shapes. A message that only
    // ever shows up as SENT here still comes back as a candidate; the poller
    // (workers/email/poll.ts) is what confirms current INBOX membership via
    // getMessage(), which is the one place that state is authoritative.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            history: [{ messagesAdded: [{ message: { id: 'sent1', labelIds: ['SENT'] } }] }],
            historyId: '1000',
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await listNewInboxMessages('token', '900');
    expect(result.newMessageIds).toEqual(['sent1']);
  });

  it('dedupes a message id that appears in more than one history entry or shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            history: [
              { messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] },
              { labelsAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] },
              { messages: [{ id: 'm1' }] },
            ],
            historyId: '1000',
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await listNewInboxMessages('token', '900');
    expect(result.newMessageIds).toEqual(['m1']);
  });

  it('throws HistoryGapError on a 404 rather than silently returning nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    await expect(listNewInboxMessages('token', 'too-old')).rejects.toBeInstanceOf(HistoryGapError);
  });
});

describe('stripQuotedReply', () => {
  it('keeps only the new content from a Gmail-style reply', () => {
    // The exact shape that broke live conversations: a 1137-character stored
    // "message" whose real content was one word, the rest being our own
    // previous reply quoted back. The model read that as the prospect's words
    // and re-answered itself three exchanges running.
    const raw = [
      'Interesting.',
      '',
      'On Tue, Aug 18, 2026 at 8:05 AM Bakari <bakariw98@gmail.com> wrote:',
      '',
      '> The fastest way to raise conversion on your content is to stop writing',
      '> from a blank page and instead do forum foraging.',
      '>',
      '> What does your typical prospect say their biggest frustration is right now?',
      '>',
    ].join('\n');
    expect(stripQuotedReply(raw)).toBe('Interesting.');
  });

  it('leaves a message with no quoted section untouched', () => {
    const raw = 'How do I price my first paid edit? I have no idea what to charge.';
    expect(stripQuotedReply(raw)).toBe(raw);
  });

  it('handles Outlook original-message separators', () => {
    const raw = 'My actual question here.\n\n-----Original Message-----\nFrom: someone\nOld text.';
    expect(stripQuotedReply(raw)).toBe('My actual question here.');
  });

  it('handles a bare quoted block with no attribution line', () => {
    expect(stripQuotedReply('New question.\n\n> old quoted line\n> more quoted')).toBe('New question.');
  });

  it('returns the original rather than nothing when the whole body looks quoted', () => {
    // Fail-safe: blanking a real message is far worse than leaving quoted
    // text in, so a strip that would empty the message is refused.
    const raw = '> everything here is quoted\n> nothing new at all';
    expect(stripQuotedReply(raw)).toBe(raw.trim());
  });

  it('does not truncate a message that merely mentions writing', () => {
    const raw = 'I wrote: a headline yesterday and it flopped. Any advice on hooks?';
    expect(stripQuotedReply(raw)).toBe(raw);
  });
});
