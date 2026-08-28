/**
 * Reads an offer's own public sales page — the thing a prospect would
 * actually land on — so the offer draft is built from BOTH sides of the
 * truth: how the creator sells it out loud (their video transcripts) and
 * what the page itself actually states (what is included, what it costs,
 * what reviewers say).
 *
 * Deliberately plain `fetch` + HTML-to-text rather than a paid scraping
 * API: a Worker's outbound fetch has no CORS restriction and no browser
 * to boot, so a server-rendered marketing page — which is most of them,
 * since they are built to be indexed by search engines — comes back
 * complete for free. For the case that genuinely defeats that (a
 * client-rendered SPA whose HTML is an empty shell), there is one
 * documented fallback below. Nothing here is trusted as fact on its own:
 * everything scraped goes into the same extraction pass that already
 * refuses to state anything not grounded in the material, and the
 * creator reviews the draft before it is ever saved.
 */

/** A single page that was successfully read. */
export interface ScrapedPage {
  url: string;
  title: string | null;
  text: string;
}

export interface ScrapeResult {
  pages: ScrapedPage[];
  /** Human-readable reasons individual pages failed, for the creator's status line. */
  errors: string[];
}

/** Per-page text cap. Enough for a long sales page; short of blowing the prompt budget. */
const MAX_TEXT_PER_PAGE = 14000;
/** The landing page plus a handful of its most informative neighbours. */
const MAX_PAGES = 6;
const FETCH_TIMEOUT_MS = 12000;

/**
 * A real browser's UA. Some marketing hosts return a challenge page or a
 * 403 to an unrecognised agent, which would otherwise look to the
 * creator like "your page has nothing on it" rather than "we were turned
 * away" — a confusing failure to debug from a dashboard status line.
 */
const UA = 'Mozilla/5.0 (compatible; OfferReader/1.0; +https://caller-coach.bakariw98.workers.dev)';

/**
 * Normalizes what a creator actually types into a fetchable https URL,
 * or null when it is not something we should be requesting at all.
 *
 * Creators paste bare domains constantly ("sandcastles.ai"), so a
 * missing scheme is assumed to be https rather than rejected. The
 * rejections are the security-relevant half: this takes a URL from a
 * dashboard field and makes the server request it, so anything that is
 * not public http(s) — other schemes, localhost, raw IP literals,
 * internal-only hostnames — is refused rather than fetched. Cloudflare
 * Workers cannot reach a private network from the edge anyway, but the
 * check belongs at the input, not in an assumption about the runtime.
 */
export function normalizeOfferUrl(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  // Any bare IP literal — there is no legitimate reason a creator's
  // public sales page is addressed by one, and allowing them is how a
  // URL field becomes a way to probe private address space.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return null;
  if (!host.includes('.')) return null;

  return u.toString();
}

/** Decodes the handful of HTML entities that actually show up in page copy. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/**
 * Flattens page HTML to the text a reader would actually see.
 *
 * Script/style/noscript/svg content is dropped entirely — on a modern
 * marketing page the inlined JSON state blob is frequently larger than
 * the copy, and feeding it to the model is both expensive and a source
 * of confidently-wrong detail. Block-level tags become newlines so
 * pricing tables and testimonial cards do not run together into one
 * unreadable line.
 */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|iframe|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(br|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|td|th|header|footer|nav)>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v ]+/g, ' ');
  s = s.replace(/ ?\n ?/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const t = decodeEntities(m[1]!).replace(/\s+/g, ' ').trim();
  return t || null;
}

/**
 * The words that mark a link as worth following. An offer's landing page
 * is a pitch; what it costs, what buyers actually said, and what is
 * really included usually live one click away. These are the pages a
 * person evaluating the offer would open themselves.
 */
const INTERESTING = [
  'pricing', 'price', 'plans', 'plan', 'buy', 'checkout', 'subscribe', 'upgrade',
  'review', 'reviews', 'testimonial', 'testimonials', 'case-stud', 'case-study', 'results',
  'faq', 'faqs', 'features', 'how-it-works', 'what-you-get', 'curriculum', 'syllabus',
  'about', 'product', 'course', 'program', 'membership',
];

/**
 * Picks same-origin links worth reading alongside the landing page,
 * best-first, deduped and capped.
 *
 * Same-origin only, on purpose: following outbound links would wander
 * off into a payment processor, a social profile, or an unrelated
 * partner site and start feeding the extraction facts that are not
 * about this offer at all. Both the href and the anchor text are
 * checked, since plenty of "Pricing" buttons point at an opaque path.
 */
export function pickFollowUpLinks(html: string, baseUrl: string, limit: number): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const scored = new Map<string, number>();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1]!;
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;

    let target: URL;
    try {
      target = new URL(href, base);
    } catch {
      continue;
    }
    if (target.origin !== base.origin) continue;
    if (target.protocol !== 'http:' && target.protocol !== 'https:') continue;

    target.hash = '';
    const url = target.toString();
    if (url === baseUrl || url === `${baseUrl}/`) continue;
    // A path with no distinguishing segment is the home page again.
    if (!target.pathname || target.pathname === '/') continue;

    const anchorText = htmlToText(m[2]!).toLowerCase();
    const haystack = `${target.pathname.toLowerCase()} ${anchorText}`;
    // Earlier entries in INTERESTING are the more valuable pages, so a
    // hit's rank doubles as its score — pricing beats "about" when the
    // cap only leaves room for one.
    const idx = INTERESTING.findIndex((w) => haystack.includes(w));
    if (idx === -1) continue;

    const score = INTERESTING.length - idx;
    if ((scored.get(url) ?? 0) < score) scored.set(url, score);
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([url]) => url);
}

/** True when a fetched page yielded so little text it is almost certainly a JS-rendered shell. */
export function looksEmpty(text: string): boolean {
  return text.replace(/\s+/g, ' ').trim().length < 400;
}

async function fetchPage(url: string): Promise<{ html: string } | { error: string }> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `${url} returned ${res.status}` };
    const type = res.headers.get('content-type') ?? '';
    if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) {
      return { error: `${url} is not a web page (${type.split(';')[0]})` };
    }
    return { html: await res.text() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `${url} could not be reached (${msg})` };
  }
}

/**
 * The one fallback for a client-rendered page whose served HTML is an
 * empty shell. r.jina.ai is a public reader that renders a page and
 * returns its text; it needs no key for this volume, and a failure here
 * is never fatal — the extraction simply proceeds on transcripts and
 * whatever the direct fetch did return. Kept as a narrow second attempt
 * rather than the primary path so the common case stays a single
 * first-party request with no third party in it at all.
 */
async function fetchViaReader(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text.length > 200 ? text.slice(0, MAX_TEXT_PER_PAGE) : null;
  } catch {
    return null;
  }
}

/**
 * Reads the offer's landing page and its most informative neighbours.
 *
 * Never throws: a page that is down, slow, or hostile to scraping is a
 * degraded result (fewer sources, an explanatory error string the
 * creator sees), never a failed offer lookup — the transcripts on their
 * own were the entire input until now and still work fine alone.
 */
export async function scrapeOfferSite(rawUrl: string): Promise<ScrapeResult> {
  const url = normalizeOfferUrl(rawUrl);
  if (!url) return { pages: [], errors: ['That link does not look like a public web address.'] };

  const errors: string[] = [];
  const root = await fetchPage(url);
  if ('error' in root) return { pages: [], errors: [root.error] };

  const pages: ScrapedPage[] = [];
  let rootText = htmlToText(root.html);
  if (looksEmpty(rootText)) {
    const rendered = await fetchViaReader(url);
    if (rendered) rootText = rendered;
    else errors.push('That page renders its content in the browser, so only part of it could be read.');
  }
  pages.push({ url, title: extractTitle(root.html), text: rootText.slice(0, MAX_TEXT_PER_PAGE) });

  const followUps = pickFollowUpLinks(root.html, url, MAX_PAGES - 1);
  const results = await Promise.all(followUps.map((link) => fetchPage(link).then((r) => [link, r] as const)));
  for (const [link, r] of results) {
    if ('error' in r) {
      errors.push(r.error);
      continue;
    }
    const text = htmlToText(r.html);
    if (looksEmpty(text)) continue;
    pages.push({ url: link, title: extractTitle(r.html), text: text.slice(0, MAX_TEXT_PER_PAGE) });
  }

  return { pages, errors };
}
