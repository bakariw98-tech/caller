# Deploying to Cloudflare Workers

This is the deploy path for the `workers/` build — a port of the Node app onto
Workers, D1, and Durable Objects. See
[docs/CLOUDFLARE-PORT-NOTES.md](./CLOUDFLARE-PORT-NOTES.md) for why this build
exists alongside the Node one and what differs between them.

## What's already done

- **D1 database created and schema applied**: `caller-coach`
  (`36a74a8c-1399-4c55-8a1b-cb07b1f1d9a5`), wired into `workers/wrangler.toml`.
- **A demo creator is already seeded** in that live database: Open Crumb
  Baking ("Rosa"), a full 3-module sourdough course (6 steps, 11 documented
  problems), a $30-minute-block trial pool, and one verified customer (Dana
  Whitfield, `+15550100199`, 30 minutes of paid credit, mid-course with an
  unresolved problem from a prior "call"). Nothing further needs seeding to
  place a first real test call once a number is provisioned.
- **Everything has been smoke-tested locally** against a Miniflare-simulated
  D1 and Durable Object — webhook signature verification, replay protection,
  curriculum ingestion, the full MCP tool surface, and the Durable Object's
  outbound connection attempt to the **real** xAI API (which authenticated the
  request and rejected only the placeholder key — see
  CLOUDFLARE-PORT-NOTES.md for the exact exchange). The one thing that could
  not be exercised from here is a real API key completing a real call.

## What you need to do

Everything below requires a Cloudflare account with Workers, D1, and Durable
Objects available (all on the free tier), and an xAI API key.

### 1. Log in and deploy

```bash
cd workers
npm install
npx wrangler login
npx wrangler deploy
```

This prints your Worker's URL — something like
`https://caller-coach.<your-subdomain>.workers.dev`.

### 2. Set secrets

Never put these in `wrangler.toml` — they go in via `wrangler secret put`,
which keeps them out of git entirely.

```bash
npx wrangler secret put XAI_API_KEY
npx wrangler secret put MCP_TOKEN_SECRET        # any random 32+ byte string
npx wrangler secret put ADMIN_TOKEN             # guards the creator API below
npx wrangler secret put XAI_WEBHOOK_SIGNING_SECRET   # optional fallback; provisioning below sets the real per-number one automatically
```

Generate random values with `openssl rand -base64 32` if you don't have one handy.

### 3. Point `PUBLIC_BASE_URL` at your real Worker URL

Edit `workers/wrangler.toml`:

```toml
[vars]
PUBLIC_BASE_URL = "https://caller-coach.<your-subdomain>.workers.dev"
```

Then redeploy: `npx wrangler deploy`.

This matters more than it looks: xAI needs to reach **two** endpoints on this
URL — `/webhooks/xai` (incoming call notifications) and `/mcp` (curriculum
tool calls, made directly by xAI's servers, not routed through your
WebSocket). Get this wrong and the coach will connect but never be able to
look anything up.

### 4. Provision a phone number for the seeded creator

```bash
curl -X POST "https://<your-worker-url>/api/creators/creator_b77490adf793450c8a4690b0/phone-number" \
  -H "Authorization: Bearer <your ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"area_code": "415"}'
```

This calls xAI's `POST /v2/phone-numbers`, points the webhook at your Worker,
and stores the returned number and signing secret in D1 — the secret is
returned exactly once by xAI and unrecoverable after, so this endpoint refuses
to store a number it can't read one for.

### 5. Call it

The response from step 4 gives you the number. Call it from
**+15550100199** — that's Dana Whitfield's number in the seed data — and the
coach should recognize the account, greet by name, and know she's on the float
test with an unresolved "sinks every time" problem from a prior call.

Calling from any other number gets the short "you're not set up yet" anonymous
greeting (by design — see `docs/ARCHITECTURE.md`'s identity section).

## Setting up a second creator

The full onboarding surface is live:

```bash
TOKEN="<your ADMIN_TOKEN>"
BASE="https://<your-worker-url>"

curl -X POST "$BASE/api/creators" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "business_name": "...", "coach_name": "...", "price_per_minute_cents": 75
}'
# -> {"id": "creator_...", ...}

curl -X POST "$BASE/api/creators/<id>/curriculum" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json;print(json.dumps({"markdown": open("curriculum.md").read()}))')"
# Returns the structure audit. Fix any "error"-severity issues before publishing.

curl -X POST "$BASE/api/creators/<id>/phone-number" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"area_code":"415"}'

curl -X POST "$BASE/api/creators/<id>/publish" -H "Authorization: Bearer $TOKEN"
```

## What isn't ported yet

The call path — webhook, Durable Object, MCP tools, billing, structure audit —
is complete and matches the Node build's behavior. Not yet ported to Workers:

- **Customer self-serve signup** (phone verification via SMS OTP, the
  landing/account/top-up pages). For now, new customers are added directly via
  D1 — see the pattern in `workers/scripts/seed-via-d1.ts` — until this is
  built.
- **The creator dashboard and curriculum-intelligence analytics.** The data is
  all being recorded (`call_events`, `escalations`, the full ledger); the
  read-side dashboard just isn't built for this runtime yet. Query D1 directly
  in the meantime (`npx wrangler d1 execute caller-coach --remote --command "..."`).

Both exist and are tested in the Node build (`src/web/`) if you want the
reference to port from.

## Troubleshooting

**Call connects but the coach can't look anything up.** `PUBLIC_BASE_URL` is
probably wrong or not redeployed — xAI calls `/mcp` on it directly.

**Webhook returns 401.** Check the number's signing secret matches what's
stored — re-run step 4 if you're not sure (it's safe to re-provision).

**`wrangler deploy` complains about Durable Object migrations.** The
`[[migrations]]` block in `wrangler.toml` is already set up for a fresh
account; if you're redeploying against an account that's had a differently
named DO class before, see
[Durable Objects migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

**Nothing happens when you call.** Check `npx wrangler tail` while placing the
call — it streams live logs, including the DO's connection attempt to xAI,
which is the fastest way to see exactly where it's failing.
