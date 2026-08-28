import { describe, expect, it } from 'vitest';
import { renderTalkPage } from '../workers/routes/talk.js';

/**
 * Same trap, same fix as tests/dashboard.test.ts: the whole page is a JS
 * template literal containing an inline <script>, and a backtick inside a
 * comment or string INSIDE that script is also a valid escape/terminator
 * for the OUTER template literal — it breaks the page's script silently at
 * build time, not at the point of the bad character. Happened for real in
 * this exact file (a backtick inside a `// ...` comment describing a field
 * name broke the whole embedded script). This parses the actual rendered
 * <script> body, not a hand-copied snippet, so it catches that class of
 * bug before a deploy.
 */
describe('renderTalkPage script', () => {
  it('is valid JavaScript', () => {
    const html = renderTalkPage({
      callId: 'call_test',
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
