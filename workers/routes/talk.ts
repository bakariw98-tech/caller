import { Hono } from 'hono';
import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { loadAppConfig } from '../env.js';
import { now } from '../../src/util/ids.js';
import type { Creator } from '../../src/domain/types.js';
import { resolveToken } from '../mcp/auth.js';
import { QUAL_TOOL_SET } from '../telephony/qualification-call.js';
import { triggerQualificationFollowup } from '../telephony/qualification-followup.js';
import { buildQualCallInstructions } from '../leadgen/call-prompt.js';
import { loadFullOffers } from '../leadgen/reply.js';
import { buildSessionUpdate, buildSeedItem, buildResponseCreate } from '../coach/session-config.js';
import { mintEphemeralClientSecret } from '../xai/client.js';

export const talkRoute = new Hono<{ Bindings: Env }>();

/**
 * The browser counterpart to a real phone call — see
 * workers/telephony/qualification-call.ts's startWebQualificationCall()
 * for why this exists (this account's only live number is
 * console-managed, bypassing our webhook path entirely, so testing the
 * qualification call's actual logic needed a route that does not depend
 * on telephony at all). The link itself carries the auth — same trust
 * model the dashboard already uses (a key in the URL), not a new pattern.
 *
 * Connection shape confirmed against docs.x.ai (2026-08-19), after a real
 * first attempt: this is a plain WebSocket, NOT WebRTC/SDP (that was this
 * repo's first, wrong guess — the SIP path's fetch()-based Upgrade uses a
 * server-side Authorization header, which does not exist for a browser).
 * A browser cannot set WebSocket headers at all, so the ephemeral secret
 * goes in the connection's subprotocol list, prefixed `xai-client-secret.`.
 * Audio is base64 PCM16 (24kHz, little-endian) carried as
 * `input_audio_buffer.append` (send, payload in `audio`) /
 * `response.output_audio.delta` (receive, payload in `delta` — NOT `audio`,
 * confirmed by driving the real handshake directly from Node and logging
 * every field on a live event, after this file's own first guess at the
 * field name silently produced zero-length audio for several fixes in a
 * row) JSON events over the same socket — there is no SIP leg here for
 * xAI to terminate itself, so unlike the phone path, audio DOES cross
 * this channel.
 */
async function buildTalkSession(
  db: ReturnType<typeof wrapD1>,
  env: Env,
  callId: string,
  token: string,
): Promise<
  | { ok: true; businessName: string; realtimeBase: string; model: string; ephemeralSecret: string; sessionUpdate: Record<string, unknown>; seedItem: Record<string, unknown>; responseCreate: Record<string, unknown> }
  | { ok: false; status: 401 | 404 | 502; message: string }
> {
  const resolved = await resolveToken(db, env.MCP_TOKEN_SECRET, token ? `Bearer ${token}` : undefined);
  if (!resolved || resolved.kind !== 'qualify' || resolved.session.call_id !== callId) {
    return { ok: false, status: 401, message: 'This link is invalid or has expired.' };
  }

  const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(resolved.session.creator_id);
  if (!creator) return { ok: false, status: 404, message: 'Creator not found.' };

  const posture = await db
    .prepare('SELECT objection_handling_posture FROM creators WHERE id = ?')
    .get<{ objection_handling_posture: 'soft' | 'assertive' }>(creator.id);
  const offers = await loadFullOffers(db, creator.id);
  const instructions = buildQualCallInstructions({ creator, offers, objectionPosture: posture?.objection_handling_posture ?? 'soft' });

  // Minted at page-render time, not at link-creation time — these expire
  // in roughly a minute, so baking one into a link that might sit unopened
  // for a while would just hand back an expired secret.
  let secret: { value: string; expiresAt: number };
  try {
    secret = await mintEphemeralClientSecret(env.XAI_API_BASE, env.XAI_API_KEY);
  } catch (err) {
    console.error('failed to mint ephemeral client secret', err);
    return { ok: false, status: 502, message: 'Could not start a live session with the voice API right now. Try again in a moment.' };
  }

  const mcpUrl = `${env.PUBLIC_BASE_URL}/mcp`;
  const sessionUpdate = buildSessionUpdate({
    instructions,
    voice: creator.coach_voice,
    mcpToken: token,
    mcpUrl,
    reasoningEffort: 'none',
    idleTimeoutMs: loadAppConfig(env).idleTimeoutMs,
    toolSet: QUAL_TOOL_SET,
  }) as { session: Record<string, unknown> } & Record<string, unknown>;
  // Explicit rather than relying on the documented default (24kHz PCM) —
  // this only matters for a WebSocket session like this one; the SIP path
  // never sets it at all since no audio crosses that channel. Named
  // explicitly here rather than folded into buildSessionUpdate() itself,
  // which the phone path also calls and must not grow a talk.ts-only field.
  sessionUpdate.session.audio = { output: { format: { type: 'audio/pcm', rate: 24000 } } };
  const seedItem = buildSeedItem("You're on a qualification call. Greet them warmly and ask for the short code from their invite email.");
  const responseCreate = buildResponseCreate();

  return {
    ok: true,
    businessName: creator.business_name,
    // Same host as the SIP path's own outbound connection (XAI_REALTIME_HOST
    // is the bare host, kept separate from XAI_API_BASE for exactly this
    // reuse) — but wss://, a real client-side WebSocket, not the server-side
    // fetch()-with-Upgrade-header trick call-session.ts uses.
    realtimeBase: `wss://${env.XAI_REALTIME_HOST}/v1/realtime`,
    model: env.XAI_VOICE_MODEL,
    ephemeralSecret: secret.value,
    sessionUpdate,
    seedItem,
    responseCreate,
  };
}

talkRoute.get('/talk/:callId', async (c) => {
  const db = wrapD1(c.env.DB);
  const callId = c.req.param('callId');
  const token = c.req.query('token') ?? '';

  const session = await buildTalkSession(db, c.env, callId, token);
  if (!session.ok) return c.text(session.message, session.status);

  return c.html(renderTalkPage({ callId, token, ...session }));
});

/**
 * DIAGNOSTIC — not part of the product surface. Returns the exact same
 * session artifacts the HTML page embeds, as JSON, so the actual WebSocket
 * handshake with xAI can be driven directly from a plain script (this
 * sandbox cannot launch a networked headless browser to click through the
 * real page — see the investigation this was added during). Same auth as
 * the page itself: the call's own token, nothing more sensitive exposed.
 */
talkRoute.get('/talk/:callId/raw', async (c) => {
  const db = wrapD1(c.env.DB);
  const callId = c.req.param('callId');
  const token = c.req.query('token') ?? '';

  const session = await buildTalkSession(db, c.env, callId, token);
  if (!session.ok) return c.json({ error: session.message }, session.status);
  return c.json(session);
});

talkRoute.post('/talk/:callId/end', async (c) => {
  const db = wrapD1(c.env.DB);
  const callId = c.req.param('callId');
  const auth = c.req.header('Authorization');

  const resolved = await resolveToken(db, c.env.MCP_TOKEN_SECRET, auth);
  if (!resolved || resolved.kind !== 'qualify' || resolved.session.call_id !== callId) {
    return c.json({ error: 'invalid session' }, 401);
  }

  await db.prepare("UPDATE calls SET status = 'ended', ended_at = ? WHERE id = ? AND status != 'ended'").run(now(), callId);

  await triggerQualificationFollowup(db, c.env, callId, resolved.session.creator_id).catch((err) =>
    console.error('qualification follow-up failed (web test call)', callId, err),
  );

  return c.json({ ok: true });
});

// Exported for tests/talk.test.ts, which parses the embedded <script> with
// new Function() to catch a JS syntax error before it reaches a browser —
// see workers/routes/dashboard.ts's own PAGE export and its test for why
// this matters here specifically: a backtick inside a JS comment nested
// inside this outer TS template literal broke this exact file once
// already this session, the same trap that broke the dashboard earlier.
export function renderTalkPage(params: {
  callId: string;
  token: string;
  realtimeBase: string;
  model: string;
  ephemeralSecret: string;
  sessionUpdate: Record<string, unknown>;
  seedItem: Record<string, unknown>;
  responseCreate: Record<string, unknown>;
  businessName: string;
}): string {
  // Payloads are JSON-serialised server-side and dropped into the page as
  // data — never string-concatenated into the JS itself — so nothing in
  // an offer's or creator's own text can break out of the script.
  const data = JSON.stringify({
    realtimeBase: params.realtimeBase,
    model: params.model,
    ephemeralSecret: params.ephemeralSecret,
    sessionUpdate: params.sessionUpdate,
    seedItem: params.seedItem,
    responseCreate: params.responseCreate,
    callId: params.callId,
    token: params.token,
  });

  return /* html */ `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test call — ${escapeHtml(params.businessName)}</title>
<style>
  body { font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 30rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1c; text-align: center; }
  button { font: inherit; font-weight: 600; padding: .8rem 1.6rem; border-radius: 999px; border: none; background: #1a1a1c; color: #fff; cursor: pointer; margin-top: 1.5rem; }
  button:disabled { opacity: .5; }
  button.hang { background: #b3261e; }
  #status { color: #6d6d72; margin-top: 1rem; min-height: 1.4em; }
</style>
</head><body>
<h2>Test the qualification call</h2>
<p>A real, live conversation with ${escapeHtml(params.businessName)}'s qualification agent — no phone number needed.
This uses your microphone.</p>
<button id="start">Start talking</button>
<button id="hang" class="hang" style="display:none">Hang up</button>
<div id="status"></div>
<audio id="out" autoplay playsinline></audio>
<script>
(function () {
  var DATA = ${data};
  var SAMPLE_RATE = 24000; // fixed by the API — see docs.x.ai, "24000 Hz (Default)"
  var el = { start: document.getElementById('start'), hang: document.getElementById('hang'), status: document.getElementById('status'), out: document.getElementById('out') };
  var ws = null, ended = false;
  var micStream = null, micNode = null;
  // ONE shared AudioContext for both mic capture and playback, created and
  // resumed synchronously inside the click handler below — not lazily on
  // the first incoming audio chunk. That was an earlier bug: a context
  // created later, inside an async WebSocket message handler, falls
  // outside the browser's user-gesture chain and several browsers leave it
  // permanently 'suspended' with no error at all — audio decodes and
  // queues fine, it just never actually plays. Creating + resuming it
  // here, in direct response to the click, is what autoplay policies
  // require.
  var audioCtx = null, nextPlayTime = 0;
  // Playback is routed through a MediaStreamDestination -> a real <audio>
  // element (#out), not straight to audioCtx.destination. On a phone this
  // is not cosmetic: the moment a page captures the mic, iOS/Android
  // default the whole page's audio session into "phone call" mode and
  // route playback to the EARPIECE instead of the speaker — silent, no
  // error, exactly the symptom reported live ("I can't hear it"). Playing
  // through an actual <audio> element sidesteps that routing; raw
  // AudioContext output does not.
  var playDest = null;

  function setStatus(s) { el.status.textContent = s; }

  el.start.onclick = function () {
    el.start.disabled = true;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    nextPlayTime = audioCtx.currentTime;
    playDest = audioCtx.createMediaStreamDestination();
    el.out.srcObject = playDest.stream;
    el.out.play().catch(function () {});
    audioCtx.resume().catch(function () {});
    connect().catch(function (e) { setStatus('Could not connect: ' + e.message); el.start.disabled = false; });
  };

  el.hang.onclick = function () { endCall(); };
  window.addEventListener('beforeunload', function () {
    if (!ended && navigator.sendBeacon) {
      navigator.sendBeacon('/talk/' + DATA.callId + '/end', new Blob([JSON.stringify({})], { type: 'application/json' }));
    }
  });

  // --- base64 <-> PCM16 helpers ---
  function base64FromInt16(int16arr) {
    var bytes = new Uint8Array(int16arr.buffer, int16arr.byteOffset, int16arr.byteLength);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function int16FromBase64(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Int16Array(bytes.buffer);
  }

  var heardAudio = false;

  function playChunk(base64Audio) {
    if (!heardAudio) { heardAudio = true; setStatus('Hearing the agent — talk anytime.'); }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
    var pcm = int16FromBase64(base64Audio);
    var buf = audioCtx.createBuffer(1, pcm.length, SAMPLE_RATE);
    var ch = buf.getChannelData(0);
    for (var i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    var src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(playDest);
    var startAt = Math.max(nextPlayTime, audioCtx.currentTime);
    src.start(startAt);
    nextPlayTime = startAt + buf.duration;
  }

  async function connect() {
    setStatus('Requesting microphone…');
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    setStatus('Connecting…');
    // Browsers cannot set WebSocket headers at all, so the ephemeral
    // secret travels as a subprotocol entry instead — see docs.x.ai.
    var url = DATA.realtimeBase + '?model=' + encodeURIComponent(DATA.model);
    ws = new WebSocket(url, ['xai-client-secret.' + DATA.ephemeralSecret]);

    ws.onopen = function () {
      setStatus('Connected — say hello.');
      ws.send(JSON.stringify(DATA.sessionUpdate));
      ws.send(JSON.stringify(DATA.seedItem));
      ws.send(JSON.stringify(DATA.responseCreate));
      el.hang.style.display = 'inline-block';
      startMic();
    };
    ws.onmessage = function (evt) {
      var msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      if (msg.type === 'response.output_audio.delta' || msg.type === 'response.audio.delta') {
        // The base64 PCM payload lives under 'delta' — confirmed by driving
        // this exact handshake directly from Node against the real API,
        // logging every field name on a live audio-delta event. There is
        // no 'audio' field on this event at all; that was this file's own
        // wrong guess from an ambiguous docs summary, not a config or
        // routing problem — every earlier fix in this file was real, this
        // was simply reading the wrong key the entire time.
        if (msg.delta) playChunk(msg.delta);
      } else if (msg.type === 'error') {
        setStatus('Error: ' + (msg.error && msg.error.message ? msg.error.message : JSON.stringify(msg.error)));
      }
      console.log('event', msg.type, msg);
    };
    ws.onerror = function () { setStatus('Connection error — check the browser console for detail.'); };
    ws.onclose = function (evt) {
      if (!ended) setStatus('Disconnected (code ' + evt.code + (evt.reason ? ': ' + evt.reason : '') + ').');
      stopMic();
    };
  }

  function startMic() {
    var source = audioCtx.createMediaStreamSource(micStream);
    // ScriptProcessorNode is deprecated but universally supported and
    // simple to reason about — good enough for a test tool; a real
    // product surface would move to an AudioWorklet.
    micNode = audioCtx.createScriptProcessor(4096, 1, 1);
    micNode.onaudioprocess = function (evt) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      var input = evt.inputBuffer.getChannelData(0);
      var pcm = new Int16Array(input.length);
      for (var i = 0; i < input.length; i++) {
        var s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 32768 : s * 32767;
      }
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64FromInt16(pcm) }));
    };
    source.connect(micNode);
    // Required by some browsers for onaudioprocess to fire, even though
    // we never play the mic's own signal back — a silent gain node keeps
    // it out of the speakers, on the SAME shared context as playback.
    var silence = audioCtx.createGain();
    silence.gain.value = 0;
    micNode.connect(silence);
    silence.connect(audioCtx.destination);
  }

  function stopMic() {
    if (micNode) { try { micNode.disconnect(); } catch (e) {} micNode = null; }
    if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
  }

  function endCall() {
    if (ended) return;
    ended = true;
    setStatus('Call ended.');
    el.hang.style.display = 'none';
    stopMic();
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    if (ws) { try { ws.close(); } catch (e) {} }
    fetch('/talk/' + DATA.callId + '/end', { method: 'POST', headers: { Authorization: 'Bearer ' + DATA.token } }).catch(function () {});
  }
})();
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
