# Deploying to Cloudflare Workers

This is the deploy path for the `workers/` build — a port of the Node app onto
Workers, D1, and Durable Objects. See
[docs/CLOUDFLARE-PORT-NOTES.md](./CLOUDFLARE-PORT-NOTES.md) for why this build
exists alongside the Node one and what differs between them.

## What's already live

Deployed at **`https://caller-coach.bakariw98.workers.dev`**. Concretely:

- D1 database created and schema applied: `caller-coach`
  (`36a74a8c-1399-4c55-8a1b-cb07b1f1d9a5`).
- A demo creator is seeded in that live database: Open Crumb Baking ("Rosa"),
  a full 3-module sourdough course (6 steps, 11 documented problems), a
  $30-minute-block trial pool, and one verified customer (Dana Whitfield,
  `+15550100199`, 30 minutes of paid credit, mid-course with an unresolved
  problem from a prior "call").
- `wrangler deploy` has run, all four secrets are set (`XAI_API_KEY` is a real
  key), and `PUBLIC_BASE_URL` points at the real deployed URL.
- Smoke-tested against Miniflare *and* against this real deployment — webhook
  signature verification, curriculum ingestion, the full MCP tool surface
  against real seeded data, and the Durable Object's outbound connection to
  the real xAI API, which authenticated correctly (see
  CLOUDFLARE-PORT-NOTES.md).

## The one blocker: number provisioning is console-only

`POST /v2/phone-numbers` — the documented way to provision a number — returns
`403 Provisioning SpaceXAI phone numbers via the API is not supported. Use the
console (Voice Agents) instead.` on this account. Confirmed against production
with the real key, not a docs read. See docs/XAI-API-NOTES.md.

**So: provision the number by hand, then register it with this app.**

### 1. Provision in the xAI console

Go to the xAI console → **Voice Agents** → phone numbers, and create a number
for Open Crumb Baking (or whichever creator). Set its webhook URL to:

```
https://caller-coach.bakariw98.workers.dev/webhooks/xai
```

The console will show a **webhook signing secret exactly once**, at creation.
Copy it immediately — there is no way to retrieve it again afterward, xAI
included.

### 2. Register it with this app

```bash
curl -X POST "https://caller-coach.bakariw98.workers.dev/api/creators/creator_b77490adf793450c8a4690b0/phone-number/manual" \
  -H "Authorization: Bearer <ADMIN_TOKEN — see below>" \
  -H "Content-Type: application/json" \
  -d '{
    "e164": "+1XXXXXXXXXX",
    "signing_secret": "<the secret from step 1>",
    "phone_number_id": "<optional, xAI'"'"'s id for it>"
  }'
```

Your `ADMIN_TOKEN` was generated during setup and given to you separately —
it is not repeated in this file since it's a live credential. Rotate it
anytime with `wrangler secret put ADMIN_TOKEN` if needed.

### 3. Call it

The number you registered in step 2. Call it from
**+15550100199** — that's Dana Whitfield's number in the seed data — and the
coach should recognize the account, greet by name, and know she's on the float
test with an unresolved "sinks every time" problem from a prior call.

Calling from any other number gets the short "you're not set up yet" anonymous
greeting (by design — see `docs/ARCHITECTURE.md`'s identity section).

## Setting up a second creator

The full onboarding surface is live:

```bash
TOKEN="<your ADMIN_TOKEN>"
BASE="https://caller-coach.bakariw98.workers.dev"

curl -X POST "$BASE/api/creators" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "business_name": "...", "coach_name": "...", "price_per_minute_cents": 75
}'
# -> {"id": "creator_...", ...}

curl -X POST "$BASE/api/creators/<id>/curriculum" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json;print(json.dumps({"markdown": open("curriculum.md").read()}))')"
# Returns the structure audit. Fix any "error"-severity issues before publishing.

# Provision the number in the xAI console (Voice Agents) — API provisioning
# is blocked on this account, see the section above — then register it:
curl -X POST "$BASE/api/creators/<id>/phone-number/manual" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"e164": "+1...", "signing_secret": "<from the console, shown once>"}'

curl -X POST "$BASE/api/creators/<id>/publish" -H "Authorization: Bearer $TOKEN"
```

## What isn't ported yet

The call path — webhook, Durable Object, MCP tools, billing, structure audit —
is complete and matches the Node build's behavior. Not yet ported to Workers:

- **Customer self-serve signup and the creator onboarding UI.** The Node
  build's version of this (`src/web/`) uses SMS OTP for phone verification,
  which is being replaced rather than ported as-is — see the "web-only
  onboarding" plan below. For now, new customers are added directly via D1 —
  see the pattern in `workers/scripts/seed-via-d1.ts`.
- **The creator dashboard and curriculum-intelligence analytics.** The data is
  all being recorded (`call_events`, `escalations`, the full ledger); the
  read-side dashboard just isn't built for this runtime yet. Query D1 directly
  in the meantime (`npx wrangler d1 execute caller-coach --remote --command "..."`).

## Next: web-only onboarding, no SMS

Both customer and creator onboarding are moving to plain web pages, with no
SMS provider in the loop. For customers, phone ownership gets verified by
their **first real inbound call** rather than a texted code: signup creates
an unverified row from just name + phone; the call router's existing
identified-caller lookup gets extended to also match an unverified row for
that creator + phone and flip it to verified as part of routing that first
call. From then on it behaves exactly like today's verified-caller path —
same wallet, same enrollment, same progress tracking. This keeps the
"caller ID alone never grants access to someone else's account" property
without adding a telephony vendor back into the picture. Not yet built.

## Troubleshooting

**Call connects but the coach can't look anything up.** `PUBLIC_BASE_URL` is
probably wrong or not redeployed — xAI calls `/mcp` on it directly.

**Webhook returns 401.** Check the number's signing secret matches what's
stored — re-run the `/phone-number/manual` registration if you're not sure
(it's safe to register a number again; each row is independent).

**`wrangler deploy` complains about Durable Object migrations.** The
`[[migrations]]` block in `wrangler.toml` is already set up for a fresh
account; if you're redeploying against an account that's had a differently
named DO class before, see
[Durable Objects migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

**Nothing happens when you call.** Check `npx wrangler tail` while placing the
call — it streams live logs, including the DO's connection attempt to xAI,
which is the fastest way to see exactly where it's failing.
