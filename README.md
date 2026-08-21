# Caller

An AI that turns a content creator's own material into leads and sales —
without the creator doing the manual work.

A creator connects their content and their inbox. From there, every person
who writes in gets a reply grounded in what that creator has actually
taught, gets pointed at a real offer only when it's a genuine fit, and — if
they're a serious lead — gets invited onto a live AI phone call for real
discovery before anything is pitched. The creator watches all of it happen
from a dashboard built around what their audience is actually doing, not
internal plumbing like item counts.

Live at **`https://caller-coach.bakariw98.workers.dev`**.

## How it actually works

**Knowledge, from their real content.** A creator pastes material they
already have — transcripts, an FAQ, a newsletter, a framework — or connects
their YouTube channel and every video gets tiered, fetched, and broken into
problem-and-answer pairs in the background. Nothing is invented: if the
material doesn't cover something, it's left out rather than filled in.
(`workers/leadgen/extract.ts`, `workers/youtube/ingest.ts`)

**Every inbound email gets a grounded reply.** The creator connects Gmail;
every email that comes in is answered from that knowledge base only, in
the creator's own voice, never from general knowledge. The conversation
builds a real picture of who this person is — their situation, their real
problem, their goal, what's stopping them — turn by turn, so a returning
lead never has to re-explain themselves. (`workers/leadgen/reply.ts`,
`pipeline.ts`)

**Offers, routed on genuine fit — not label-matching.** The structured
fields a creator fills in for an offer (who it's for, when they'd
recommend it) are treated as evidence of how that creator has actually
sold it before, not eligibility rules a lead's words get checked against.
Someone who technically matches a label can still be a bad fit if their
real problem is different; someone who doesn't match it word-for-word can
still be exactly right. Email stays deliberately conservative about this —
it's one shot, with no chance to correct a misread.
(`workers/leadgen/call-prompt.ts`, `workers/leadgen/prompt.ts`)

**Serious leads get a real phone call.** Instead of a written reply, an
interested lead can get a warm invitation to call — and the call itself is
the actual sales conversation: real discovery, a diagnosis they confirm out
loud, and only then an offer that's been honestly earned.
(`workers/telephony/`, `workers/mcp/qual-tools.ts`)

**The dashboard shows what the AI actually did for the creator's
audience.** Not "142 knowledge items" — how many people wrote in, a funnel
(new leads, qualified, offers recommended, link clicks, calls accepted)
with real period-over-period deltas, a 30-day activity trend, and a
breakdown of what people are actually asking about, pulled straight from
real extracted topic tags. Every lead's full record is there too,
including the exact email transcript, verbatim. Sidebar nav on desktop,
a hamburger drawer on mobile, all behind real per-creator login — no more
shared admin key in the URL. (`workers/routes/dashboard.ts`,
`workers/leadgen/activity.ts`)

**Connect your own agent.** The same tool set the dashboard's built-in
voice assistant uses is exposed as an MCP server, so a creator can run
their whole business from Claude Desktop or their own agent instead of the
web page: read tools (the numbers, the knowledge base, the offers, the
leads, exact transcripts for one lead or everyone at once) and write tools
(edit knowledge, manage offers, update the profile, toggle voice
escalation, send a real email). Every tool is scoped to that one creator by
construction, and anything irreversible requires reading back exactly what
it's about to do and getting a real yes first.
(`workers/mcp/assistant-tools.ts`, `workers/routes/assistant.ts`)

## Honesty is the architecture, not a feature

The one idea that shows up in every piece above: nothing is ever invented.
No fabricated metric on the dashboard, no guessed price on an offer, no
email address the model wasn't actually given, no offer match that isn't
grounded in what a lead really said. Where the product doesn't know
something, it says so rather than filling the gap with something
plausible-sounding — the same standard a creator would hold themselves to
with their own audience.

## Two runtimes

- **`workers/`** — the real product, live in production. Cloudflare
  Workers, Hono, D1, Durable Objects. Everything described above lives
  here, and is what's actually deployed.
- **`src/`** — an earlier prototype for a different, now-superseded idea:
  a white-labeled coaching platform where a creator's *curriculum* became
  a phone number their *students* called when stuck. Not what's deployed,
  not under active development. Kept for reference.

## Running it

```bash
cd workers
npm install
npx wrangler dev
```

The live D1 database and secrets are already provisioned for the deployed
creator; see [docs/DEPLOY.md](docs/DEPLOY.md) for the deploy path (note:
its demo-creator walkthrough predates this product and is stale — the
webhook/secrets mechanics it describes still apply, the specific creator
it references does not).

A new creator is onboarded by the operator today, via `/onboard` — public
self-serve signup isn't built yet. Their login (email + password) is set
at that point; from there they run everything themselves from
`/dashboard/:creatorId` or their own connected agent.

```bash
npm test                          # one suite, repo root, covers workers/ and src/ both
cd workers && npx tsc --noEmit    # workers/ typecheck (its own tsconfig)
```

## What's genuinely unfinished

- **No revenue attribution.** Cost per call/conversation is tracked; there
  is no price-paid signal anywhere in the product, so no revenue number is
  ever shown — deliberately, rather than approximating one.
- **Topic tagging is lifetime-accumulated per lead, not dated per
  message** — the dashboard's "what people are asking about" is a
  reasonable approximation of "this period," not an exact one. See
  `workers/leadgen/activity.ts`'s own comment on the tradeoff.
- **Onboarding a new creator is still operator-driven**, not public
  self-serve signup.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/COST-MODEL.md](docs/COST-MODEL.md),
  [docs/XAI-API-NOTES.md](docs/XAI-API-NOTES.md) — written for the `src/`
  prototype; the underlying xAI API and cost-metering notes still apply to
  `workers/`, the product framing in them does not.
- [docs/DEPLOY.md](docs/DEPLOY.md) — the Cloudflare deploy path.
- [docs/CLOUDFLARE-PORT-NOTES.md](docs/CLOUDFLARE-PORT-NOTES.md) — what
  differs between the two runtimes and why `workers/` exists.
