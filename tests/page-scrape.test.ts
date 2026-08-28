import { describe, expect, it } from 'vitest';
import { extractTitle, htmlToText, looksEmpty, normalizeOfferUrl, pickFollowUpLinks } from '../workers/leadgen/page-scrape.js';

describe('normalizeOfferUrl', () => {
  it('assumes https for the bare domain creators actually paste', () => {
    expect(normalizeOfferUrl('sandcastles.ai')).toBe('https://sandcastles.ai/');
  });

  it('keeps an explicit scheme and path', () => {
    expect(normalizeOfferUrl('http://example.com/pricing')).toBe('http://example.com/pricing');
  });

  // This field takes creator input and makes the server fetch it, so the
  // rejections matter more than the conveniences above.
  it('refuses non-http schemes', () => {
    expect(normalizeOfferUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeOfferUrl('file:///etc/passwd')).toBeNull();
  });

  it('refuses localhost and internal-only hostnames', () => {
    expect(normalizeOfferUrl('localhost:8080')).toBeNull();
    expect(normalizeOfferUrl('http://localhost/admin')).toBeNull();
    expect(normalizeOfferUrl('http://box.internal/secrets')).toBeNull();
  });

  it('refuses bare IP literals', () => {
    expect(normalizeOfferUrl('http://169.254.169.254/latest/meta-data')).toBeNull();
    expect(normalizeOfferUrl('192.168.1.1')).toBeNull();
  });

  it('refuses a hostname with no dot and blank input', () => {
    expect(normalizeOfferUrl('notadomain')).toBeNull();
    expect(normalizeOfferUrl('   ')).toBeNull();
  });
});

describe('htmlToText', () => {
  it('drops script and style content entirely', () => {
    const out = htmlToText('<p>Real copy</p><script>var secret = "do not read me";</script><style>.a{color:red}</style>');
    expect(out).toContain('Real copy');
    expect(out).not.toContain('do not read me');
    expect(out).not.toContain('color:red');
  });

  it('keeps block content on separate lines instead of running it together', () => {
    const out = htmlToText('<h1>Pro plan</h1><p>$49/month</p><p>Billed yearly</p>');
    expect(out.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['Pro plan', '$49/month', 'Billed yearly']);
  });

  it('decodes the entities that show up in real page copy', () => {
    expect(htmlToText('<p>Tom&#39;s &amp; Jane&rsquo;s &mdash; 5&nbsp;seats</p>')).toBe("Tom's & Jane's — 5 seats");
  });
});

describe('extractTitle', () => {
  it('reads and cleans the page title', () => {
    expect(extractTitle('<html><head><title>  Sandcastles &mdash; Pricing </title></head></html>')).toBe('Sandcastles — Pricing');
  });

  it('returns null when there is no title', () => {
    expect(extractTitle('<html><body>hi</body></html>')).toBeNull();
  });
});

describe('pickFollowUpLinks', () => {
  const html = `
    <a href="/pricing">See pricing</a>
    <a href="/about-us">About</a>
    <a href="/x7f2">Customer reviews</a>
    <a href="https://twitter.com/someone">Twitter</a>
    <a href="/blog/unrelated-post">A blog post</a>
    <a href="mailto:hi@example.com">Email us</a>
    <a href="/pricing">Pricing again</a>
    <a href="/">Home</a>
  `;

  it('follows only same-origin links that look informative', () => {
    const links = pickFollowUpLinks(html, 'https://example.com/', 10);
    expect(links).toContain('https://example.com/pricing');
    expect(links).toContain('https://example.com/about-us');
    expect(links).not.toContain('https://twitter.com/someone');
    expect(links).not.toContain('https://example.com/blog/unrelated-post');
  });

  // The href is opaque here — this link is only reachable via its anchor
  // text, which is exactly the "Pricing" button pattern real sites use.
  it('matches on anchor text when the path gives nothing away', () => {
    expect(pickFollowUpLinks(html, 'https://example.com/', 10)).toContain('https://example.com/x7f2');
  });

  it('dedupes repeats and never re-follows the page itself', () => {
    const links = pickFollowUpLinks(html, 'https://example.com/', 10);
    expect(links.filter((l) => l === 'https://example.com/pricing')).toHaveLength(1);
    expect(links).not.toContain('https://example.com/');
  });

  it('ranks pricing above about when the cap only allows one', () => {
    expect(pickFollowUpLinks(html, 'https://example.com/', 1)).toEqual(['https://example.com/pricing']);
  });
});

describe('looksEmpty', () => {
  it('flags a JS-shell page with almost no text', () => {
    expect(looksEmpty('<div id="root"></div>')).toBe(true);
  });

  it('accepts a page with real copy on it', () => {
    expect(looksEmpty('word '.repeat(200))).toBe(false);
  });
});
