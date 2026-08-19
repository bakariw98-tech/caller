import { describe, expect, it } from 'vitest';
import { renderAssistantPage } from '../workers/routes/assistant.js';

/**
 * Same trap, same fix as tests/talk.test.ts and tests/dashboard.test.ts:
 * a backtick inside a comment or string INSIDE the embedded <script>
 * breaks the OUTER TS template literal silently. Parses the actual
 * rendered <script> body rather than a hand-copied snippet.
 */
describe('renderAssistantPage script', () => {
  it('is valid JavaScript', () => {
    const html = renderAssistantPage({
      creatorId: 'creator_test',
      token: 'tok_test',
      realtimeBase: 'wss://api.x.ai/v1/realtime',
      model: 'grok-voice-latest',
      ephemeralSecret: 'xai-realtime-client-secret-test',
      sessionUpdate: { type: 'session.update', session: {} },
      seedItem: { type: 'conversation.item.create', item: {} },
      responseCreate: { type: 'response.create' },
      businessName: "O'Brien's Test Co",
    });

    const start = html.indexOf('<script>') + '<script>'.length;
    const end = html.lastIndexOf('</script>');
    expect(start).toBeGreaterThan('<script>'.length - 1);
    expect(end).toBeGreaterThan(start);
    const script = html.slice(start, end);

    expect(() => new Function(script)).not.toThrow();
  });
});
