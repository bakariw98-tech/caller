-- Caller schema.
--
-- Multi-tenant from day one even though v1 onboards a single creator by hand.
-- Retrofitting creator_id onto a live wallet/ledger is the kind of migration
-- that corrupts money, so every customer-facing row carries its tenant.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- creators --

CREATE TABLE IF NOT EXISTS creators (
  id                    TEXT PRIMARY KEY,
  slug                  TEXT NOT NULL UNIQUE,
  -- Customer-facing identity. Every one of these belongs to the creator; the
  -- platform's own name appears on none of them.
  business_name         TEXT NOT NULL,
  coach_name            TEXT NOT NULL,
  coach_voice           TEXT NOT NULL DEFAULT 'eve',
  brand_json            TEXT NOT NULL DEFAULT '{}',
  welcome_message       TEXT,
  -- Coaching behaviour, captured in the creator's words during onboarding.
  outcome               TEXT,
  audience              TEXT,
  methodology           TEXT,
  teaching_style        TEXT,
  always_do_json        TEXT NOT NULL DEFAULT '[]',
  never_do_json         TEXT NOT NULL DEFAULT '[]',
  ask_questions_when    TEXT,
  escalation_policy     TEXT NOT NULL DEFAULT 'offer_human',
  escalation_phone      TEXT,
  -- Economics. Enforced against the platform floor on write.
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
  -- Returned exactly once at provisioning time and unrecoverable afterwards.
  signing_secret      TEXT NOT NULL,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phone_numbers_creator ON phone_numbers(creator_id);

-- -------------------------------------------------------------- curriculum --
-- Structure is the product. A flattened blob would answer questions; this tree
-- is what lets the coach know which step a caller is standing on.

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
  -- Course-wide ordering, so "what's next" crosses lesson and module edges.
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

-- Common problems and their fixes, attached to the step where they bite.
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

-- Free-standing material that is not a step: FAQs, glossary, principles.
CREATE TABLE IF NOT EXISTS references_docs (
  id         TEXT PRIMARY KEY,
  course_id  TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'reference'
);
CREATE INDEX IF NOT EXISTS idx_reference_docs_course ON references_docs(course_id);

-- Lexical search index. Rows are typed so retrieval can prefer a troubleshooting
-- entry over prose when the caller reports a symptom.
CREATE VIRTUAL TABLE IF NOT EXISTS curriculum_fts USING fts5(
  body,
  title,
  course_id UNINDEXED,
  ref_kind UNINDEXED,
  ref_id UNINDEXED,
  step_id UNINDEXED,
  tokenize = 'porter unicode61'
);

-- --------------------------------------------------------------- customers --

CREATE TABLE IF NOT EXISTS customers (
  id                TEXT PRIMARY KEY,
  creator_id        TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  name              TEXT,
  phone_e164        TEXT NOT NULL,
  verified_at       INTEGER,
  preferences_json  TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL,
  -- A number identifies an account only within one creator's coach.
  UNIQUE (creator_id, phone_e164)
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_e164);

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

-- The heart of the coaching model: transitions, not transcripts.
--
-- "Customer asked about step 4" is a log line. "Was at step 4 -> hit problem X
-- -> resolved X -> ready for step 5" is a model of where somebody is, and it is
-- what lets Thursday's call continue Monday's without the caller re-explaining.
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

-- ----------------------------------------------------------------- billing --

CREATE TABLE IF NOT EXISTS wallets (
  id                  TEXT PRIMARY KEY,
  customer_id         TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- Denormalised so the "credits never cross creators" invariant is checkable
  -- in a single row rather than through a join.
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

-- A creator prepays a pool; their audience's free trials draw only from it.
-- No pool, no trial. The platform never fronts the cost.
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

-- Per-account grant record, so abuse limits bind to a verified identity rather
-- than to a call.
CREATE TABLE IF NOT EXISTS promotional_grants (
  id           TEXT PRIMARY KEY,
  budget_id    TEXT NOT NULL REFERENCES promotional_budgets(id) ON DELETE CASCADE,
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  seconds      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (budget_id, customer_id)
);

-- ------------------------------------------------------------------- calls --

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
  -- What the customer is charged on: wall-clock seconds of connected session.
  billable_seconds   INTEGER NOT NULL DEFAULT 0,
  seconds_from_promo INTEGER NOT NULL DEFAULT 0,
  retail_cents       INTEGER NOT NULL DEFAULT 0,
  -- What xAI charges us, measured from real audio rather than assumed, so
  -- margin can be verified on real calls instead of trusted.
  audio_in_ms        INTEGER NOT NULL DEFAULT 0,
  audio_out_ms       INTEGER NOT NULL DEFAULT 0,
  billed_text_items  INTEGER NOT NULL DEFAULT 0,
  cost_cents_estimate INTEGER NOT NULL DEFAULT 0,
  entry_step_id      TEXT REFERENCES steps(id),
  exit_step_id       TEXT REFERENCES steps(id)
);
CREATE INDEX IF NOT EXISTS idx_calls_creator ON calls(creator_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_customer ON calls(customer_id, started_at DESC);

-- Structured events for analytics. Deliberately not a conversation transcript:
-- what the dashboard needs is where people get stuck, not what they said.
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

-- ---------------------------------------------------------------- identity --

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

-- Per-call bearer tokens handed to xAI so its server-side MCP calls arrive
-- already scoped to one caller. The model never sees or supplies a customer id.
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

-- Replay protection for inbound webhooks.
CREATE TABLE IF NOT EXISTS webhook_events (
  webhook_id TEXT PRIMARY KEY,
  event_type TEXT,
  seen_at    INTEGER NOT NULL
);
