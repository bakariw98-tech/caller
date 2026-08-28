# Architecture

Three real request flows make up the live product, plus one dormant one
kept for the original product. See [CLAUDE.md](../CLAUDE.md) for the
two-products-in-one-Worker context if you haven't read that yet — this
file assumes it.

## Flow 1: the email pipeline

```
  Prospect's inbox
        │  writes to the creator's connected Gmail address
        ▼
  Cron Trigger (every 2 min)  ──▶  poll each email_connections row
        │                              (workers/email/gmail.ts)
        ▼
  routeInboundMessage()  (workers/leadgen/inbound.ts)
        │  decides: normal grounded reply, or — if voice escalation is on
        │  and this looks like a genuine first message — a "hook" email
        │  inviting a call instead
        ▼
  runLeadgenPipeline()  (workers/leadgen/pipeline.ts)
        │  the single shared chokepoint — also what /api/leadgen/simulate
        │  calls directly, so "Try a question" on the dashboard exercises
        │  the exact same code path a real prospect's email would
        │
        ├─ retrieval: hybrid cosine-similarity (Workers AI embeddings,
        │  @cf/baai/bge-base-en-v1.5) blended with keyword scoring, over
        │  that creator's knowledge_items only (workers/leadgen/reply.ts)
        │
        ├─ reply generation: grounded in retrieved knowledge, reasons
        │  about genuine offer fit — never label-matching (see
        │  call-prompt.ts / prompt.ts, and CLAUDE.md's note on this)
        │
        └─ signal extraction: situation, real problem, goal, blocked-on,
           topics — accumulated onto the prospects row across the whole
           conversation (workers/leadgen/prospects.ts)
        ▼
  Gmail send, threaded under the original message
```

Everything a creator sees on the dashboard's Leads panel and Overview
comes from what this pipeline wrote to `prospects` / `prospect_messages`
— nothing is computed separately from what actually happened in a real
(or simulated) conversation.

## Flow 2: the voice-escalation call

Structurally the same call architecture the original coaching product
used, now serving a `purpose: 'qualify'` phone number instead of
`'coach'`:

```
  Prospect's phone
        │  calls the number from the hook email, or the creator's own
        │  "start a live voice test" button on the dashboard
        ▼
  xAI  ──── realtime.call.incoming (signed webhook) ────▶  POST /webhooks/xai
        │                                                       │
        │                                              verify signature (raw bytes)
        │                                              route by phone_numbers.purpose
        │                                              ('qualify' → qualification-call.ts)
        │                                              mint a scoped MCP token
        │                                                       │
        ◀──── WebSocket wss://api.x.ai/v1/realtime?call_id= ────┘
        │        session.update  (qualification-call instructions + MCP tool)
        │
        └──── HTTPS ────▶  POST /mcp   (xAI calls our tools directly)
                              resolve_prospect · record_qualification_signal
                              record_call_outcome
```

Same control-channel shape as the original design: no audio crosses our
WebSocket (SIP session, xAI terminates the phone leg), the socket carries
configuration/steering/teardown only, and MCP tools arrive as inbound
HTTP because xAI connects to `/mcp` on its own — see
`workers/durable-objects/call-session.ts` (shared by both call purposes)
and `workers/telephony/qualification-call.ts`.

`record_qualification_signal`'s discovery-completeness gate and
`resolve_prospect`'s exact-match lookup are the same honesty-gate
discipline as the email path's `findOfferByName` — a live call is not
exempt from "never invent a fact" just because it's spoken instead of
written.

## Flow 3: the dashboard and the MCP assistant surface

```
  Creator, logged in (workers/auth/session.ts, creator_sessions)
        │
        ▼
  GET /dashboard/:creatorId  (workers/routes/dashboard.ts)
        │  one page, sidebar nav (hamburger drawer under ~880px), every
        │  panel backed by its own /api/creators/:id/... route
        │
        └─ "Talk to your assistant" / "Connect your own agent" both open
           the SAME tool surface (workers/mcp/assistant-tools.ts):
             - the dashboard's built-in voice assistant talks to it over
               a short-lived session (workers/routes/assistant.ts)
             - a creator's own agent (Claude Desktop, etc.) talks to it
               over a long-lived MCP key, minted once from the dashboard
```

Every tool is creator-scoped by construction — handlers take the
creator_id from the resolved session, never from a model-supplied
argument — and every tool that reads or writes real data sets an
accurate `readOnlyHint`/`destructiveHint` MCP annotation (see
`workers/mcp/tools.ts`).

## Flow 4 (dormant): the original coaching call

Present in the codebase, routed by `purpose: 'coach'`, not under active
development this session. Same webhook/DO/MCP shape as Flow 2 above, but
against `coach/`'s prompt-building and `curriculum/`'s retrieval instead
of the lead-gen tool set — see the original design reasoning below, which
still applies to this path specifically.

### Why the curriculum is a tree

`Course → Module → Lesson → Step`, with each step carrying instructions,
an expected result, completion criteria, and documented problems. A flat
knowledge base would answer questions; it would not let the coach say
"you're on step four, your result should look like X, and the thing that
usually goes wrong here is Y." `auditStructure()` treats a step with no
instructions or no expected result as a blocking error and refuses to
publish.

### Why state is transitions, not history

`state_transitions` records what changed — `was at step 4 → hit problem
X → resolved X → advanced to step 5` — not "customer asked about step
4." Only events that genuinely relocate someone move the cursor. This is
what lets a returning caller continue instead of re-explaining
themselves, and the same principle (accumulate real signal, don't
re-derive it) is why `prospects` rows in the lead-gen product work the
same way.

## Real module map

**The live product.**

| Path | Responsibility |
|---|---|
| `leadgen/` | Ingestion, retrieval, reply generation, offer-fit reasoning, the email pipeline, dashboard activity aggregation |
| `youtube/` | Channel connect, tiered video fetch, transcript ingestion |
| `email/` | Gmail OAuth, send/receive, MIME |
| `assistant/` | The assistant's system prompt |
| `auth/` | Password hashing, creator login sessions, creator-scoped route access |
| `routes/` | Every Hono route — `dashboard.ts` is the largest and the best starting point |

**Shared infrastructure, both call kinds.**

| Path | Responsibility |
|---|---|
| `mcp/` | Three tool sets (coach / qualify / assistant), dispatched by session kind (`routes/mcp.ts`) |
| `telephony/` | Webhook routing by number `purpose`, qualification-call setup |
| `durable-objects/` | One `CallSessionDO` per live call, either purpose |
| `xai/` | The realtime Voice API REST client and webhook verification |
| `db/` | The D1 adapter (`SqlDb` interface) |

**The original product — present, dormant.**

| Path | Responsibility |
|---|---|
| `coach/` | Instructions and session config for a `'coach'`-purpose call |
| `curriculum/` | Parse the authoring format, audit structure, store/retrieve the tree |
| `state/` | Transitions, position, progress summaries |
| `identity/` | Caller ID lookup, SMS OTP account linking |
| `billing/` | Wallets, ledger, promotional budgets, price floor — see [BILLING.md](./BILLING.md), scoped to this path |
