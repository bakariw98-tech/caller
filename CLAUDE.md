# Orientation for any agent working in this repo

Read this first. It's the fast path to not re-deriving what's already
known, and not repeating mistakes already made and fixed once.

## What this is

An AI that turns a content creator's own material into leads and sales.
A creator connects their content and their inbox; every person who
writes in gets a reply grounded in what that creator actually teaches,
gets pointed at a real offer only on genuine fit, and a serious lead can
get escalated to a live AI phone call for real discovery before anything
is pitched. The creator runs all of it from a dashboard — or from their
own connected agent over MCP. See [README.md](README.md) for the full
plain-language pitch; this file is about orienting an agent in the code,
not selling the product.

Live at **`https://caller-coach.bakariw98.workers.dev`**.

## Two products, one Worker — the thing to not get confused about

`workers/` is a single Cloudflare Worker that contains **two products**
sharing call infrastructure, at very different levels of activity:

- **The lead-gen product — this is the live one, and everything built
  this session.** `leadgen/`, `youtube/`, `email/`, `assistant/`, `auth/`
  (per-creator login, new). This is what `/dashboard/:creatorId` is,
  what the MCP "connect your own agent" surface is, what a `'qualify'`-
  purpose phone number does.
- **The original per-minute coaching-call product — present, dormant,
  not what you're here to work on unless told otherwise.** `coach/`,
  `curriculum/`, `state/`, `identity/`, `billing/`. Routed by
  `phone_numbers.purpose === 'coach'` in
  `workers/telephony/call-router.ts`. This was the repo's original
  premise (a creator's *curriculum* becomes a phone number *students*
  call) before it pivoted to the lead-gen product above. Still real,
  still wired up, not actively developed.
- **Shared infrastructure both call kinds run through.** `mcp/` (three
  separate tool sets — coach, qualify, assistant — dispatched by session
  kind, see `workers/routes/mcp.ts`'s `toolDefinitionsForKind`),
  `telephony/`, `durable-objects/` (one `CallSessionDO` per live call,
  either kind), `xai/` (the realtime Voice API client), `db/` (the D1
  adapter), `routes/` (all Hono routing).

`src/` (Node/Fastify/better-sqlite3) is the original, now-superseded
prototype of the coaching-call product — not deployed, not developed.
See [docs/CLOUDFLARE-PORT-NOTES.md](docs/CLOUDFLARE-PORT-NOTES.md) for
why `workers/` exists as its own runtime.

## Where to actually start reading

- `workers/routes/dashboard.ts` — the entire creator-facing surface: one
  page, sidebar nav, every panel (Overview, Leads, Offers, Content,
  Voice escalation, Connect agent, Settings).
- `workers/leadgen/pipeline.ts` — the email brain: inbound message in,
  retrieval, reply generation, signals extraction, out.
- `workers/mcp/assistant-tools.ts` — the complete tool surface a
  creator's own connected agent (or the dashboard's built-in voice
  assistant) can call. Read the tool descriptions; they carry the real
  behavioral rules, not just a schema.
- `workers/leadgen/activity.ts` — the dashboard Overview's real numbers:
  hero metric, funnel with period-over-period deltas, 30-day trend,
  topic breakdown. Nothing on that panel is synthesized; this is where
  each number actually comes from.

## Patterns and traps worth knowing before touching code

**Honesty is a hard constraint, not a preference.** Every tool, every
prompt in this product is built so the model can never invent a fact —
no fabricated metric, no guessed price, no address it wasn't given, no
offer match that isn't real. `email_prospect` and `get_prospect_transcript`
resolve by `prospect_id` only, schema has no address-shaped field at
all — that's not a description, it's `additionalProperties: false`
enforcing it. Any new tool or prompt has to hold this same line; see
`tests/assistant-tools.test.ts`'s schema-level checks for the pattern.

**Offer fit is evidence to reason from, never a label to match.**
Structured offer fields (`who_for`, `recommend_when`, etc.) describe a
creator's *pattern* — how they've actually sold something before — not
eligibility rules a lead's words get mechanically checked against.
Someone who technically matches a label can be a bad fit; someone who
doesn't match it word-for-word can be exactly right. This was a real
architectural correction mid-session (the product used to present these
fields as imperative rules, which made the model reason like it was
checking a rulebook) — see `workers/leadgen/call-prompt.ts`'s
`describeOfferForFit()` and `workers/leadgen/prompt.ts`'s "REASON TWO"
for the corrected framing and its own doc comments on why. Don't
reintroduce rule-labeled phrasing in a new prompt.

**A stray backtick breaks the whole page, silently.** Several routes
(`dashboard.ts`, `login.ts`, `onboarding.ts`, `assistant.ts`) embed a
full `<script>` inside a TS backtick template literal. A backtick, or a
`\'` escape meant for the *inner* script's string, gets consumed by the
*outer* template first — this has actually broken a live page before
(a `wasn\'t` silently truncated the whole embedded script, page stuck on
"Loading…" with no server-side error at all). `tests/dashboard.test.ts`
parses the real served `<script>` with `new Function()` specifically to
catch this before deploy — keep that pattern for any new page like this,
and never use a backtick anywhere inside one of these templates.

**Hono middleware registered in one file can intercept another file's
routes.** `app.route('/', subApp)` for several sub-apps mounted at the
same base path means every `.use()` across ALL of them gets matched
purely by path pattern against the whole composed app — not scoped to
"only this file's own routes" the way it looks. This bit a real
production auth bug (`admin.ts`'s blanket `/api/*` admin-token check
silently intercepting `leadgen.ts`'s own, more permissive routes). Scope
middleware explicitly to its own routes — see `admin.ts`'s
`ADMIN_ROUTE_PATTERNS` and `leadgen.ts`'s `creatorIdFromPath()` for the
fix pattern. Also: `c.req.param('id')` is NOT populated inside a
wildcard `.use()` middleware, only inside the actually-matched final
route handler — extract path segments manually there instead.

**Mint a token, store only its HMAC, resolve by rehashing.** Used for
four separate credential families, each with its own secret so one
family's compromise can't forge another: `mcp_sessions` (coach calls),
`mcp_qual_sessions` (qualification calls), `mcp_assistant_sessions`
(the assistant/MCP surface), `creator_sessions` (dashboard login). See
`workers/auth/session.ts` for the cleanest example.

**MCP tool annotations matter, and this server didn't set them until
recently.** `readOnlyHint` / `destructiveHint` / `idempotentHint` /
`openWorldHint` (MCP spec 2025-06-18, the protocol version this server
declares) are the only structured signal a connecting client's own
safety layer has beyond free-text description parsing. Every tool in
`workers/mcp/tools.ts`'s three definition sets should set them
accurately — see `ToolAnnotations` there, and
`workers/mcp/assistant-tools.ts` for the full-coverage example.

**PBKDF2 iteration count is capped at 100,000 on Workers, silently,
until you hit it.** `node:crypto`'s `pbkdf2Sync` shim under
`nodejs_compat` throws above that — not documented, not reproducible in
local `vitest` (plain Node, no cap). See `workers/auth/password.ts`.

## Commands

```bash
cd workers && npx wrangler dev      # local dev against the real D1 binding
npm test                            # from repo root — one suite, covers workers/ and src/ both
cd workers && npx tsc --noEmit      # workers/ typecheck (own tsconfig)
cd workers && npx wrangler deploy   # ship it (needs CLOUDFLARE_API_TOKEN)
```

## Deeper docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the three real request
  flows (email pipeline, voice-escalation call, dashboard/MCP surface)
  and the module map above in full.
- [docs/DEPLOY.md](docs/DEPLOY.md) — the deploy path; current-product
  setup (login, dashboard, MCP connector) is up top, the original
  coaching-product's setup is in its own clearly marked section near the
  bottom.
- [docs/XAI-API-NOTES.md](docs/XAI-API-NOTES.md) — verified realtime
  Voice API behavior, applies to both call purposes.
- [docs/CLOUDFLARE-PORT-NOTES.md](docs/CLOUDFLARE-PORT-NOTES.md) — why
  this runtime uses Hono/D1/Durable Objects.
- [docs/BILLING.md](docs/BILLING.md), [docs/COST-MODEL.md](docs/COST-MODEL.md)
  — the *original* coaching product's per-minute retail billing and
  margin model. Scoped to the dormant `'coach'`-purpose call path; the
  lead-gen product has no comparable retail billing (see README's "What's
  genuinely unfinished").
