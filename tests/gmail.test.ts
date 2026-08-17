import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRawMessage, listNewInboxMessages, HistoryGapError } from '../workers/email/gmail.js';

function decodeRaw(raw: string): string {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf-8');
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
    expect(decoded).toContain('Price the timeline, not the video.');
  });

  it('threads the reply with In-Reply-To and References when given the original Message-Id', () => {
    const raw = buildRawMessage({
      to: 'prospect@example.com',
      from: 'coach@gmail.com',
      fromName: 'Marcus',
      subject: 'Re: pricing',
      bodyText: 'body',
      inReplyTo: '<abc123@mail.gmail.com>',
      references: '<earlier@mail.gmail.com>',
    });
    const decoded = decodeRaw(raw);
    expect(decoded).toContain('In-Reply-To: <abc123@mail.gmail.com>');
    // References must carry the whole chain, not just the newest message, or
    // clients that thread strictly off References lose the thread.
    expect(decoded).toContain('References: <earlier@mail.gmail.com> <abc123@mail.gmail.com>');
  });

  it('omits In-Reply-To/References entirely when there is nothing to reply to', () => {
    const raw = buildRawMessage({ to: 'p@example.com', from: 'c@gmail.com', fromName: null, subject: 'Hi', bodyText: 'body' });
    const decoded = decodeRaw(raw);
    expect(decoded).not.toContain('In-Reply-To');
    expect(decoded).not.toContain('References');
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

  it('collects INBOX-labeled messagesAdded across pages and adopts the last page historyId as the new cursor', async () => {
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

  it('catches a message that reaches INBOX via a labelsAdded event, not a messageAdded one', async () => {
    // Found against a real Gmail account, not in the docs: a message that
    // lands somewhere other than INBOX first (Gmail briefly filed it as
    // spam, then reclassified it) generates a labelsAdded history entry for
    // the move, not a second messagesAdded — filtering only on messageAdded
    // silently drops it forever, since the cursor still advances past the
    // event. This is the exact shape of the real history.list response that
    // exposed the bug.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            history: [
              { messagesAdded: [{ message: { id: 'm-caught-at-delivery', labelIds: ['INBOX'] } }] },
              { labelsAdded: [{ message: { id: 'm-reclassified', labelIds: ['CATEGORY_PERSONAL', 'INBOX'] } }] },
              // A labelsAdded event for a label that isn't INBOX (e.g. just
              // STARRED) must not pull the message in.
              { labelsAdded: [{ message: { id: 'm-just-starred', labelIds: ['STARRED'] } }] },
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

  it('excludes messagesAdded not labeled INBOX (e.g. mail that landed only in Sent)', async () => {
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
    expect(result.newMessageIds).toEqual([]);
  });

  it('dedupes a message id that appears in more than one history entry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            history: [
              { messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] },
              { messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] },
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
