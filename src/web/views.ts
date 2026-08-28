import type { Creator } from '../domain/types.js';

export interface Brand {
  primary: string;
  accent: string;
  logoUrl?: string;
}

export function brandOf(creator: Creator): Brand {
  try {
    const parsed = JSON.parse(creator.brand_json) as Partial<Brand>;
    return {
      primary: parsed.primary ?? '#1f2933',
      accent: parsed.accent ?? '#2f6f4e',
      logoUrl: parsed.logoUrl,
    };
  } catch {
    return { primary: '#1f2933', accent: '#2f6f4e' };
  }
}

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Customer-facing shell.
 *
 * Everything visible belongs to the creator: their name in the title, their
 * colours, their words. The platform's name appears nowhere on this page, and
 * neither does any hint of what runs underneath it.
 */
export function customerPage(params: {
  creator: Creator;
  title: string;
  body: string;
}): string {
  const brand = brandOf(params.creator);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(params.title)} — ${esc(params.creator.business_name)}</title>
<style>
  :root { --primary: ${esc(brand.primary)}; --accent: ${esc(brand.accent)}; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem; background: #fbfaf8; color: var(--primary);
    font: 16px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.75rem; line-height: 1.2; margin: 0 0 .5rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
  p { margin: .5rem 0 1rem; }
  .card { background: #fff; border: 1px solid #e7e3dd; border-radius: 12px; padding: 1.5rem; margin: 1.25rem 0; }
  .number { font-size: 1.6rem; font-weight: 600; letter-spacing: .02em; color: var(--accent); }
  label { display: block; font-weight: 600; margin: 1rem 0 .25rem; font-size: .95rem; }
  input {
    width: 100%; padding: .7rem .8rem; font-size: 1rem; border: 1px solid #d6d1c8;
    border-radius: 8px; background: #fff; color: inherit;
  }
  button {
    margin-top: 1.25rem; width: 100%; padding: .8rem 1rem; font-size: 1rem; font-weight: 600;
    color: #fff; background: var(--accent); border: 0; border-radius: 8px; cursor: pointer;
  }
  .muted { color: #6b6459; font-size: .9rem; }
  .error { background: #fdf0ee; border-color: #e9c4bd; color: #8a3527; }
  .logo { max-height: 48px; margin-bottom: 1.25rem; }
</style>
</head>
<body>
  <div class="wrap">
    ${brand.logoUrl ? `<img class="logo" src="${esc(brand.logoUrl)}" alt="${esc(params.creator.business_name)}">` : ''}
    ${params.body}
  </div>
</body>
</html>`;
}

/** Operator-facing shell. The creator sees this one; their customers never do. */
export function dashboardPage(params: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(params.title)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.5rem; background: #f7f7f8; color: #1a1a1c;
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 60rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 1.5rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .75rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .85rem; }
  .stat { background: #fff; border: 1px solid #e5e5e7; border-radius: 10px; padding: 1rem; }
  .stat .k { font-size: .8rem; color: #6d6d72; text-transform: uppercase; letter-spacing: .04em; }
  .stat .v { font-size: 1.5rem; font-weight: 650; margin-top: .3rem; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e5e7; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: .65rem .8rem; border-bottom: 1px solid #eeeef0; font-size: .92rem; }
  th { background: #fafafa; font-weight: 600; }
  tr:last-child td { border-bottom: 0; }
  .insight { background: #fff; border-left: 3px solid #2f6f4e; padding: .8rem 1rem; margin: .5rem 0; border-radius: 0 8px 8px 0; }
  .muted { color: #6d6d72; }
</style>
</head>
<body><div class="wrap">${params.body}</div></body>
</html>`;
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
