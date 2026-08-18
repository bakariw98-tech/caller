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
  30 minutes of paid credit, mid-course with an unresolved problem from a
  prior call, passcode `730511`).
- A real number is live and registered: **+14095097508**, attached to an
  xAI-console-managed Voice Agent (`agent_Rhxnni4ij3qefb4v`) — this account
  cannot provision numbers via API, see below.
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

**+14095097508.** Say your name, then say or type **730511** on the keypad
when asked — that's Dana Whitfield's passcode in the seed data. The coach
should greet her by name and know she's on the float test with an unresolved
"sinks every time" problem from a prior call.

A wrong or missing passcode gets a plain "I can't find that" — no account
information leaks either way. See docs/BILLING.md for why identity here is
passcode-based rather than caller-ID-based at all.

## Onboarding — as web pages, not curl

Both flows are real pages now, not scripts.

**Customers:** `https://caller-coach.bakariw98.workers.dev/c/<creator-slug>` —
name and phone, no SMS round trip. A passcode is generated and shown once,
right on the confirmation page (also visible on later visits to `/account`).
Signing up twice with the same phone returns the existing account rather than
creating a second one.

**Creators:** `https://caller-coach.bakariw98.workers.dev/onboard` — enter the
admin token once, then business info, then **add raw material in whatever form
you already have it** (course outline, how-to guide, the questions customers
keep asking, roadblocks, a video transcript — as many blocks as you like, each
labelled). The system structures it into a curriculum draft you review and
edit before uploading, then attach a phone number (manual — see above),
optional trial pool, publish, and copy the generated agent setup into the xAI
console.

Structuring is deliberately **extractive, never generative**: if your material
doesn't state a step's expected result, it is left blank and flagged rather
than invented, because an invented one would be spoken to your customers as
your own method. Blanks are the to-do list, and the structure audit blocks
publishing until the important ones are filled. Each step also carries the
verbatim quote it came from, viewable under "Where did each part come from?".
Costs a few cents per course, one time.

The page is a plain client for the same JSON API below; nothing it does is
unreachable by script, so both remain available. `POST
/api/creators/:id/curriculum/structure` takes `{sources:[{kind,title,text}]}`
and returns a draft plus its audit and provenance without saving anything:

```bash
TOKEN="<your ADMIN_TOKEN>"
BASE="https://caller-coach.bakariw98.workers.dev"

curl -X POST "$BASE/api/creators" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "business_name": "...", "coach_name": "...", "price_per_minute_cents": 75
}'
curl -X POST "$BASE/api/creators/<id>/curriculum" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json;print(json.dumps({"markdown": open("curriculum.md").read()}))')"
curl -X POST "$BASE/api/creators/<id>/phone-number/manual" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"e164": "+1...", "signing_secret": "<from the console, shown once — or any placeholder on console-managed numbers, see docs/BILLING.md>"}'
curl -X POST "$BASE/api/creators/<id>/publish" -H "Authorization: Bearer $TOKEN"
```

The admin token gates all of the above equally, on both the page and the raw
API — it is a platform-wide secret (matches this being a single-creator
deployment so far), not a per-creator login. True multi-creator self-serve
(each creator with their own account, unable to touch another's data) is a
separate, bigger feature this does not build.

## Email transport for the lead engine — Gmail, no domain

The lead engine (offers, free-content ingestion, `/api/leadgen/simulate`) is
built and tested. This is the last-mile piece: actually receiving a
prospect's email and sending the reply, without owning a domain.
`workers.dev` genuinely cannot receive mail, so Cloudflare Email Service is
out — but a single Gmail account works, connected over OAuth, with a Cron
Trigger polling for what's new. See the plan history for the research behind
this (verification tiers, refresh-token expiry, why polling over Pub/Sub).

**One real trade-off**: without a domain, replies come *from* a real
`@gmail.com` address, not `hello@cutroomclub.com`. The display name can read
"Marcus @ Cutroom Club"; the visible address is still gmail.com.

### 1. One Google Cloud project, shared by every creator

This step happens once total, not once per creator — one OAuth client
authorizes as many creators' Gmail accounts as connect to it.

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create
   a project (or reuse one), and enable the **Gmail API** under APIs &
   Services → Library.
2. APIs & Services → **OAuth consent screen**: User type **External**. Add
   scopes `https://www.googleapis.com/auth/gmail.send` and
   `https://www.googleapis.com/auth/gmail.modify`.
3. **Publishing status: click "Publish App" to move it to "In production."**
   This is the step that matters — leaving it in "Testing" issues refresh
   tokens that expire in 7 days, unusable for an unattended backend. "In
   production" while unverified is capped at 100 total authorizing users for
   the app's lifetime; we need exactly one Gmail account per creator, so this
   cap isn't a practical concern.
4. APIs & Services → **Credentials** → Create Credentials → **OAuth client
   ID** → Application type **Web application**. Add this authorized redirect
   URI (exact, no trailing slash):
   ```
   https://caller-coach.bakariw98.workers.dev/oauth/gmail/callback
   ```
5. Copy the **Client ID** and **Client Secret**, then set them:
   ```bash
   npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
   npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
   ```

### 2. Connect a creator's Gmail account

Pick a dedicated Gmail address for the creator (its name is what prospects
see — not a personal inbox). Then:

```bash
curl -s "$BASE/api/creators/<id>/email/connect" -H "Authorization: Bearer $TOKEN"
# -> { "url": "https://accounts.google.com/o/oauth2/v2/auth?..." }
```

Open that URL in a browser **signed into the creator's Gmail account**, click
through the "Google hasn't verified this app" warning (expected — this app
intentionally stays unverified rather than going through Google's security
assessment for a single-account integration), and click Allow. You'll land on
a plain confirmation page once `/oauth/gmail/callback` stores the connection.

### 3. Test it without waiting for the Cron Trigger

The scheduled poll runs every 2 minutes in production. For fast iteration,
trigger one pass on demand:

```bash
curl -s -X POST "$BASE/api/admin/email/poll" -H "Authorization: Bearer $TOKEN"
```

Send a real email to the connected Gmail address from a different account,
then call the endpoint above. It returns a summary
(`connectionsChecked`/`messagesProcessed`/`errors`), and the reply lands back
in the sender's inbox, threaded under the original message.

## Retrieval — semantic, with a measured floor

Which knowledge the coach sees for a given question is decided by hybrid
retrieval: cosine similarity over `@cf/baai/bge-base-en-v1.5` embeddings
(Workers AI, `[ai]` binding, 768 dims) blended with the original keyword
scorer. Vectors live in `knowledge_items.embedding` as base64 Float32 and are
compared in JS — one creator's corpus is small enough that brute force beats
standing up Vectorize.

Keyword-only retrieval missed questions the material genuinely answered
whenever a prospect's wording differed from the creator's ("pricing" against
an item titled "what should I charge"). Cold prospects always arrive in their
own vocabulary, so that was the common case.

Indexing happens automatically on ingest and after an edit. To backfill or
repair:

```bash
curl -X POST "$BASE/api/creators/<id>/reindex" -H "Authorization: Bearer $TOKEN"
# ?force=1 re-embeds everything — required after changing the embedding model,
# since vectors from different models are not comparable.
```

To see why a question retrieved what it did, including raw scores:

```bash
curl -X POST "$BASE/api/creators/<id>/retrieval-debug" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"text":"the question"}'
```

**On `SEMANTIC_FLOOR`:** it is deliberately low (0.5) and that is measured, not
guessed. On a real corpus BGE scored relevant questions 0.53-0.63 and
off-topic ones 0.42-0.56 — bands that nearly touch. A higher floor rejects
real questions; the model's grounding instructions are what actually decline
off-topic ones, verified against gardening, mortgage and dog-training
questions. Re-measure with `/retrieval-debug` before changing it.

## What isn't ported yet

The call path — webhook, Durable Object, MCP tools, billing, structure audit,
and now both onboarding flows — is complete. Not yet ported to Workers:

- **The creator dashboard and curriculum-intelligence analytics.** The data is
  all being recorded (`call_events`, `escalations`, the full ledger); the
  read-side dashboard just isn't built for this runtime yet. Query D1 directly
  in the meantime (`npx wrangler d1 execute caller-coach --remote --command "..."`).
- **Per-creator accounts.** See above.

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
