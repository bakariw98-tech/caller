import { Hono } from 'hono';
import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { loadAppConfig } from '../env.js';
import type { Creator } from '../../src/domain/types.js';
import { resolveToken, revokeAssistantToken } from '../mcp/auth.js';
import { ASSISTANT_TOOL_DEFINITIONS } from '../mcp/assistant-tools.js';
import { buildAssistantInstructions } from '../assistant/prompt.js';
import { buildSessionUpdate, buildSeedItem, buildResponseCreate, type SessionToolSet } from '../coach/session-config.js';
import { mintEphemeralClientSecret } from '../xai/client.js';

export const assistantRoute = new Hono<{ Bindings: Env }>();

/**
 * Derived from ASSISTANT_TOOL_DEFINITIONS rather than a second hand-typed
 * name list — QUAL_TOOL_SET keeps its own literal array, but that has
 * exactly one real caller today; this one is duplicated across a browser
 * session (this file) and, per the plan, a pasted key from a creator's own
 * agent, so letting the list and the definitions drift is a real risk a
 * derived value removes for free.
 */
const ASSISTANT_TOOL_SET: SessionToolSet = {
  serverLabel: 'assistant',
  serverDescription: "The creator's own dashboard — their knowledge base, offers, profile, and leads.",
  allowedTools: ASSISTANT_TOOL_DEFINITIONS.map((t) => t.name),
};

/**
 * The browser counterpart of workers/routes/talk.ts, for a fundamentally
 * different session: this is the creator talking to their OWN assistant,
 * not a prospect on a qualification call. No `calls` row exists here at
 * all — see mcp_assistant_sessions in schema.sql for why: this is not a
 * call, nothing is metered, and a synthetic call row would silently
 * inflate the voice-escalation funnel counts that read from `calls`.
 *
 * The whole client-side script in renderAssistantPage() is copied from
 * renderTalkPage() essentially unchanged — that file's doc comment records
 * everything that was hard-won getting it right (WebSocket not WebRTC, the
 * `delta` field name, iOS earpiece routing, autoplay timing). None of that
 * is specific to a qualification call; it is just how a browser talks to
 * xAI's realtime voice API at all.
 */
async function buildAssistantSession(
  db: ReturnType<typeof wrapD1>,
  env: Env,
  creatorId: string,
  token: string,
): Promise<
  | { ok: true; businessName: string; realtimeBase: string; model: string; ephemeralSecret: string; sessionUpdate: Record<string, unknown>; seedItem: Record<string, unknown>; responseCreate: Record<string, unknown> }
  | { ok: false; status: 401 | 404 | 502; message: string }
> {
  const resolved = await resolveToken(db, env.MCP_TOKEN_SECRET, token ? `Bearer ${token}` : undefined);
  if (!resolved || resolved.kind !== 'assistant' || resolved.session.creator_id !== creatorId) {
    return { ok: false, status: 401, message: 'This link is invalid or has expired.' };
  }

  const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(creatorId);
  if (!creator) return { ok: false, status: 404, message: 'Creator not found.' };

  const instructions = buildAssistantInstructions(creator);

  // Minted at page-render time, not at link-creation time — see talk.ts's
  // identical comment: these expire in roughly a minute.
  let secret: { value: string; expiresAt: number };
  try {
    secret = await mintEphemeralClientSecret(env.XAI_API_BASE, env.XAI_API_KEY);
  } catch (err) {
    console.error('failed to mint ephemeral client secret (assistant)', err);
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
    toolSet: ASSISTANT_TOOL_SET,
  }) as { session: Record<string, unknown> } & Record<string, unknown>;
  sessionUpdate.session.audio = { output: { format: { type: 'audio/pcm', rate: 24000 } } };
  const seedItem = buildSeedItem('Greet them by name if you know it from get_overview, and ask what they want to do.');
  const responseCreate = buildResponseCreate();

  return {
    ok: true,
    businessName: creator.business_name,
    realtimeBase: `wss://${env.XAI_REALTIME_HOST}/v1/realtime`,
    model: env.XAI_VOICE_MODEL,
    ephemeralSecret: secret.value,
    sessionUpdate,
    seedItem,
    responseCreate,
  };
}

assistantRoute.get('/assistant/:creatorId', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('creatorId');
  const token = c.req.query('token') ?? '';

  const session = await buildAssistantSession(db, c.env, creatorId, token);
  if (!session.ok) return c.text(session.message, session.status);

  return c.html(renderAssistantPage({ creatorId, token, ...session }));
});

/** DIAGNOSTIC twin of /assistant/:creatorId — see talk.ts's identical route for why this exists in this sandbox. */
assistantRoute.get('/assistant/:creatorId/raw', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('creatorId');
  const token = c.req.query('token') ?? '';

  const session = await buildAssistantSession(db, c.env, creatorId, token);
  if (!session.ok) return c.json({ error: session.message }, session.status);
  return c.json(session);
});

assistantRoute.post('/assistant/:creatorId/end', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('creatorId');
  const auth = c.req.header('Authorization');
  const bodyToken = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';

  const resolved = await resolveToken(db, c.env.MCP_TOKEN_SECRET, auth);
  if (!resolved || resolved.kind !== 'assistant' || resolved.session.creator_id !== creatorId) {
    return c.json({ error: 'invalid session' }, 401);
  }

  // Revoke this specific token immediately rather than letting it ride out
  // its hour-long TTL unused — good hygiene for a session that is now over,
  // and harmless: a fresh one is minted on every "Talk to your assistant"
  // click. Never revokes a durable key (Part 3) by this path; those never
  // hit this route at all, since a pasted-into-an-agent key has no "hang
  // up" button to call it from.
  if (bodyToken) await revokeAssistantToken(db, c.env.MCP_TOKEN_SECRET, bodyToken);

  return c.json({ ok: true });
});

// Exported for tests/assistant.test.ts — see tests/talk.test.ts's comment
// for the exact class of bug this guards against (a stray backtick inside
// this outer TS template literal breaking the whole embedded <script>
// silently). This page's script is talk.ts's, adapted for a creatorId
// instead of a callId and different copy; the mechanics are identical.
export function renderAssistantPage(params: {
  creatorId: string;
  token: string;
  realtimeBase: string;
  model: string;
  ephemeralSecret: string;
  sessionUpdate: Record<string, unknown>;
  seedItem: Record<string, unknown>;
  responseCreate: Record<string, unknown>;
  businessName: string;
}): string {
  const data = JSON.stringify({
    realtimeBase: params.realtimeBase,
    model: params.model,
    ephemeralSecret: params.ephemeralSecret,
    sessionUpdate: params.sessionUpdate,
    seedItem: params.seedItem,
    responseCreate: params.responseCreate,
    creatorId: params.creatorId,
    token: params.token,
  });

  return /* html */ `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your assistant — ${escapeHtml(params.businessName)}</title>
<style>
  body { font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 30rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1c; text-align: center; }
  button { font: inherit; font-weight: 600; padding: .8rem 1.6rem; border-radius: 999px; border: none; background: #1a1a1c; color: #fff; cursor: pointer; margin-top: 1.5rem; }
  button:disabled { opacity: .5; }
  button.hang { background: #b3261e; }
  #status { color: #6d6d72; margin-top: 1rem; min-height: 1.4em; }
</style>
</head><body>
<h2>Talk to your assistant</h2>
<p>Ask what's going on, or ask it to change anything — knowledge, offers, your profile. This uses your microphone.</p>
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
  var audioCtx = null, nextPlayTime = 0;
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
      navigator.sendBeacon('/assistant/' + DATA.creatorId + '/end', new Blob([JSON.stringify({})], { type: 'application/json' }));
    }
  });

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
    if (!heardAudio) { heardAudio = true; setStatus('Hearing your assistant — talk anytime.'); }
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
    fetch('/assistant/' + DATA.creatorId + '/end', { method: 'POST', headers: { Authorization: 'Bearer ' + DATA.token } }).catch(function () {});
  }
})();
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
