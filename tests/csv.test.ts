import { describe, expect, it } from 'vitest';
import { toCsv } from '../workers/leadgen/csv.js';

const COLS = [
  { key: 'a', header: 'A' },
  { key: 'b', header: 'B' },
];

describe('toCsv', () => {
  it('renders a simple header and rows', () => {
    const out = toCsv([{ a: '1', b: '2' }], COLS);
    expect(out).toBe('A,B\r\n1,2');
  });

  it('quotes a field containing a comma', () => {
    const out = toCsv([{ a: 'Doing $2k, up from $500', b: '' }], COLS);
    expect(out).toContain('"Doing $2k, up from $500"');
  });

  it('doubles embedded quotes and wraps the field', () => {
    const out = toCsv([{ a: 'They said "just do it"', b: '' }], COLS);
    expect(out).toContain('"They said ""just do it"""');
  });

  it('quotes a field containing a newline', () => {
    const out = toCsv([{ a: 'Line one\nLine two', b: '' }], COLS);
    expect(out).toContain('"Line one\nLine two"');
  });

  it('round-trips real free text with a comma and a quote together', () => {
    const raw = 'I want to hit $10k/month, but I keep hearing "just run more ads"';
    const out = toCsv([{ a: raw, b: '' }], COLS);
    const expectedCell = '"' + raw.replace(/"/g, '""') + '"';
    expect(out).toBe(`A,B\r\n${expectedCell},`);
    // Unquoting it the way a real CSV parser would must recover the exact
    // original text — proof this is a valid round trip, not just "contains
    // a quote somewhere".
    expect(expectedCell.slice(1, -1).replace(/""/g, '"')).toBe(raw);
  });

  it.each(['=SUM(A1:A2)', '+1+1', '-2+3', '@SUM(1,2)'])(
    'neutralises formula-injection prefix %s with a leading apostrophe',
    (formula) => {
      const out = toCsv([{ a: formula, b: '' }], COLS);
      const dataLine = out.split('\r\n')[1]!;
      // The literal executable prefix must not be the first character of
      // the cell content any more — Excel/Sheets treat a leading apostrophe
      // as "this cell is text", never rendering the mark itself.
      const cellContent = dataLine.startsWith('"') ? dataLine.slice(1) : dataLine;
      expect(cellContent.startsWith("'" + formula[0])).toBe(true);
    },
  );

  it('does not touch a field that merely contains one of those characters mid-string', () => {
    // Only a LEADING = / + / - / @ is dangerous; a hyphen in normal prose
    // must not be mangled.
    const out = toCsv([{ a: 'Doing $2k-3k a month, pre-tax', b: '' }], COLS);
    expect(out).toContain('Doing $2k-3k a month');
    expect(out).not.toContain("'Doing");
  });

  it('renders null and undefined as empty cells', () => {
    const out = toCsv([{ a: null, b: undefined }], COLS);
    expect(out).toBe('A,B\r\n,');
  });

  it('renders numbers and booleans as plain text', () => {
    const out = toCsv([{ a: 42, b: true }], COLS);
    expect(out).toBe('A,B\r\n42,true');
  });

  it('handles an empty row set — header only', () => {
    expect(toCsv([], COLS)).toBe('A,B');
  });
});
