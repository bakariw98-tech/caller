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
 * UNVERIFIED end to end — see mintEphemeralClientSecret()'s doc comment.
 * The WebRTC connection, the SDP endpoint shape, and the datachannel
 * event flow are this repo's best-informed guess from the SIP path and
 * from how xAI's realtime events already mirror OpenAI's Realtime API,
 * not a confirmed integration. Confirm on the first real open of this
 * page, the same discipline docs/XAI-API-NOTES.md already applies to
 * every other ambiguous piece of this API.
 */
talkRoute.get('/talk/:callId', async (c) => {
  const db = wrapD1(c.env.DB);
  const callId = c.req.param('callId');
  const token = c.req.query('token');

  const resolved = await resolveToken(db, c.env.MCP_TOKEN_SECRET, token ? `Bearer ${token}` : undefined);
  if (!resolved || resolved.kind !== 'qualify' || resolved.session.call_id !== callId) {
    return c.text('This link is invalid or has expired.', 401);
  }

  const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(resolved.session.creator_id);
  if (!creator) return c.text('Creator not found.', 404);

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
    secret = await mintEphemeralClientSecret(c.env.XAI_API_BASE, c.env.XAI_API_KEY);
  } catch (err) {
    console.error('failed to mint ephemeral client secret', err);
    return c.text('Could not start a live session with the voice API right now. Try again in a moment.', 502);
  }

  const mcpUrl = `${c.env.PUBLIC_BASE_URL}/mcp`;
  const sessionUpdate = buildSessionUpdate({
    instructions,
    voice: creator.coach_voice,
    mcpToken: token!,
    mcpUrl,
    reasoningEffort: 'none',
    idleTimeoutMs: loadAppConfig(c.env).idleTimeoutMs,
    toolSet: QUAL_TOOL_SET,
  });
  const seedItem = buildSeedItem("You're on a qualification call. Greet them warmly and ask for the short code from their invite email.");
  const responseCreate = buildResponseCreate();

  return c.html(renderTalkPage({
    callId,
    token: token!,
    // Same host construction as the SIP path's own outbound connection
    // (call-session.ts's startCall()) — XAI_REALTIME_HOST is the bare
    // host, kept separate from XAI_API_BASE (the REST base) for exactly
    // this reuse.
    realtimeBase: `https://${c.env.XAI_REALTIME_HOST}/v1/realtime`,
    model: c.env.XAI_VOICE_MODEL,
    ephemeralSecret: secret.value,
    sessionUpdate,
    seedItem,
    responseCreate,
    businessName: creator.business_name,
  }));
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

function renderTalkPage(params: {
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
<audio id="remote-audio" autoplay></audio>
<script>
(function () {
  var DATA = ${data};
  var el = { start: document.getElementById('start'), hang: document.getElementById('hang'), status: document.getElementById('status'), audio: document.getElementById('remote-audio') };
  var pc = null, dc = null, ended = false;

  function setStatus(s) { el.status.textContent = s; }

  el.start.onclick = function () {
    el.start.disabled = true;
    connect().catch(function (e) { setStatus('Could not connect: ' + e.message); el.start.disabled = false; });
  };

  el.hang.onclick = function () { endCall('hangup'); };
  window.addEventListener('beforeunload', function () {
    if (!ended && navigator.sendBeacon) {
      navigator.sendBeacon('/talk/' + DATA.callId + '/end', new Blob([JSON.stringify({})], { type: 'application/json' }));
    }
  });

  async function connect() {
    setStatus('Requesting microphone…');
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    pc = new RTCPeerConnection();
    stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
    pc.ontrack = function (evt) { el.audio.srcObject = evt.streams[0]; };
    dc = pc.createDataChannel('events');
    dc.onopen = function () {
      setStatus('Connected — say hello.');
      dc.send(JSON.stringify(DATA.sessionUpdate));
      dc.send(JSON.stringify(DATA.seedItem));
      dc.send(JSON.stringify(DATA.responseCreate));
      el.hang.style.display = 'inline-block';
    };
    dc.onmessage = function (evt) {
      try { console.log('event', JSON.parse(evt.data)); } catch (e) {}
    };

    setStatus('Negotiating…');
    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise(function (r) { setTimeout(r, 500); });

    var url = DATA.realtimeBase + '?model=' + encodeURIComponent(DATA.model);
    var res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + DATA.ephemeralSecret, 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });
    if (!res.ok) throw new Error('realtime API returned ' + res.status + ': ' + (await res.text()).slice(0, 200));
    var answerSdp = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  function endCall(reason) {
    if (ended) return;
    ended = true;
    setStatus('Call ended.');
    el.hang.style.display = 'none';
    if (pc) { try { pc.close(); } catch (e) {} }
    fetch('/talk/' + DATA.callId + '/end', { method: 'POST', headers: { Authorization: 'Bearer ' + DATA.token } }).catch(function () {});
  }
})();
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
