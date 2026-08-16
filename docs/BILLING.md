# Billing: what can actually be metered, and what cannot

Two integrations exist in this repo, and they have very different billing
accuracy. This matters commercially, so the difference is written down rather
than left to be rediscovered.

| | Webhook path (`src/`, and `workers/` DO) | Console path (live today) |
|---|---|---|
| Platform sees the live call | yes, owns the WebSocket | no |
| Call start/end known | exact | inferred |
| Duration accuracy | per second | lower bound |
| Enforcement | mid-call warning + hangup | refuse at next tool call |

## Why the console path can't meter precisely

Investigated against the live account on 2026-08-16. All findings are from
real API responses, not documentation:

**No usage or call API.** `/v1/realtime/calls` returns `403 Team is not
authorized to perform this action`. `/v1/agents` returns `403 agents endpoint
is not enabled for this team`. Every other candidate (`/v1/calls`,
`/v2/calls`, `/v2/call-logs`, `/v1/usage`, `/v2/usage`, `/v1/billing/usage`,
`/v2/conversations`, `/v2/sessions`, …) returns 404.

**Not a key-scope problem.** `GET /v1/api-key` shows this key holds
`api-key:model:*` and `api-key:endpoint:*` — full wildcard ACLs. The 403s are
account/team entitlements, so minting a broader key changes nothing. Getting
these enabled is a conversation with xAI, not a code change.

**No post-call webhook.** A console-provisioned number's API object has no
webhook field at all (`PATCH` rejects `webhook` as an unknown field; the
schema accepts only `phone_number`, `field_mask`, `team_id`). The only
documented webhook event anywhere is `realtime.call.incoming`, which belongs
to the SIP path this number cannot use.

**The MCP transport is stateless.** Measured across one real call: **32
`initialize` requests for 17 `tools/call` requests**, and no `mcp-session-id`
header on any of them. xAI opens a fresh connection per tool invocation. So
`initialize` is not a call-start signal, and there is no connection whose
lifetime maps to the call's.

## What is metered instead

`workers/billing/sessions.ts`. Tool activity is the only evidence the platform
receives that a call is happening, so billing hangs there:

- Tool calls from one customer within **5 minutes** of each other are one
  coaching session.
- Opening a session charges a **2-minute floor**, which also prevents
  unlimited free short calls.
- As a session's observed span passes what has been charged, the difference is
  charged, rounded up to the minute.
- When the wallet cannot cover it, `get_caller_state`, `get_current_step` and
  `diagnose_problem` return an out-of-credit instruction and the coach says a
  warm goodbye instead of coaching. `record_progress` is deliberately **not**
  gated — losing what a caller just achieved because their wallet emptied
  mid-call is a worse failure than a few free writes.

### The known inaccuracy, stated plainly

Observed span is a **lower bound** on true call length. A caller who talks for
two minutes without prompting a tool call is invisible, and time after the
final tool call is never seen. **This bills less than actual usage, never
more.** That direction is deliberate: undercharging is a smaller failure than
charging someone for time nobody can evidence.

Practically, the platform pays xAI for every real minute while only billing
for observed ones, so **margin on the console path is worse than the
`docs/COST-MODEL.md` figures suggest**. Those figures assume the webhook
path's exact metering. Do not use them to price this path without measuring
the gap first: compare `coaching_sessions.charged_seconds` against the call
durations shown in the xAI console for the same calls.

## Getting precise billing back

Three options, roughly in order of effort:

1. **Get the account entitlements enabled.** `/v1/realtime/calls` and
   `/v1/agents` already exist and are merely unauthorized for this team. If
   xAI enables them, real call records become readable and this whole module
   becomes a fallback.
2. **Move to a BYO SIP number.** A number brought in over SIP (Twilio, Telnyx)
   routed to `sip.voice.x.ai` restores the `realtime.call.incoming` webhook and
   the `call_id` session — which means `workers/durable-objects/call-session.ts`
   starts working, and it already meters per second, warns at low balance, and
   hangs up at zero. That code is built and tested; it is only unreachable
   because of how this number was provisioned. Adds ~$0.013–0.014/min of
   carrier cost (see docs/XAI-API-NOTES.md).
3. **Change the pricing model** to per-session or per-outcome, which the
   current implementation already supports — sessions are counted exactly even
   though their duration is not.
