# Caller

A white-labeled coaching platform. A creator's curriculum becomes a phone number
their customers can call whenever they get stuck.

The customer never interacts with this platform. They call their instructor's
coach, on their instructor's number, and get help with their instructor's
material.

```
creator expertise + structured curriculum + persistent customer state + real-time voice
```

## Two runtimes

- **`src/`** — Node, Fastify, better-sqlite3. The reference implementation;
  everything below in this README describes it.
- **`workers/`** — Cloudflare Workers, Hono, D1, Durable Objects. A second
  runtime for the same product, built to get a real test call reachable from
  a public URL without standing up separate hosting. The call path (webhook,
  live session, MCP tools, billing) is complete and D1-seeded with a working
  demo creator; the customer self-serve and dashboard pages aren't ported yet.
  See [docs/DEPLOY.md](docs/DEPLOY.md) to ship it and
  [docs/CLOUDFLARE-PORT-NOTES.md](docs/CLOUDFLARE-PORT-NOTES.md) for what
  differs from `src/` and why.

## Running it

```bash
npm install
cp .env.example .env          # fill in XAI_API_KEY and PUBLIC_BASE_URL
npm run migrate
npm run seed                  # a complete demo creator, course and customer
npm run dev
```

`npm run seed` prints a creator id, a landing page at `/c/open-crumb` and a
dashboard link. The demo works fully without an xAI key — everything except
answering an actual phone call.

To take real calls, `PUBLIC_BASE_URL` must be a public HTTPS host (an ngrok or
cloudflared tunnel in development). xAI needs to reach **two** endpoints on it:
the webhook, and the MCP tool endpoint.

```bash
npm run provision -- --creator <creator_id> --area 415
```

This registers the number and stores the webhook signing secret, which xAI
returns exactly once and never again.

### Loading a curriculum

```bash
npm run ingest -- --file examples/curriculum-sample.md --audit-only
npm run ingest -- --creator <creator_id> --file examples/curriculum-sample.md
```

The authoring format is documented at the top of
`src/curriculum/parse-markdown.ts`. The audit runs either way and **blocks**
import when steps lack instructions or an expected result — see below.

### Tests

```bash
npm test          # 57 tests
npm run typecheck
```

## What is built

Phase 1 and Phase 2 of the build order, end to end.

- **Ingestion** that preserves the `Course → Module → Lesson → Step` tree, with
  troubleshooting attached to the step where it bites, and a structural audit
  that refuses to publish a flattened course.
- **Webhook receiver** with Standard Webhooks signature verification against raw
  bytes, replay protection, and per-number signing secrets.
- **Session bridge** over `wss://api.x.ai/v1/realtime?call_id=` — configuration,
  steering, live metering, warnings, and hangup.
- **Coach behaviour**: grounding and refusal rules ahead of everything else,
  one-action-at-a-time coaching, native SIP REFER escalation.
- **State transitions** rather than conversation history, so a returning caller
  never re-explains themselves.
- **Identity**: caller ID identifies, SMS OTP verifies, unknown numbers get a
  bounded call that reveals nothing.
- **Credits**: prepaid seconds scoped per creator, manual top-up only,
  promotional budgets that can only spend the creator's own prepaid money.
- **Creator dashboard** with business metrics and curriculum intelligence.

Phase 3 is partially present (onboarding exists as an API, dashboard is built);
Phase 4 — revenue share and payouts — is not started. The price floor it depends
on is enforced.

## The five risks, and where each is addressed

**1. Per-minute cost.** Retrieval runs through MCP, where tool output is exempt
from the text meter; exactly one billable text item is seeded per call; all
mid-call steering uses the exempt `response.create`; `reasoning.effort` defaults
to `none`. Both retail and cost are recorded per call so margin is measured
rather than assumed. → [docs/COST-MODEL.md](docs/COST-MODEL.md)

**2. Grounding failure.** The refusal path was built before the features. The
prompt puts grounding above all other instructions; `search_curriculum` returns
an explicit refusal instruction when nothing matches; `diagnose_problem` returns
only genuine symptom overlaps and flags anything pulled from elsewhere in the
course as needing a check. Escalation is native. Six tests cover the refusal
paths.

**3. Structure loss in ingestion.** `auditStructure()` treats a step with no
instructions or no expected result as a blocking error, on the grounds that a
coach which cannot tell whether your result is wrong is a chatbot. Zero steps
after parsing is a blocking error by name. `--force` stores a draft that cannot
go live.

**4. Webhook signing secret.** Persisted in the same call that provisions the
number; provisioning refuses to store a number whose secret it cannot find.

**5. Trial abuse.** Promotional grants bind to a verified customer account, not
to a call, with a per-customer cap and a reservation check so a pool cannot be
over-promised across simultaneous first calls.

## Known gaps

- **Creator console auth is a shared `ADMIN_TOKEN`.** Fine for onboarding
  creator #1 by hand; real accounts are needed before self-serve.
- **Payments are simulated.** `POST /c/:slug/topup` credits the wallet directly.
  A real deployment puts the creator's payment processor in front of it, with
  the creator's business name on the descriptor and receipt.
- **SMS needs a provider.** xAI sends voice, not messages. `identity/sms.ts` has
  a one-method interface and prints codes to stdout by default.
- **SQLite.** Correct for one creator; the schema is already multi-tenant, so
  the move to Postgres is a driver swap rather than a redesign.
- **Several xAI API details are unverified against a live call** — audio
  duration events on SIP sessions, the exact `reasoning.effort` key shape, and
  the `POST /v2/phone-numbers` response schema. Each is listed with what the
  code assumes and how to correct it in
  [docs/XAI-API-NOTES.md](docs/XAI-API-NOTES.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — call flow, module map, and the
  reasoning behind the tree, the transition log, and token-scoped tools
- [docs/COST-MODEL.md](docs/COST-MODEL.md) — what meters, what doesn't, and how
  to measure real cost per hour
- [docs/XAI-API-NOTES.md](docs/XAI-API-NOTES.md) — verified behaviour, open
  questions, and why outbound calling would need a second vendor
