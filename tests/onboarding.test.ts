import { describe, expect, it } from 'vitest';
import { PAGE } from '../workers/routes/onboarding.js';

/**
 * Same trap, same fix as tests/dashboard.test.ts / tests/talk.test.ts /
 * tests/assistant.test.ts — the whole page is a JS template literal
 * containing an inline <script>, and a stray backtick or unescaped
 * character inside it breaks the OUTER template literal silently. Parses
 * the actual rendered <script> body rather than a hand-copied snippet.
 */
describe('onboarding PAGE script', () => {
  it('is valid JavaScript', () => {
    const start = PAGE.indexOf('<script>') + '<script>'.length;
    const end = PAGE.lastIndexOf('</script>');
    expect(start).toBeGreaterThan('<script>'.length - 1);
    expect(end).toBeGreaterThan(start);
    const script = PAGE.slice(start, end);

    expect(() => new Function(script)).not.toThrow();
  });
});
