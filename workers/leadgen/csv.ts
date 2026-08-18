/**
 * CSV export for the lead database.
 *
 * A lead database the creator cannot pull into their own CRM or email tool
 * is really just a web page — this is what makes it their data.
 *
 * Pure and exported so escaping is unit-testable independent of the route
 * and the D1 row shape it happens to be built from.
 *
 * Two things this has to get right, both because the values being encoded
 * are free text written by cold strangers emailing in — not app-generated
 * data with a known, trusted shape:
 *
 *  - RFC 4180 quoting: a field containing a comma, a double quote, or a
 *    newline must be wrapped in quotes, with internal quotes doubled.
 *  - Formula injection: a field beginning with =, +, - or @ is EXECUTED by
 *    Excel and Sheets the moment the file is opened, not just displayed as
 *    text. Since this content is written by a prospect the creator has
 *    never vetted, that is a live path from an untrusted author straight to
 *    code running on the creator's machine. Neutralised with a leading
 *    apostrophe, which every spreadsheet app treats as "the rest of this
 *    cell is literal text" and never renders in the cell itself.
 */

const FORMULA_PREFIXES = ['=', '+', '-', '@'];

function escapeCell(raw: unknown): string {
  let s = raw === null || raw === undefined ? '' : String(raw);
  if (FORMULA_PREFIXES.some((p) => s.startsWith(p))) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export interface CsvColumn {
  key: string;
  header: string;
}

/** \r\n line endings — the RFC 4180 default, and what every spreadsheet app expects without guessing. */
export function toCsv(rows: Record<string, unknown>[], columns: CsvColumn[]): string {
  const lines = [columns.map((c) => escapeCell(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(row[c.key])).join(','));
  }
  return lines.join('\r\n');
}
