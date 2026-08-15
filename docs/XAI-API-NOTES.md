# xAI Voice API — what is verified, and what is not

Notes taken while building against the Voice Agent API, kept because several
details are load-bearing and a few are genuinely ambiguous in the published
docs. Anything marked **unverified** has not been exercised against a live call
and should be confirmed on the first real one.

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
