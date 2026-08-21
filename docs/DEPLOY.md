# Deploying to Cloudflare Workers

The deploy path for `workers/` — the live product. See
[CLOUDFLARE-PORT-NOTES.md](./CLOUDFLARE-PORT-NOTES.md) for why this runtime
exists and what it's built on.

## What's already live

Deployed at **`https://caller-coach.bakariw98.workers.dev`**:

- D1 database created and schema applied: `caller-coach`
  (`36a74a8c-1399-4c55-8a1b-cb07b1f1d9a5`).
- `wrangler deploy` has run, all secrets are set (`XAI_API_KEY`,
  `ADMIN_TOKEN`, `SESSION_SECRET`, `MCP_TOKEN_SECRET`,
  `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`, `TRANSCRIPT_API_KEY`), and
  `PUBLIC_BASE_URL` points at the real deployed URL.
- At least one real creator is live, with a real login, a connected Gmail
  inbox, real leads, and a real offer catalog.

```bash
cd workers
npx wrangler deploy   # needs CLOUDFLARE_API_TOKEN in the environment
```

## Creator login and the dashboard

A creator's own control panel is `https://caller-coach.bakariw98.workers.dev/dashboard/:creatorId`,
behind real per-creator login (`workers/auth/session.ts`,
`workers/auth/password.ts`) — no key in the URL. To get a new or existing
creator logged in:

1. Set (or reset) their login from `/onboard` (see "Onboarding a new
   creator" below) — it takes an email and password and calls
   `PATCH /api/creators/:id/login`.
2. Or set it directly: `hashPassword()` in `workers/auth/password.ts` is a
   pure function (`pbkdf2:<iterations>:<saltHex>:<hashHex>`) — run it
   locally with `node`, then `UPDATE creators SET password_hash = ?,
   login_email = ? WHERE id = ?` against the live D1 database. This is the
   "creator locked out, reset their password" runbook — the hash is
   one-way, so a forgotten password can only be reset, never recovered.

Once logged in, the dashboard is sidebar nav (a hamburger drawer under
~880px): **Overview** (real audience-activity numbers — who wrote in, a
funnel with period-over-period deltas, a 30-day trend, what people are
actually asking about), **Leads** (every prospect, including the exact
email transcript per person, verbatim), **Offers**, **Content** (paste
material or connect YouTube; the raw knowledge-item list lives behind an
"Advanced" toggle, not the main view), **Voice escalation**, **Connect
agent**, and **Settings**.

`ADMIN_TOKEN` still works as an operator override on top of a creator's
own login (support access), and still gates every `/onboard` and
platform-level route — it is not, itself, how a creator gets into their
own dashboard any more.

### Onboarding a new creator

`https://caller-coach.bakariw98.workers.dev/onboard` — enter the admin
token, then business info, then set the new creator's login (email +
password). From there they run everything themselves.

## Connect your own agent (MCP)

From the dashboard's **Connect agent** panel, "Create a key" mints a
long-lived MCP key and shows the connector URL exactly once — treat it
like a password; it can read and change everything in that creator's
account, including sending real email as them, for as long as it exists.
Paste it into Claude Desktop (or any MCP-capable agent) as a custom
connector; nothing else to configure. Revoke a key any time from the same
panel.

The tool surface behind it is `workers/mcp/assistant-tools.ts` — the exact
same tools the dashboard's built-in "Talk to your assistant" voice
assistant uses. See [CLAUDE.md](../CLAUDE.md) for the honesty-gate
discipline every tool there holds to.

## Email transport for the lead engine — Gmail, no domain

Receiving a prospect's email and sending the reply, without owning a
domain. `workers.dev` genuinely cannot receive mail, so Cloudflare Email
Service is out — a single Gmail account per creator works instead,
connected over OAuth, with a Cron Trigger polling for what's new.

**One real trade-off**: without a domain, replies come *from* a real
`@gmail.com` address, not `hello@creatorsdomain.com`. The display name can
read "Rosa @ Sandcastles"; the visible address is still gmail.com.

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
see — not a personal inbox). Then, as that creator (logged in) or as the
operator with `ADMIN_TOKEN`:

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

## Voice escalation — the phone call as the real sales conversation

A second phone number per creator, with `purpose = 'qualify'` instead of the
default `'coach'`. When a genuinely-interested prospect emails in and this
mode is on, instead of a written reply they get a warm one-tap invitation to
call — the call itself is where discovery, diagnosis, and an
honestly-earned offer all happen live, not a phone-flavored qualification
gate ahead of an email that still does the real selling.

**Setup, from the dashboard's "Voice escalation" panel**
(`/dashboard/:creatorId`, logged in):

1. Provision a second number in the xAI console the same way as any other
   number (xAI console → Voice Agents → phone numbers; webhook URL
   `https://caller-coach.bakariw98.workers.dev/webhooks/xai`), then
   register it in the panel — same manual-registration flow as any
   number, this one just carries `purpose: 'qualify'`.
2. A Gmail connection must already exist — the hook email needs somewhere
   to send from. Enabling the mode is refused server-side
   (`PATCH /api/creators/:id/voice-qualification`) until both the number
   and the Gmail connection exist, so this can't be half-configured live.
3. Optionally set the objection posture (`soft`, the default, backs off
   after one honest answer; `assertive` allows a couple of genuine
   re-engagements first).
4. Per-offer sales truth (who it's NOT for, known objections and how to
   answer them, when to recommend it / not, next-step style) is entered on
   each offer in the "Offers" panel — this is what the call prompt is
   grounded in; nothing beyond it is ever said on a call.

**Prompt-size measurement** (measured directly against
`buildQualCallInstructions()`, not estimated):

| offers loaded (full sales-truth playbook each) | prompt size |
|---|---|
| 0   | ~1,900 tokens |
| 1   | ~2,300 tokens |
| 2   | ~2,700 tokens |
| 4   | ~3,500 tokens |

Each additional offer's full playbook (who_for, not_who_for, covers,
price_text, recommend_when, dont_recommend_when, a realistic paragraph of
objections_and_responses) costs roughly 400-450 tokens. This is sent
**once**, in `session.update` at call start, never rebuilt mid-call — unlike
email's per-turn prompt, so it does not multiply by conversation length the
way a per-turn cost would. A creator running up to 4-5 offers with full
playbooks stays comfortably under 4,000 tokens for the whole standing
instructions; re-measure here if a creator's offer count grows well past
that, since the linear-per-offer cost does eventually add up for someone
running a large catalog.

## What's genuinely unfinished

See the README's "What's genuinely unfinished" for the current, accurate
list — kept in one place rather than duplicated here to avoid the two
drifting apart.

## Troubleshooting

**Call connects but the assistant/coach can't look anything up.**
`PUBLIC_BASE_URL` is probably wrong or not redeployed — xAI calls `/mcp`
on it directly.

**Webhook returns 401.** Check the number's signing secret matches what's
stored — re-run the `/phone-number/manual` registration if you're not sure
(it's safe to register a number again; each row is independent).

**`wrangler deploy` complains about Durable Object migrations.** The
`[[migrations]]` block in `wrangler.toml` is already set up for a fresh
account; if you're redeploying against an account that's had a differently
named DO class before, see
[Durable Objects migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

**Nothing happens when you call.** Check `npx wrangler tail` while placing the
call — it streams live logs, including the Durable Object's connection
attempt to xAI, which is the fastest way to see exactly where it's failing.

---

## Legacy: the original coaching-call product

Everything below is about the *original* per-minute coaching product (the
`'coach'`-purpose call path — see [CLAUDE.md](../CLAUDE.md)), still present
in the codebase but not under active development. Kept for reference, not
what a new creator or a new agent working on this repo should start from.

### Number provisioning is console-only

`POST /v2/phone-numbers` — the documented way to provision a number —
returns `403 Provisioning SpaceXAI phone numbers via the API is not
supported. Use the console (Voice Agents) instead.` on this account.
Confirmed against production with the real key, not a docs read. See
docs/XAI-API-NOTES.md. This applies to number provisioning generally
(both call purposes go through the same console step); it's documented
here because it was discovered while setting up the original product.

**So: provision the number by hand, then register it with this app.**

#### 1. Provision in the xAI console

Go to the xAI console → **Voice Agents** → phone numbers, and create a
number for the creator. Set its webhook URL to:

```
https://caller-coach.bakariw98.workers.dev/webhooks/xai
```

The console will show a **webhook signing secret exactly once**, at
creation. Copy it immediately — there is no way to retrieve it again
afterward, xAI included.

#### 2. Register it with this app

```bash
curl -X POST "https://caller-coach.bakariw98.workers.dev/api/creators/<creator_id>/phone-number/manual" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "e164": "+1XXXXXXXXXX",
    "signing_secret": "<the secret from step 1>",
    "phone_number_id": "<optional, xAI'"'"'s id for it>"
  }'
```

### Original demo creator

A demo creator was seeded for this original product early in the project:
Open Crumb Baking ("Rosa"), a full 3-module sourdough course (6 steps, 11
documented problems), a $30-minute-block trial pool, and one verified
customer (Dana Whitfield, 30 minutes of paid credit, mid-course with an
unresolved problem from a prior call, passcode `730511`), reachable at
**+14095097508**. This is historical seed data for the original coaching
product, not the current lead-gen product's live creator(s).

A wrong or missing passcode gets a plain "I can't find that" — no account
information leaks either way. See docs/BILLING.md for why identity here is
passcode-based rather than caller-ID-based at all.

### Curriculum onboarding — as web pages, not curl

Both flows are real pages, not scripts.

**Customers:** `https://caller-coach.bakariw98.workers.dev/c/<creator-slug>` —
name and phone, no SMS round trip. A passcode is generated and shown once,
right on the confirmation page (also visible on later visits to `/account`).
Signing up twice with the same phone returns the existing account rather than
creating a second one.

**Creators (curriculum path):** the same `/onboard` page as the current
product's login setup also handles curriculum-based onboarding for a
`'coach'`-purpose creator — enter the admin token, then business info,
then **add raw material in whatever form you already have it** (course
outline, how-to guide, the questions customers keep asking, roadblocks, a
video transcript — as many blocks as you like, each labelled). The system
structures it into a curriculum draft you review and edit before
uploading, then attach a phone number (manual — see above), optional
trial pool, publish, and copy the generated agent setup into the xAI
console.

Structuring is deliberately **extractive, never generative**: if your
material doesn't state a step's expected result, it is left blank and
flagged rather than invented, because an invented one would be spoken to
your customers as your own method. Blanks are the to-do list, and the
structure audit blocks publishing until the important ones are filled.
Each step also carries the verbatim quote it came from, viewable under
"Where did each part come from?". Costs a few cents per course, one time.

`POST /api/creators/:id/curriculum/structure` takes
`{sources:[{kind,title,text}]}` and returns a draft plus its audit and
provenance without saving anything:

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
