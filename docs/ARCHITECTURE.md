# Architecture

## The call, end to end

```
  Student's phone
        │  dials the coach's number
        ▼
  xAI  ──── realtime.call.incoming (signed webhook) ────▶  POST /webhooks/xai
        │                                                       │
        │                                                  verify signature (raw bytes)
        │                                                  claim webhook id (no double-answer)
        │                                                  identify caller by caller ID
        │                                                  check credits / grant trial
        │                                                  mint per-call MCP token
        │                                                       │
        ◀──── WebSocket wss://api.x.ai/v1/realtime?call_id= ────┘
        │        session.update  (instructions + MCP tool, token embedded)
        │        conversation.item.create  ← exactly one, billable
        │        response.create           ← exempt, used for all steering
        │
        │  ── audio stays between xAI and the phone; it never reaches us ──
        │
        └──── HTTPS ────▶  POST /mcp   (xAI calls our tools directly)
                              get_caller_state · get_current_step
                              get_step_by_position · search_curriculum
                              diagnose_problem · record_progress · request_human
```

Two things about this shape are easy to get wrong and worth stating plainly.

**We are a control channel, not a media relay.** For a SIP `call_id` session xAI
terminates the phone leg itself. No audio crosses our WebSocket, so there is no
codec to negotiate and no frames to forward — the socket carries configuration,
steering and teardown.

**Tool calls arrive as inbound HTTP, not as socket events.** MCP tools on the
Voice Agent API are server-side: xAI connects to `/mcp` on its own. That is why
the endpoint is public, why each request authenticates independently, and why a
live call registers itself in `telephony/registry.ts` — a transfer request
arrives over HTTP and has to reach the call object that owns the socket.

## Module map

| Path | Responsibility |
|---|---|
| `curriculum/` | Parse the authoring format, audit the structure, store the tree, retrieve from it |
| `state/` | Transitions, position, progress summaries |
| `coach/` | Instructions and session configuration |
| `mcp/` | Per-call tokens, tool definitions and handlers, JSON-RPC endpoint |
| `telephony/` | Webhook routing, live call lifecycle, metering, registry |
| `billing/` | Wallets, ledger, promotional budgets, price floor |
| `identity/` | Caller ID lookup, SMS OTP account linking |
| `analytics/` | Coach performance and curriculum intelligence |
| `web/` | White-labeled customer pages, creator dashboard |
| `xai/` | REST client, webhook verification |

## Why the curriculum is a tree

`Course → Module → Lesson → Step`, with each step carrying instructions, an
expected result, completion criteria, and the problems the creator documented
for it. Steps also carry a course-wide `global_seq`, so "what's next" crosses
lesson and module boundaries rather than dead-ending.

A flat knowledge base would answer questions. It would not let the coach say
"you're on step four, your result should look like X, and the thing that usually
goes wrong here is Y" — which is the entire product. `auditStructure()` treats a
step with no instructions or no expected result as a **blocking** error and
refuses to publish, because that is what silent flattening looks like from the
inside.

## Why state is transitions, not history

`state_transitions` records what changed:

```
was at step 4 → hit problem X → resolved X → advanced to step 5
```

Not "customer asked about step 4". The enrollment row caches the current
position, but every write goes through `appendTransition()` so the cache cannot
drift from the log. Only events that genuinely relocate someone move the cursor
— hitting a problem does not, because they are still standing on the same step.

This is what makes Thursday's call continue Monday's without the caller
re-explaining themselves.

## Why tools carry no caller identifier

Every MCP tool is scoped by the bearer token minted for that one call. No tool
accepts a `customer_id` or `creator_id` argument, so there is no argument for
the model to get wrong, be talked into changing, or use to reach another
caller's record. Scope arrives with the credential, and the token is revoked
when the call ends.

Curriculum queries are scoped by `course_id` in the SQL itself rather than
filtered afterwards, so one creator's material can never surface in another
creator's call.

## Identity

Caller ID *identifies*; it never *authenticates*. An unverified row is treated
as a stranger, and an unrecognised number gets a short, bounded call that
reveals nothing about anyone's account. Linking a number to an account requires
an SMS code (`identity/otp.ts`).

Note that SMS needs a provider — xAI sends voice, not messages. The provider sits
behind a one-method interface (`identity/sms.ts`) and defaults to printing codes
to stdout in development.

## Where the money is counted

Two meters, deliberately separate:

- **Retail** — wall-clock seconds of connected call, charged against the
  customer's wallet at the creator's per-minute rate.
- **Cost** — what xAI bills us, measured from audio where the events are
  available and falling back to wall clock otherwise.

Keeping both on the `calls` row is what makes margin checkable on real calls
rather than assumed. See [COST-MODEL.md](./COST-MODEL.md).
