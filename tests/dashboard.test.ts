import { describe, expect, it } from 'vitest';
import { PAGE } from '../workers/routes/dashboard.js';

/**
 * The whole dashboard page is one JS template literal containing an inline
 * <script>. That nesting has a real trap: an escape like `\'`, written to
 * protect an apostrophe inside the *inner* script's own string literal, is
 * ALSO a valid escape for the *outer* template literal — which consumes it
 * first and emits a bare `'`. The backslash never reaches the browser, so
 * an apostrophe meant to be escaped arrives unescaped, silently breaking
 * whatever string it sits inside.
 *
 * That happened live: `wasn\'t` inside a `'...'` string terminated the
 * string mid-word, and the resulting `SyntaxError: Unexpected identifier
 * 't'` broke this ONE script block for the WHOLE page — every section
 * (overview, knowledge, offers, prospects, YouTube status), for every
 * creator, stuck on "Loading…" with no error shown anywhere server-side.
 *
 * This test parses the actual served <script> body, not a hand-copied
 * snippet, so it catches this exact class of bug before a deploy rather
 * than a creator finding a broken dashboard.
 */
describe('dashboard PAGE script', () => {
  it('is valid JavaScript', () => {
    const start = PAGE.indexOf('<script>') + '<script>'.length;
    const end = PAGE.lastIndexOf('</script>');
    expect(start).toBeGreaterThan('<script>'.length - 1);
    expect(end).toBeGreaterThan(start);
    const script = PAGE.slice(start, end);

    expect(() => new Function(script)).not.toThrow();
  });
});
