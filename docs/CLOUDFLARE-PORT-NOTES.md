# Notes on the Cloudflare Workers runtime

`workers/` started as a second runtime for the same product as `src/`
(Node/Fastify/better-sqlite3) — it exists because getting a real test call
reachable from outside the original sandbox needed a public HTTPS URL, and
Cloudflare was the one platform available with no auth friction (no tunnel
binary available, Vercel needed authorization that wasn't there, Cloudflare's
MCP tools worked immediately). Since then the two have diverged: `workers/`
became — and stayed — the actual live product, now including an entire
lead-generation product (`leadgen/`, `youtube/`, `email/`, `assistant/`,
`auth/`) that only ever existed here, never in `src/`. See
[CLAUDE.md](../CLAUDE.md) for the current shape. What follows below is why
this runtime is built on Hono/D1/Durable Objects instead of
Fastify/better-sqlite3/in-memory state — still accurate, still the
foundation everything since has been built on, just no longer "in-progress
port" framing.

## Why not just reuse `src/`

Three Node-specific pieces don't run on Workers' runtime at all:

| Node build | Workers replacement | Why |
|---|---|---|
| Fastify | Hono | Fastify assumes a real Node HTTP server process; Hono is built for the Workers/edge runtime model. |
| better-sqlite3 (native binary, sync) | D1 (Cloudflare's SQLite, async over HTTP) | Workers can't load native addons at all. |
| In-memory `Map` registry + `ws` client holding a live socket | A Durable Object per call | A Worker instance is not guaranteed to stay alive or be the same instance across requests; a Durable Object is Cloudflare's primitive for exactly "one object, one long-lived connection, addressable by name." |

The **business logic did not need to change** — curriculum parsing and its
structure audit, the coach's prompt-building, pricing math, the transition
model, wallet/promotional invariants, and the MCP tool definitions all still
apply. What changed is how each of those reaches the database: every DB call
became `async`/`await` against a small shared interface (`workers/db/types.ts`)
that a D1 adapter and (conceptually) a better-sqlite3 adapter both satisfy —
see that file's comment for the exact shape.

## FTS5 was dropped

`src/db/schema.sql` uses a `curriculum_fts` FTS5 virtual table for search. D1's
public documentation does not confirm FTS5 support, so `workers/schema.sql`
omits it entirely. `workers/curriculum/repository.ts`'s `searchCurriculum`
instead pulls a course's indexable rows (steps, problems, lessons, modules,
references — a few hundred at most for one creator) and scores them in JS with
the same term-overlap heuristic FTS5's bm25 was being re-ranked with anyway.
At this scale it's simpler than depending on an unverified extension, and it
produced correct, sensibly-ranked results in the smoke test (see below).

## The Durable Object

`workers/durable-objects/call-session.ts` is the direct structural port of
`src/telephony/call-session.ts`. Two mechanical differences worth knowing if
you're comparing them:

- **Outbound WebSocket**: Workers' documented pattern for a Worker/DO
  *initiating* a connection to a third-party WebSocket server is
  `fetch(url, { headers: { Upgrade: 'websocket' } })`, reading `resp.webSocket`
  off the response, then `.accept()`. The URL passed to `fetch()` uses `https://`
  even though xAI publishes the endpoint as `wss://` — `fetch()` only accepts
  http(s) schemes; the Upgrade header is what actually negotiates the
  WebSocket, same wire protocol either way. **This was verified against real
  xAI infrastructure** during the smoke test below, not just against docs.
- **Metering**: the Node build's `setInterval` becomes the Durable Object
  Alarm API (`ctx.storage.setAlarm` / an `alarm()` handler). An outbound
  WebSocket keeps a DO resident in memory for up to 15 minutes on its own
  regardless, so for any call under that length the distinction is moot — but
  Alarms are the documented eviction-safe primitive, so that's what's used.

## A bug the smoke test caught

Worth recording because it's exactly the kind of thing that's easy to miss in
review and only shows up under a real failure path: the first version of
`finish()` in the Durable Object only wrote the terminal `calls` row inside an
`if (params && this.connectedAt)` guard — copied from the Node version's
*billing* guard, but accidentally wrapped around the whole method instead of
just the billing math. A call that failed to connect (bad key, xAI
unreachable, whatever) would be created with `status: 'ringing'` and then
never updated — stuck open forever, invisible to any "is this call still
going" query. Caught by deliberately forcing a connect failure in the smoke
test below and checking the DB row afterward. Fixed by moving the DB write
outside the connected-only guard and giving a failed-to-connect call its own
terminal status (`rejected`) distinct from a call that connected and later
ended (`ended`).

## What the smoke test actually exercised

Run locally against Miniflare (D1 + Durable Objects simulated, real outbound
network) before this was handed off for deploy:

1. Applied `workers/schema.sql` to both the real production D1 database (via
   the Cloudflare API) and a local Miniflare replica.
2. `POST /api/creators`, `POST /api/creators/:id/curriculum` — creator
   creation and curriculum ingestion, including the structure audit, against
   real D1 reads/writes.
3. A correctly HMAC-signed `realtime.call.incoming` webhook, including a
   deliberate replay of the same webhook id (correctly rejected as a
   duplicate) and a deliberately invalid signature (correctly rejected).
4. The webhook handler routing the call: identifying the seeded customer by
   caller ID, auto-enrolling them in the course, minting a scoped MCP token,
   and calling the Durable Object's `/start`.
5. **The Durable Object making a real outbound request to `https://api.x.ai`**
   with a placeholder API key. xAI's real production API received it,
   processed it, and responded `400 {"code":"Client specified an invalid
   argument","error":"Incorrect API key provided..."}` — proving the entire
   request shape (URL, Upgrade header, Authorization header) is one xAI's
   servers actually parse and respond to correctly. The DO then correctly
   handled the rejection, which is what surfaced the bug above.
6. `POST /mcp` with the resulting session's real minted token:
   `initialize`, `tools/list`, `get_caller_state` (correctly identified the
   seeded customer and their exact course position), `diagnose_problem` for a
   symptom belonging to a *different* step (correctly found it and flagged it
   `from_elsewhere: true` rather than presenting it as the caller's own
   step's troubleshooting), and `search_curriculum` for a query outside the
   course entirely (correctly refused rather than fabricating an answer).
7. A bad bearer token against `/mcp` (correctly rejected, `-32001`).

Nothing here proves a full call works end-to-end with real audio — that
needs a real `XAI_API_KEY` and an actual phone call, which is the one thing
that couldn't be done from this sandbox. Everything short of that has been
exercised against real infrastructure, not mocked.
