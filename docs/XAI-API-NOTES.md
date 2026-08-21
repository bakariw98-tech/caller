# xAI Voice API — what is verified, and what is not

Notes taken while building against the Voice Agent API, kept because several
details are load-bearing and a few are genuinely ambiguous in the published
docs. Anything marked **unverified** has not been exercised against a live call
and should be confirmed on the first real one.

Applies equally to both call purposes this product uses the same realtime
Voice API for — the original coaching product's `'coach'`-purpose calls and
the current lead-gen product's `'qualify'`-purpose voice-escalation calls
(see [CLAUDE.md](../CLAUDE.md)). The mechanics below (webhook signing, the
SIP `call_id` session shape, MCP tools arriving as inbound HTTP) are
identical either way; only the prompt/tool set on the other end differs.

## Confirmed against the real API: number provisioning is console-only

**`POST /v2/phone-numbers` returns `403` on this account**, despite being the
documented way to provision a number:

```
{"code":"The caller does not have permission to execute the specified operation",
 "error":"Provisioning SpaceXAI phone numbers via the API is not supported.
          Use the console (Voice Agents) instead."}
```

Confirmed 2026-08-16 against production, with a real `XAI_API_KEY`, from the
deployed Worker — not a docs read, an actual rejected request. Whether this is
an account-tier restriction or the documented endpoint no longer matching
reality isn't knowable from here; either way, the working path today is the
xAI console (Voice Agents section), then registering the result with this
app via `POST /api/creators/:id/phone-number/manual` — see docs/DEPLOY.md.
The Node build's `npm run provision` and the Worker's
`/api/creators/:id/phone-number` (API-attempt version) are left in place since
they match the docs and may work on other accounts, but don't assume they will
work on yours without testing first.

Sources:
- <https://docs.x.ai/developers/model-capabilities/audio/voice-agent/sip>
- <https://docs.x.ai/developers/model-capabilities/audio/voice-agent>
- <https://docs.x.ai/developers/rest-api-reference/inference/voice>

## Inbound only, which is what this product needs

There is no xAI endpoint that originates a call — no equivalent of Retell's
`createPhoneCall` or LiveKit's `CreateSIPParticipant`. The documented surface is:
register a number, receive `realtime.call.incoming`, connect a WebSocket with
the `call_id`.

This product is inbound by design — students call their coach — so the "no
Twilio" decision holds. It is worth being explicit that this is a constraint
rather than a preference: **if outbound calling is ever added to the roadmap**
(coach calls you for a check-in, say), it cannot be built on xAI alone. It would
need a third-party originator (Twilio Elastic SIP Trunking or Telnyx) placing
the PSTN call and bridging the SIP leg to `sip:{number}@sip.voice.x.ai`, with
xAI still handling only the conversation. That is a new vendor, a new account,
and roughly $0.013–0.014/min of extra telephony cost on top of xAI's rate.

## The control channel is not a media relay

For a SIP `call_id` session, xAI terminates the phone leg itself. The WebSocket
carries configuration and events — **no audio crosses it**. This is the opposite
of the Media Streams pattern in the cookbook's Twilio example, where the server
relays every frame.

Consequences that shaped the code:
- No audio format is set in `session.update` (`src/coach/session-config.ts`).
- Metering uses wall-clock time as the authoritative meter, not frame counts
  (`src/telephony/call-session.ts`).

## MCP tools are server-side

xAI connects to the MCP endpoint itself rather than routing tool calls back down
the WebSocket. So:
- `/mcp` must be publicly reachable over HTTPS, same as the webhook.
- Every request authenticates independently — hence the per-call bearer token.
- Tool results never touch our socket, and are exempt from the text-input meter.

Verified working against `POST /mcp` with JSON-RPC `initialize`, `tools/list`,
`tools/call`. Protocol version pinned to `2025-06-18`.

## Ambiguities — confirm these on the first live call

| Item | What the code assumes | Why it is uncertain |
|---|---|---|
| `reasoning.effort` | Sent as a flat dotted key on `session`, per the docs' example | Unusual shape; a nested `reasoning: { effort }` would be more conventional. If the setting appears not to take effect, try nesting it. |
| `input_audio_buffer.timeout_triggered` | Handled as the idle-timeout event, driving a check-in | Named in the product brief and `idle_timeout_ms` is documented, but the event itself was not found in the published event list. Handler is harmless if the event never fires. |
| Audio duration events | `response.audio.done` / `input_audio_buffer.committed` read for `duration_ms` when present | Not confirmed these fire on SIP sessions, where media bypasses the socket. Code falls back to wall clock so cost reporting stays honest rather than reporting zero. |
| `POST /v2/phone-numbers` response fields | Reads `phone_number`, falling back to `e164` / `number`; reads `sip_host`, `webhook_id`, `signing_secret` | The full response schema was not retrievable from the docs. `provision-number.ts` prints the raw response and refuses to store a number whose signing secret it cannot find. |
| Webhook signature scheme | Standard Webhooks: HMAC-SHA256 over `{id}.{timestamp}.{body}`, `whsec_`-prefixed base64 secret | Docs name the three headers but not the construction. This is the Standard Webhooks spec, which the header names imply. |

## Facts worth not rediscovering

- The webhook signing secret is returned **once** at number creation. There is
  no recovery path; a lost secret means re-provisioning. `provision-number.ts`
  persists it in the same call that creates the number.
- Ephemeral client secrets (`POST /v1/realtime/client_secrets`) do **not** work
  for SIP `call_id` sessions — those authenticate with the account API key, so
  the key stays server-side.
- `POST /v1/realtime/calls/{id}/refer` takes `target_uri`, with `tel:` for PSTN.
  Human escalation is native; there is nothing to build for it.
- `POST /v1/realtime/calls/{id}/hangup` takes no body.
- Signature verification must run against the **raw** request bytes. Fastify is
  configured to retain them (`src/index.ts`), since re-serialising parsed JSON
  changes key order and whitespace and fails every time.

## Untested: `byo_trunk` may not be blocked (deferred, 2026-08-16)

**Status: hypothesis, not a finding.** Written down so it isn't re-derived;
nothing below has been run against the API.

The 403 that pushed this project onto the console-managed path was narrower
than it first read:

```
Provisioning SpaceXAI phone numbers via the API is not supported.
Use the console (Voice Agents) instead.
```

"SpaceXAI phone numbers" names xAI-*owned* numbers specifically.
`createPhoneNumber()` in `workers/xai/client.ts` hardcodes
`origin: 'xai_provisioned'`, which is exactly what that sentence refuses — so
**`origin: 'byo_trunk'` has never actually been attempted.** It may be
permitted. It may equally 403; nobody has checked.

Why it would matter if it works: the SIP docs describe `byo_trunk` as
delivering a `realtime.call.incoming` webhook and letting you connect your
own WebSocket by `call_id` — **no console agent involved**. That is the
architecture already built and tested here (`workers/routes/webhook.ts` →
`workers/telephony/call-router.ts` → `workers/durable-objects/call-session.ts`),
currently unreachable only because the live number is console-managed. It
would simultaneously restore automatic per-creator provisioning, remove the
hand-pasted console instructions, restore caller ID (making the passcode a
fallback rather than the only mechanism), and re-enable the per-second
metering in `CallSessionDO` that `docs/BILLING.md` documents as impossible
on the current path.

Cheapest possible test, and the gate on all of the above: one
`POST /v2/phone-numbers` with `origin: 'byo_trunk'` on the existing key. If
it 403s too, the approach is dead and the remaining option is asking xAI to
lift the account restrictions.

### Entitlements vs. capabilities

Worth separating, since it changes who can fix what. These failures are
**account-tier switches on xAI's side**, not missing endpoints and not
something a differently-scoped key reaches — the key in use already carries
wildcard ACLs (`api-key:endpoint:*`):

| Endpoint | Response | Reading |
|---|---|---|
| `/v1/agents` | 403 `agents endpoint is not enabled for this team` | Exists, disabled for this team |
| `/v1/realtime/calls` | 403 `Team is not authorized to perform this action` | Exists, disabled for this team |
| `/v2/agents`, `/v2/calls`, `/v2/usage`, `/v1/webhooks` | 404 | Do not exist under those paths |
