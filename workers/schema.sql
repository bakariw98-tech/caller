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
  preferences_json  TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL,
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
