# Cost model

> **Scope:** this document is about the *original* per-minute, retail-billed
> coaching-call product — the `'coach'`-purpose phone path (see
> [CLAUDE.md](../CLAUDE.md) for the two-products-in-one-Worker context). The
> current lead-gen product has no retail price floor or wallet to check
> margin against; its own cost tracking is per email reply
> (`prospect_messages.cost_usd_micros`) and per voice-escalation call
> (`calls.cost_cents_estimate`), with no revenue-attribution signal to
> compute margin from at all (see the README's "What's genuinely
> unfinished"). The token-cost engineering decisions below (retrieval
> through MCP rather than the prompt, one seeded text item, `response.create`
> for steering, `reasoning.effort: none`) are still the right instincts and
> partly still apply to the lead-gen product's own real-money xAI spend —
> just without this doc's retail-floor framing.

The target is **under $5/hour all-in** (~$0.083/min) against a retail floor of
$0.50/min. The margin is wide enough that the risk is not pricing — it is
discovering the cost side was never measured.

## What meters

| Meter | Billed? | Where it appears |
|---|---|---|
| Audio, per minute sent or received | **yes** | The call itself |
| `conversation.item.create` (text input) | **yes** | One seeded item per call |
| `function_call_output` (tool results) | no | Every retrieval |
| `response.create` | no | Every mid-call steer |

## Three decisions that follow from the table

**Retrieval goes through MCP, not the prompt.** Curriculum is never pasted into
`instructions` and never injected as a conversation item. It is fetched per turn
as tool output, which is exempt. This is the single biggest lever, and it
improves grounding at the same time — the coach reads the creator's actual
material rather than recalling a summary of it.

**Exactly one seeded text item per call.** `buildSeedContext()` produces one
short line of state ("Currently on Module 1, Step 2; unresolved problem from a
previous call: …") sent once at connect. Never per turn.

**Mid-call steering uses `response.create` instructions.** Low-balance warnings,
the final warning, and idle check-ins all ride on `response.create`, which is
exempt, instead of injecting billable conversation items. See
`buildNudgeInstructions()`.

**`reasoning.effort` defaults to `none`.** Most coaching turns are
retrieval-grounded rather than reasoning-heavy — the answer is in the step's
troubleshooting entry, not in a chain of inference. `none` is the default in
`session-config.ts`; `high` is one field away if calls come back worse.

## Measuring it for real

Every call writes both sides of the ledger to the `calls` row:

- `billable_seconds`, `retail_cents` — what the customer paid
- `audio_in_ms`, `audio_out_ms`, `billed_text_items`, `cost_cents_estimate` —
  what it cost

`marginFor()` in `billing/pricing.ts` turns a row into cost-per-hour and margin
percent. The dashboard surfaces cost per hour directly.

```sql
-- Real cost per hour across full-length calls
SELECT
  ROUND(AVG(cost_cents_estimate * 3600.0 / NULLIF(billable_seconds, 0)) / 100.0, 2) AS cost_per_hour,
  ROUND(AVG(retail_cents * 3600.0 / NULLIF(billable_seconds, 0)) / 100.0, 2) AS retail_per_hour,
  COUNT(*) AS calls
FROM calls
WHERE status = 'ended' AND billable_seconds > 120;
```

**Do this before onboarding creator #2.** The number to trust is measured across
real full-length calls with real retrieval — not a two-minute test call, and not
the assumed rate in `PLATFORM_AUDIO_COST_PER_MINUTE_CENTS`, which exists only so
reporting has something to fall back on.

One caveat worth knowing: on a SIP session, audio never crosses our WebSocket,
so per-call audio duration events may not arrive at all. When they don't, cost
falls back to wall-clock seconds at the configured rate — honest, but an
estimate. Reconcile against an actual xAI invoice once before trusting the
dashboard's margin figure.

## Costs that are easy to forget

- **Answering an unknown number costs money.** Unrecognised callers are capped
  hard (45s with no trial funding, 90s with) and coach nothing. The cap is in
  `telephony/call-router.ts`.
- **Callers who are out of credit still get answered** for up to 60s so they
  hear a warm goodbye instead of a disconnect. That is a real per-call cost.
- **Trial minutes are the creator's money, not the platform's.** No funded
  budget means no trial, enforced in `billing/promotional.ts`.
