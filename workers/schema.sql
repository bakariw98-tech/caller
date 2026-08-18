-- D1 schema for the Cloudflare port.
--
-- Identical to src/db/schema.sql with one deliberate difference: no FTS5
-- virtual table. D1's SQLite build does not confirm FTS5 support in its public
-- docs, and this app's curriculum is small (one creator's course, at most a
-- few hundred rows) — scoring candidates in JS after a plain SELECT is simpler
-- than depending on an unverified extension. See workers/curriculum/search.ts.
--
-- Everything else is unchanged from the Node schema; keep the two in sync by
-- hand if either evolves.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS creators (
  id                    TEXT PRIMARY KEY,
  slug                  TEXT NOT NULL UNIQUE,
  business_name         TEXT NOT NULL,
  coach_name            TEXT NOT NULL,
  coach_voice           TEXT NOT NULL DEFAULT 'eve',
  brand_json            TEXT NOT NULL DEFAULT '{}',
  welcome_message       TEXT,
  outcome               TEXT,
  audience              TEXT,
  methodology           TEXT,
  teaching_style        TEXT,
  always_do_json        TEXT NOT NULL DEFAULT '[]',
  never_do_json         TEXT NOT NULL DEFAULT '[]',
  ask_questions_when    TEXT,
  escalation_policy     TEXT NOT NULL DEFAULT 'offer_human',
  escalation_phone      TEXT,
  price_per_minute_cents INTEGER NOT NULL,
  status                TEXT NOT NULL DEFAULT 'draft',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS phone_numbers (
  id                  TEXT PRIMARY KEY,
  creator_id          TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  xai_phone_number_id TEXT NOT NULL UNIQUE,
  e164                TEXT NOT NULL UNIQUE,
  sip_host            TEXT,
  webhook_id          TEXT,
  origin              TEXT NOT NULL DEFAULT 'xai_provisioned',
  signing_secret      TEXT NOT NULL,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phone_numbers_creator ON phone_numbers(creator_id);

CREATE TABLE IF NOT EXISTS courses (
  id          TEXT PRIMARY KEY,
  creator_id  TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  outcome     TEXT,
  audience    TEXT,
  methodology TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_courses_creator ON courses(creator_id);

CREATE TABLE IF NOT EXISTS modules (
  id         TEXT PRIMARY KEY,
  course_id  TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  title      TEXT NOT NULL,
  summary    TEXT,
  UNIQUE (course_id, seq)
);

CREATE TABLE IF NOT EXISTS lessons (
  id         TEXT PRIMARY KEY,
  module_id  TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  course_id  TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  title      TEXT NOT NULL,
  summary    TEXT,
  UNIQUE (module_id, seq)
);

CREATE TABLE IF NOT EXISTS steps (
  id                  TEXT PRIMARY KEY,
  lesson_id           TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  module_id           TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  course_id           TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  seq                 INTEGER NOT NULL,
  global_seq          INTEGER NOT NULL,
  title               TEXT NOT NULL,
  instructions        TEXT,
  expected_result     TEXT,
  completion_criteria TEXT,
  prerequisites_json  TEXT NOT NULL DEFAULT '[]',
  UNIQUE (lesson_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_steps_course_seq ON steps(course_id, global_seq);
CREATE INDEX IF NOT EXISTS idx_steps_module ON steps(module_id);

CREATE TABLE IF NOT EXISTS step_problems (
  id         TEXT PRIMARY KEY,
  step_id    TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  course_id  TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  symptom    TEXT NOT NULL,
  cause      TEXT,
  fix        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_step_problems_step ON step_problems(step_id);
CREATE INDEX IF NOT EXISTS idx_step_problems_course ON step_problems(course_id);

CREATE TABLE IF NOT EXISTS references_docs (
  id         TEXT PRIMARY KEY,
  course_id  TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'reference'
);
CREATE INDEX IF NOT EXISTS idx_reference_docs_course ON references_docs(course_id);

CREATE TABLE IF NOT EXISTS customers (
  id                TEXT PRIMARY KEY,
  creator_id        TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  name              TEXT,
  phone_e164        TEXT NOT NULL,
  verified_at       INTEGER,
  -- Spoken/keyed identity for calls the platform never sees a webhook for
  -- (console-managed Voice Agent Builder numbers give no caller ID at all —
  -- see docs/XAI-API-NOTES.md). The coach asks for this out loud; there is no
  -- per-call session on that path to bind identity to any other way, so this
  -- doubles as the one channel that still works regardless of which xAI
  -- integration a given number ends up on.
  passcode          TEXT,
  preferences_json  TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL,
  UNIQUE (creator_id, phone_e164)
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_e164);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_passcode ON customers(creator_id, passcode) WHERE passcode IS NOT NULL;

CREATE TABLE IF NOT EXISTS enrollments (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  course_id       TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  current_step_id TEXT REFERENCES steps(id),
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (customer_id, course_id)
);

CREATE TABLE IF NOT EXISTS state_transitions (
  id             TEXT PRIMARY KEY,
  enrollment_id  TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  event_type     TEXT NOT NULL,
  from_step_id   TEXT REFERENCES steps(id),
  to_step_id     TEXT REFERENCES steps(id),
  problem        TEXT,
  resolution     TEXT,
  note           TEXT,
  source         TEXT NOT NULL DEFAULT 'coach',
  call_id        TEXT,
  created_at     INTEGER NOT NULL,
  UNIQUE (enrollment_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_transitions_enrollment ON state_transitions(enrollment_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_transitions_step ON state_transitions(to_step_id);

CREATE TABLE IF NOT EXISTS wallets (
  id                  TEXT PRIMARY KEY,
  customer_id         TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  creator_id          TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  paid_seconds        INTEGER NOT NULL DEFAULT 0,
  promotional_seconds INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL,
  UNIQUE (customer_id, creator_id)
);

CREATE TABLE IF NOT EXISTS ledger (
  id            TEXT PRIMARY KEY,
  wallet_id     TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  creator_id    TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  bucket        TEXT NOT NULL DEFAULT 'paid',
  seconds_delta INTEGER NOT NULL DEFAULT 0,
  cents_delta   INTEGER NOT NULL DEFAULT 0,
  reason        TEXT,
  call_id       TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_creator ON ledger(creator_id, created_at DESC);

CREATE TABLE IF NOT EXISTS promotional_budgets (
  id                       TEXT PRIMARY KEY,
  creator_id               TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  funded_seconds           INTEGER NOT NULL DEFAULT 0,
  consumed_seconds         INTEGER NOT NULL DEFAULT 0,
  per_customer_seconds_cap INTEGER NOT NULL DEFAULT 600,
  active                   INTEGER NOT NULL DEFAULT 1,
  created_at               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promo_creator ON promotional_budgets(creator_id, active);

CREATE TABLE IF NOT EXISTS promotional_grants (
  id           TEXT PRIMARY KEY,
  budget_id    TEXT NOT NULL REFERENCES promotional_budgets(id) ON DELETE CASCADE,
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  seconds      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (budget_id, customer_id)
);

CREATE TABLE IF NOT EXISTS calls (
  id                 TEXT PRIMARY KEY,
  xai_call_id        TEXT UNIQUE,
  creator_id         TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  customer_id        TEXT REFERENCES customers(id),
  enrollment_id      TEXT REFERENCES enrollments(id),
  from_number        TEXT,
  to_number          TEXT,
  status             TEXT NOT NULL DEFAULT 'ringing',
  end_reason         TEXT,
  started_at         INTEGER NOT NULL,
  connected_at       INTEGER,
  ended_at           INTEGER,
  billable_seconds   INTEGER NOT NULL DEFAULT 0,
  seconds_from_promo INTEGER NOT NULL DEFAULT 0,
  retail_cents       INTEGER NOT NULL DEFAULT 0,
  audio_in_ms        INTEGER NOT NULL DEFAULT 0,
  audio_out_ms       INTEGER NOT NULL DEFAULT 0,
  billed_text_items  INTEGER NOT NULL DEFAULT 0,
  cost_cents_estimate INTEGER NOT NULL DEFAULT 0,
  entry_step_id      TEXT REFERENCES steps(id),
  exit_step_id       TEXT REFERENCES steps(id)
);
CREATE INDEX IF NOT EXISTS idx_calls_creator ON calls(creator_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_customer ON calls(customer_id, started_at DESC);

CREATE TABLE IF NOT EXISTS call_events (
  id           TEXT PRIMARY KEY,
  call_id      TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  creator_id   TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  step_id      TEXT REFERENCES steps(id),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_events_call ON call_events(call_id);
CREATE INDEX IF NOT EXISTS idx_call_events_creator_type ON call_events(creator_id, type, created_at DESC);

CREATE TABLE IF NOT EXISTS escalations (
  id          TEXT PRIMARY KEY,
  creator_id  TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES customers(id),
  call_id     TEXT REFERENCES calls(id),
  step_id     TEXT REFERENCES steps(id),
  reason      TEXT NOT NULL,
  question    TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_escalations_creator ON escalations(creator_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id          TEXT PRIMARY KEY,
  creator_id  TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  phone_e164  TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_challenges(creator_id, phone_e164, created_at DESC);

CREATE TABLE IF NOT EXISTS mcp_sessions (
  token_hash    TEXT PRIMARY KEY,
  call_id       TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  creator_id    TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  customer_id   TEXT REFERENCES customers(id),
  enrollment_id TEXT REFERENCES enrollments(id),
  course_id     TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_call ON mcp_sessions(call_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  webhook_id TEXT PRIMARY KEY,
  event_type TEXT,
  seen_at    INTEGER NOT NULL
);

-- Metering for integrations that never hand this platform the live call.
--
-- The Durable Object in durable-objects/call-session.ts meters precisely, per
-- second, off a WebSocket it owns. That path is unreachable for a number
-- provisioned through xAI's console: no webhook, no call_id, and the MCP
-- transport is stateless (measured: 32 `initialize` requests for 17 tool
-- calls, and no mcp-session-id header at all), so there is no session object
-- and no connection whose lifetime maps to the call's.
--
-- What is observable is tool activity: which customer, and when. Consecutive
-- tool calls from one customer inside SESSION_GAP_SECONDS are treated as one
-- coaching session. `charged_seconds` is what has actually been taken from
-- the wallet; `observed_span_seconds` is first-to-last activity, which is a
-- LOWER BOUND on true call length — a caller who talks for two minutes
-- without triggering a tool is invisible. Billing therefore charges a floor
-- per session and tops up as observed activity exceeds it, and the gap
-- between charged and true duration is a known, deliberate undercharge
-- rather than an estimate presented as fact. See docs/BILLING.md.
CREATE TABLE IF NOT EXISTS coaching_sessions (
  id                    TEXT PRIMARY KEY,
  creator_id            TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  customer_id           TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  enrollment_id         TEXT REFERENCES enrollments(id),
  started_at            INTEGER NOT NULL,
  last_activity_at      INTEGER NOT NULL,
  tool_calls            INTEGER NOT NULL DEFAULT 0,
  charged_seconds       INTEGER NOT NULL DEFAULT 0,
  observed_span_seconds INTEGER NOT NULL DEFAULT 0,
  retail_cents          INTEGER NOT NULL DEFAULT 0,
  ended_reason          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_customer ON coaching_sessions(customer_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_creator ON coaching_sessions(creator_id, started_at DESC);

-- ============================================================ lead engine ==
--
-- A second product on the same platform, sharing `creators`. The phone coach
-- above serves people who already bought; everything below serves the ones who
-- have not — a cold prospect who found the creator through a video or podcast,
-- emailed a question, and has bought nothing.
--
-- That difference drives the shape of these tables. Curriculum above is indexed
-- by sequence, because a student knows which step they are on. Knowledge here
-- is indexed by *problem*, because a prospect arrives with a situation and no
-- idea which of two hundred videos addressed it.

-- Creator's paid products. Supplied by the creator directly and never
-- extracted from content: claiming an offer covers something it does not is
-- the fastest way to burn the creator's credibility with their own audience.
CREATE TABLE IF NOT EXISTS offers (
  id          TEXT PRIMARY KEY,
  creator_id  TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'course',
  name        TEXT NOT NULL,
  who_for     TEXT,
  covers      TEXT,
  price_text  TEXT,
  url         TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offers_creator ON offers(creator_id, active);

-- Free content, extracted and indexed by the problem it addresses.
--
-- `boundary` is the load-bearing column. It records where the free material
-- genuinely stops on this topic, and it is the only thing routing is allowed
-- to fire on. Without it the model would have to decide for itself when to
-- start selling, which is exactly the dishonesty that destroys the product.
-- NULL means the free content answers this fully — answer it and do not pitch.
CREATE TABLE IF NOT EXISTS knowledge_items (
  id                  TEXT PRIMARY KEY,
  creator_id          TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  problem             TEXT NOT NULL,
  who_for             TEXT,
  guidance            TEXT NOT NULL,
  framework_terms_json TEXT NOT NULL DEFAULT '[]',
  -- Creators repeat core ideas across dozens of videos; one concept collapses
  -- into one row carrying every place it was said.
  source_refs_json    TEXT NOT NULL DEFAULT '[]',
  source_quote        TEXT,
  boundary            TEXT,
  boundary_offer_id   TEXT REFERENCES offers(id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_creator ON knowledge_items(creator_id);

-- The lead record. Matched by sender address rather than mail thread, so
-- somebody writing again three weeks later with a fresh subject is still the
-- same person and their history loads.
CREATE TABLE IF NOT EXISTS prospects (
  id              TEXT PRIMARY KEY,
  creator_id      TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  name            TEXT,
  situation       TEXT,
  tried           TEXT,
  blocked_on      TEXT,
  objections_json TEXT NOT NULL DEFAULT '[]',
  topics_json     TEXT NOT NULL DEFAULT '[]',
  exchanges       INTEGER NOT NULL DEFAULT 0,
  hit_boundary    INTEGER NOT NULL DEFAULT 0,
  clicked_offer   INTEGER NOT NULL DEFAULT 0,
  score           INTEGER NOT NULL DEFAULT 0,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  UNIQUE (creator_id, email)
);
CREATE INDEX IF NOT EXISTS idx_prospects_creator ON prospects(creator_id, score DESC);

-- Full conversation, both directions. Token and cost columns are on the
-- outbound rows because this product pays for its own inference — cost per
-- conversation has to be a measured number before tiers are priced, not an
-- estimate discovered afterwards.
CREATE TABLE IF NOT EXISTS prospect_messages (
  id                TEXT PRIMARY KEY,
  prospect_id       TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  creator_id        TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  direction         TEXT NOT NULL,
  subject           TEXT,
  body              TEXT NOT NULL,
  routed_offer_id   TEXT REFERENCES offers(id) ON DELETE SET NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_micros   INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_prospect ON prospect_messages(prospect_id, created_at);

-- Attribution from day one: "did this make me money" is the question every
-- creator asks, and it is what justifies moving up a tier.
CREATE TABLE IF NOT EXISTS offer_clicks (
  id          TEXT PRIMARY KEY,
  creator_id  TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  prospect_id TEXT REFERENCES prospects(id) ON DELETE SET NULL,
  offer_id    TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  clicked_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clicks_creator ON offer_clicks(creator_id, clicked_at DESC);

-- Per-creator Gmail connection for the email transport. OAuth is per Gmail
-- account, so the refresh token lives here rather than as a Worker secret,
-- the same reasoning as phone_numbers.signing_secret being per-row instead
-- of global — one Google Cloud project's client id/secret are the only part
-- that's shared, and those live in Worker secrets alongside XAI_API_KEY.
--
-- history_id is Gmail's own sync cursor (see users.history.list): storing it
-- per connection is what lets polling ask "what's new since last time"
-- instead of re-scanning the whole inbox and re-processing old mail.
CREATE TABLE IF NOT EXISTS email_connections (
  id            TEXT PRIMARY KEY,
  creator_id    TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  gmail_address TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  history_id    TEXT NOT NULL,
  connected_at  INTEGER NOT NULL,
  UNIQUE(creator_id)
);

-- Semantic retrieval vector for the knowledge item, base64 Float32Array from
-- @cf/baai/bge-base-en-v1.5 (768 dims). NULL until indexed; retrieval falls
-- back to keyword scoring for un-indexed rows rather than skipping them.
-- Added after keyword-only retrieval was observed missing questions the
-- material genuinely answered, when the prospect's wording differed from the
-- creator's. See workers/leadgen/embeddings.ts.
ALTER TABLE knowledge_items ADD COLUMN embedding TEXT;

-- Ties an inbound email to the Gmail message that produced it, so the poller
-- can check "have I already answered this exact message" before processing
-- a candidate id. Needed because history.list candidates are deliberately
-- over-collected (see workers/email/gmail.ts) — a message can legitimately
-- resurface as a candidate on a later poll (e.g. its own read-state changing
-- after we reply to it), and without this check that would generate a
-- second reply to the same email.
ALTER TABLE prospect_messages ADD COLUMN source_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_source ON prospect_messages(creator_id, source_message_id);

-- Cheap compare-and-swap lock so an automatic Cron Trigger tick and a manual
-- /api/admin/email/poll (or two overlapping cron ticks, if a poll ever runs
-- long) cannot both process the same connection at once. Without this, two
-- concurrent polls each see the same "new" message before either has written
-- a row, both pass the source_message_id dedupe check, and both send a real
-- reply — observed live: the same inbound message answered twice, seconds
-- apart, with two different AI-generated replies to a real person.
ALTER TABLE email_connections ADD COLUMN locked_until INTEGER;

-- The sixth discovery dimension. situation/tried/blocked_on/objections cover
-- where someone is; `goal` is where they want to be, and the gap between the
-- two is what an offer actually closes — without it a pitch can only describe
-- a problem, never a destination. `last_asked_about` records which dimension
-- the previous reply probed, so an unanswered question is never re-asked:
-- repeating yourself is the single fastest way a conversation starts feeling
-- like an intake form.
ALTER TABLE prospects ADD COLUMN goal TEXT;
ALTER TABLE prospects ADD COLUMN last_asked_about TEXT;
