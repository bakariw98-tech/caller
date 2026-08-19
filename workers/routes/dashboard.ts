import { Hono } from 'hono';
import type { Env } from '../env.js';
import { checkCreatorAccess } from '../auth/require-creator.js';

export const dashboardRoute = new Hono<{ Bindings: Env }>();

/**
 * One creator's own control panel.
 *
 * Distinct from /onboard, which walks the *platform operator* through
 * creating a creator from scratch. This is the page the creator themselves
 * lives in afterwards: add material, fix what extraction got wrong, try a
 * question before a real prospect asks it, see who has been writing in.
 *
 * Was a single platform-wide ADMIN_TOKEN carried as `?key=` in the URL —
 * bookmarkable, but not scoped to a creator at all: anyone holding it could
 * open ANY creator's dashboard by changing the id in the path. Now a real
 * per-creator login (see workers/auth/require-creator.ts): a session cookie
 * whose creator_id matches THIS path, or the admin token as a support
 * override (kept deliberately, on request — same operator access as
 * before, just no longer the only way in). No key in the URL either way.
 */
dashboardRoute.get('/dashboard/:creatorId', async (c) => {
  const creatorId = c.req.param('creatorId');
  const access = await checkCreatorAccess(c, creatorId);
  if (!access) {
    return c.redirect(`/login?next=${encodeURIComponent(`/dashboard/${creatorId}`)}`);
  }
  return c.html(PAGE);
});

// Exported for tests/dashboard.test.ts, which parses the embedded <script>
// with new Function() to catch a JS syntax error before it reaches a
// browser — see that test's comment for why this matters here specifically.
export const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coach dashboard</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 1.5rem 1.25rem 6rem; background: #f7f7f8; color: #1a1a1c;
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 44rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 .2rem; }
  .sub { color: #6d6d72; margin: 0 0 1.5rem; font-size: .92rem; }
  section { background: #fff; border: 1px solid #e5e5e7; border-radius: 12px; padding: 1.15rem 1.25rem; margin-bottom: 1rem; }
  h2 { font-size: 1.02rem; margin: 0 0 .15rem; }
  .note { color: #8a8a90; font-size: .84rem; margin: 0 0 .9rem; }
  label { display: block; font-weight: 600; font-size: .85rem; margin: .8rem 0 .28rem; }
  input, textarea, select { width: 100%; padding: .55rem .65rem; font: inherit; font-size: 16px; border: 1px solid #d6d6da; border-radius: 8px; background: #fff; color: inherit; }
  textarea { min-height: 8rem; resize: vertical; font-size: .9rem; }
  button { font: inherit; font-weight: 600; padding: .55rem 1rem; border-radius: 8px; border: 1px solid #1a1a1c; background: #1a1a1c; color: #fff; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  button.ghost { background: #fff; color: #1a1a1c; }
  button.danger { background: #fff; color: #b3261e; border-color: #e4c3c0; padding: .3rem .6rem; font-size: .82rem; font-weight: 500; }
  .row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
  .stats { display: flex; gap: 1.4rem; flex-wrap: wrap; margin: .2rem 0 0; }
  .stat b { display: block; font-size: 1.3rem; line-height: 1.2; }
  .stat span { color: #8a8a90; font-size: .8rem; }
  .pill { display: inline-block; padding: .15rem .5rem; border-radius: 999px; font-size: .76rem; font-weight: 600; }
  .pill.on { background: #e7f4ec; color: #1c6b3f; }
  .pill.off { background: #fdecea; color: #b3261e; }
  .item { border: 1px solid #e5e5e7; border-radius: 10px; padding: .8rem .9rem; margin-bottom: .6rem; }
  .item h3 { font-size: .93rem; margin: 0 0 .35rem; }
  .trunc { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .item p { margin: .25rem 0; font-size: .88rem; color: #4a4a4f; }
  .bnd { background: #fff8e6; border-left: 3px solid #e0a800; padding: .4rem .6rem; margin-top: .5rem; font-size: .85rem; border-radius: 0 6px 6px 0; }
  .bnd b { color: #8a6100; }
  .status { font-size: .87rem; margin-top: .6rem; min-height: 1.2em; }
  .status.ok { color: #1c6b3f; } .status.err { color: #b3261e; } .status.busy { color: #6d6d72; }
  .src { border: 1px dashed #d6d6da; border-radius: 10px; padding: .8rem .9rem; margin-bottom: .6rem; }
  .reply { background: #f2f2f4; border-radius: 8px; padding: .8rem .9rem; white-space: pre-wrap; font-size: .89rem; margin-top: .7rem; }
  table { width: 100%; border-collapse: collapse; font-size: .87rem; }
  th, td { text-align: left; padding: .45rem .3rem; border-bottom: 1px solid #ededf0; }
  th { color: #8a8a90; font-weight: 600; font-size: .8rem; }
  a { color: #1a1a1c; }
  @media (max-width: 480px) {
    body { padding: 1rem .75rem 4rem; font-size: 14.5px; }
    section { padding: .85rem .8rem; border-radius: 10px; margin-bottom: .7rem; }
    h1 { font-size: 1.2rem; }
    .sub { margin-bottom: 1rem; }
    .note { font-size: .8rem; margin-bottom: .7rem; }
    .stats { gap: .9rem 1.1rem; }
    .stat b { font-size: 1.05rem; }
    .stat span { font-size: .74rem; }
    .item { padding: .6rem .65rem; margin-bottom: .45rem; }
    button { padding: .5rem .8rem; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1 id="biz">Loading…</h1>
  <p class="sub" id="sub"></p>

  <div class="row" style="margin-bottom:1rem;justify-content:space-between">
    <button id="btn-assistant" type="button">🎙️ Talk to your assistant</button>
    <button id="btn-logout" class="ghost" type="button">Log out</button>
  </div>
  <p class="status" id="st-assistant"></p>

  <section>
    <h2>Status</h2>
    <p class="note" id="email-line"></p>
    <div class="stats">
      <div class="stat"><b id="c-knowledge">–</b><span>knowledge items</span></div>
      <div class="stat"><b id="c-boundaries">–</b><span>route to an offer</span></div>
      <div class="stat"><b id="c-offers">–</b><span>offers</span></div>
      <div class="stat"><b id="c-prospects">–</b><span>people who wrote in</span></div>
    </div>
  </section>

  <section>
    <h2>Add material</h2>
    <p class="note">Paste anything you already have — a video transcript, an FAQ, a newsletter, notes. It gets broken into
      problem-and-answer pairs. Nothing is invented: if your material doesn't answer something, it's left out rather than made up.</p>
    <div id="sources"></div>
    <div class="row">
      <button class="ghost" id="btn-add-src" type="button">+ Another block</button>
      <button id="btn-ingest">Add to knowledge</button>
    </div>
    <div class="status" id="st-ingest"></div>
  </section>

  <section>
    <h2>YouTube channel</h2>
    <p class="note">Connect your channel and every video becomes knowledge — no pasting required. Videos are tiered from
      title and length for free before anything is fetched: tutorials and frameworks first, Shorts and vlogs skipped
      outright. Fetching and reading each video happens a few at a time in the background; refresh this page to watch
      it progress.</p>
    <div id="yt-connected" style="display:none">
      <p class="note" style="margin-bottom:.6rem">Connected: <b id="yt-channel"></b></p>
      <div class="stats" id="yt-stats"></div>
      <div class="row" style="margin-top:.8rem">
        <input id="yt-input" placeholder="@handle or channel URL" style="flex:1">
        <button class="ghost" id="btn-yt-resync" type="button">Sync new uploads</button>
      </div>
    </div>
    <div id="yt-disconnected">
      <label>Your channel</label>
      <input id="yt-input-first" placeholder="@handle, channel URL, or UC… id">
      <div class="row" style="margin-top:.7rem"><button id="btn-yt-connect">Connect channel</button></div>
    </div>
    <div class="status" id="st-yt"></div>
    <div id="yt-conflicts"></div>
  </section>

  <section>
    <h2>Knowledge</h2>
    <p class="note">What the coach can actually answer from. A <b>boundary</b> is the only thing that makes it mention a paid
      offer — items without one get answered in full and never pitch. Edit or delete anything that's wrong.</p>
    <div id="knowledge"></div>
  </section>

  <section>
    <h2>Offers</h2>
    <p class="note">Two kinds. <b>Free</b> things — your videos, guides, tools — get sent any time they'd
      genuinely help. <b>Paid</b> things are only recommended once it understands their situation, the real
      problem, and what they want.</p>
    <div id="offers"></div>
    <details id="offer-add-details">
      <summary style="cursor:pointer;font-size:.88rem;margin-top:.5rem">Add an offer</summary>
      <label>What is it?</label>
      <select id="o-free">
        <option value="0">Something they pay for — a course, coaching, a product</option>
        <option value="1">Free — one of your videos, a guide, a template, a tool</option>
      </select>
      <p class="note" style="margin:.35rem 0 0">Free things get sent whenever they'd genuinely help. Paid ones
        are only recommended once the coach understands their situation, their real problem, and what they want.</p>
      <label>Name</label><input id="o-name" placeholder="e.g. Kong AI, or 'How I find winning products'">
      <label>Link</label><input id="o-url" placeholder="https:// — the sales page, if it has one">
      <p class="note" style="margin-top:.3rem">Fill in the name and the link, then click elsewhere. It reads what
        you've actually said about this in your own material (pasted notes + YouTube transcripts) <i>and</i> reads
        the sales page itself — the real pricing tiers, what's included, the testimonials, the FAQ — and fills in
        everything below from both. Nothing invented. Review it before saving; the price especially is worth a
        second look.
        <button id="btn-offer-lookup" class="ghost" type="button" style="margin-left:.4rem;padding:.15rem .5rem;font-size:.8em">Look up again</button>
      </p>
      <div class="status" id="st-offer-lookup"></div>
      <div id="offer-lookup-sources"></div>
      <label>Who it's for</label><input id="o-who" placeholder="who specifically benefits">
      <label>What it covers</label><textarea id="o-covers" style="min-height:4rem" placeholder="be precise — it will never claim more than this"></textarea>
      <label>Price</label><input id="o-price" placeholder="e.g. $390 one-time">
      <p class="note" style="margin-top:.9rem"><b>For qualification calls</b> — used only when Voice escalation
        (below) is on. Everything here is spoken from directly; nothing is invented beyond it.</p>
      <label>Who it's NOT for</label><input id="o-not-who" placeholder="rules out a bad-fit recommendation before it happens">
      <label>Recommend when</label><textarea id="o-recommend-when" style="min-height:3rem" placeholder="the situation that makes this the right call"></textarea>
      <label>Don't recommend when</label><textarea id="o-dont-recommend-when" style="min-height:3rem" placeholder="when it would be an honest no"></textarea>
      <label>Known objections and how to answer them</label>
      <textarea id="o-objections" style="min-height:4rem" placeholder="e.g. &quot;Too expensive&quot; — because it replaces [X], which normally costs more on its own."></textarea>
      <label>Next-step style</label>
      <select id="o-cta-tier">
        <option value="low_ticket">Low ticket — a direct checkout link</option>
        <option value="course" selected>Course — program details + enrollment link</option>
        <option value="high_ticket_application">High ticket — an application, not a checkout</option>
        <option value="very_high_ticket">Very high ticket — a follow-up call with the team</option>
      </select>
      <div class="row" style="margin-top:.7rem"><button id="btn-offer">Add offer</button></div>
      <div class="status" id="st-offer"></div>
    </details>
  </section>

  <section>
    <h2>Try a question</h2>
    <p class="note">Exactly what a real email would produce, without sending anything or saving a prospect.</p>
    <textarea id="q" style="min-height:5rem" placeholder="Ask the sort of thing someone would email you…"></textarea>
    <div class="row" style="margin-top:.6rem"><button id="btn-try">See the reply</button></div>
    <div class="status" id="st-try"></div>
    <div id="try-out"></div>
  </section>

  <section>
    <h2>Leads</h2>
    <p class="note">Every address that has emailed in is a lead the moment it arrives. The conversation enriches it from there —
      situation, real problem, goal, what's in the way — until there's enough to judge an offer honestly. That's "qualified".</p>
    <div class="stats" id="lead-funnel"></div>
    <div class="row" style="margin-top:.8rem"><a id="btn-export-csv" class="ghost" style="text-decoration:none;font-weight:600;padding:.55rem 1rem;border-radius:8px;border:1px solid #1a1a1c;color:#1a1a1c" href="#">Export CSV</a></div>
    <div id="prospects" style="margin-top:1rem"></div>
  </section>

  <section>
    <h2>Voice escalation</h2>
    <p class="note">When someone writes in showing real interest, instead of a written reply they get a warm
      invitation to call — and the call itself is the real sales conversation: discovery, a diagnosis they
      confirm out loud, and only then an honestly-earned offer. This is not a smaller version of email; it's
      where the actual conversion happens.</p>
    <p id="ve-status" class="note"></p>
    <div id="ve-setup">
      <label>Qualify phone number (E.164, e.g. +15551234567)</label>
      <input id="ve-e164" placeholder="+1…">
      <label>Signing secret (from the xAI console, shown once at creation)</label>
      <input id="ve-secret" placeholder="paste the webhook signing secret">
      <div class="row" style="margin-top:.6rem"><button id="btn-ve-number" class="ghost" type="button">Register number</button></div>
    </div>
    <label style="margin-top:.9rem">Objection posture</label>
    <select id="ve-posture">
      <option value="soft">Soft — back off after one honest answer (default)</option>
      <option value="assertive">Assertive — a couple of genuine re-tries before backing off</option>
    </select>
    <div class="row" style="margin-top:.7rem">
      <button id="btn-ve-toggle">Enable voice escalation</button>
      <button id="btn-ve-posture" class="ghost" type="button">Save posture</button>
    </div>
    <div class="status" id="st-ve"></div>
    <div class="stats" id="ve-funnel" style="margin-top:1rem"></div>
    <div class="row" style="margin-top:1rem">
      <button id="btn-ve-testcall" class="ghost" type="button">Start a live voice test — no phone number needed</button>
    </div>
    <p class="note" style="margin-top:.4rem">Opens a real conversation with the qualification agent in this browser, using
      the offers and posture above as they are right now — works even before a qualify number is registered or the mode
      is enabled.</p>
  </section>

  <section>
    <h2>Connect your own agent</h2>
    <p class="note">The same assistant you can talk to above, reachable from Claude Desktop or any MCP-capable agent of
      your own. A key is shown to you exactly once — copy it before closing this. <b>Treat it like a password:</b> it
      can read and change everything above, including sending email as you, for as long as it exists. Revoke a key any
      time you no longer recognize it.</p>
    <label>Label (so you can tell keys apart later)</label>
    <input id="mcpkey-label" placeholder="e.g. my laptop, Claude Desktop">
    <div class="row" style="margin-top:.6rem"><button id="btn-mcpkey-create" class="ghost" type="button">Create a key</button></div>
    <div class="status" id="st-mcpkey"></div>
    <div id="mcpkey-new" style="display:none;margin-top:.7rem">
      <label>Server URL</label><input id="mcpkey-url" readonly>
      <label>Key — copy this now, it will not be shown again</label><input id="mcpkey-token" readonly>
    </div>
    <div id="mcpkey-list" style="margin-top:.8rem"></div>
  </section>

  <section>
    <h2>Voice</h2>
    <p class="note">How it writes. Changes apply to the next reply.</p>
    <label>Name it signs as</label><input id="s-coach">
    <label>Who you're talking to</label><input id="s-audience">
    <label>How you sound</label><textarea id="s-style" style="min-height:4rem"></textarea>
    <div class="row" style="margin-top:.7rem"><button id="btn-settings">Save</button></div>
    <div class="status" id="st-settings"></div>
  </section>

  <section>
    <h2>Login</h2>
    <p class="note">Change the password you use to log in.</p>
    <label>Current password</label><input id="pw-current" type="password" autocomplete="current-password">
    <label>New password</label><input id="pw-new" type="password" autocomplete="new-password">
    <div class="row" style="margin-top:.7rem"><button id="btn-pw">Change password</button></div>
    <div class="status" id="st-pw"></div>
  </section>
</div>

<script>
(function () {
  var parts = location.pathname.split('/');
  var CID = parts[parts.length - 1];
  var BASE = location.origin;

  el('btn-export-csv').href = BASE + '/api/creators/' + CID + '/prospects.csv';

  // No more ?key=/Authorization header — the browser sends the httpOnly
  // session cookie automatically on every same-origin request. That's the
  // whole point of a login over the old scheme: nothing for page JS to
  // even hold onto.
  function api(path, opts) {
    opts = opts || {};
    return fetch(BASE + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('Not logged in.'); }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || j.detail || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function el(id) { return document.getElementById(id); }
  function show(id, cls, msg) { var n = el(id); n.className = 'status ' + cls; n.textContent = msg; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // ---- overview
  function loadOverview() {
    return api('/api/creators/' + CID + '/overview').then(function (d) {
      el('biz').textContent = d.creator.business_name;
      el('sub').textContent = 'Answering as ' + d.creator.coach_name + ' · ' + d.creator.status;
      el('c-knowledge').textContent = d.counts.knowledge;
      el('c-boundaries').textContent = d.counts.boundaries;
      el('c-offers').textContent = d.counts.offers;
      el('c-prospects').textContent = d.counts.prospects;
      el('lead-funnel').innerHTML =
        '<div class="stat"><b>' + d.counts.leads + '</b><span>leads captured</span></div>' +
        '<div class="stat"><b>' + d.counts.qualified + '</b><span>qualified</span></div>' +
        '<div class="stat"><b>' + d.counts.offers_presented + '</b><span>offers presented</span></div>' +
        '<div class="stat"><b>' + d.counts.offer_clicks + '</b><span>offer clicks</span></div>';
      el('email-line').innerHTML = d.email
        ? '<span class="pill on">Live</span> Answering mail sent to <b>' + esc(d.email.gmail_address) + '</b>, checked every minute.'
        : '<span class="pill off">Not connected</span> No inbox connected yet, so nothing is being answered.';
      el('s-coach').value = d.creator.coach_name || '';
      el('s-audience').value = d.creator.audience || '';
      el('s-style').value = d.creator.teaching_style || '';
      renderVoice(d.voice);
    });
  }

  // ---- voice escalation
  function renderVoice(v) {
    v = v || { enabled: false, funnel: null };
    el('ve-posture').value = v.objection_handling_posture || 'soft';
    el('btn-ve-toggle').textContent = v.enabled ? 'Disable voice escalation' : 'Enable voice escalation';
    el('ve-setup').style.display = v.qualify_number ? 'none' : 'block';
    el('ve-status').innerHTML = v.enabled
      ? '<span class="pill on">On</span> Calling in on <b>' + esc(v.qualify_number || '') + '</b>.'
      : (v.qualify_number
          ? '<span class="pill off">Off</span> Number registered (' + esc(v.qualify_number) + ') but not yet enabled.'
          : '<span class="pill off">Off</span> Register a qualify number below, then enable.');

    var f = v.funnel;
    var box = el('ve-funnel');
    if (!f || !v.enabled) { box.innerHTML = ''; return; }
    // Framing: lead with what people actually DID — voluntarily took the
    // next step — never a bare "qualification rate", which is gameable by
    // loosening the bar in a way a count of real actions is not. No
    // revenue-attribution number is shown; this platform has no price-paid
    // signal to compute one honestly from.
    box.innerHTML =
      '<div class="stat"><b>' + f.invitations_sent + '</b><span>call invitations sent (30d)</span></div>' +
      '<div class="stat"><b>' + f.calls_started + '</b><span>calls started</span></div>' +
      '<div class="stat"><b>' + f.calls_completed + '</b><span>calls completed</span></div>' +
      '<div class="stat"><b>' + f.offers_presented + '</b><span>offers discussed live</span></div>' +
      '<div class="stat"><b>' + f.next_steps_accepted + '</b><span>people who voluntarily took the next step</span></div>' +
      (v.cost_per_voice_qualified_lead_cents != null
        ? '<div class="stat"><b>$' + (v.cost_per_voice_qualified_lead_cents / 100).toFixed(2) + '</b><span>cost per voice-qualified lead</span></div>'
        : '');
  }

  el('btn-ve-number').onclick = function () {
    var e164 = el('ve-e164').value.trim();
    var secret = el('ve-secret').value.trim();
    if (!e164 || !secret) return show('st-ve', 'err', 'Give both the number and the signing secret.');
    show('st-ve', 'busy', 'Registering…');
    api('/api/creators/' + CID + '/phone-number/manual', { method: 'POST', body: { e164: e164, signing_secret: secret, purpose: 'qualify' } })
      .then(function () { show('st-ve', 'ok', 'Registered. You can enable voice escalation now.'); el('ve-e164').value = ''; el('ve-secret').value = ''; return loadOverview(); })
      .catch(function (e) { show('st-ve', 'err', e.message); });
  };

  el('btn-ve-toggle').onclick = function () {
    var enabling = el('btn-ve-toggle').textContent.indexOf('Enable') === 0;
    show('st-ve', 'busy', 'Saving…');
    api('/api/creators/' + CID + '/voice-qualification', { method: 'PATCH', body: { enabled: enabling } })
      .then(function () { show('st-ve', 'ok', enabling ? 'Voice escalation is on.' : 'Voice escalation is off.'); return loadOverview(); })
      .catch(function (e) { show('st-ve', 'err', e.message); });
  };

  el('btn-ve-posture').onclick = function () {
    show('st-ve', 'busy', 'Saving…');
    api('/api/creators/' + CID + '/voice-qualification', { method: 'PATCH', body: { objection_handling_posture: el('ve-posture').value } })
      .then(function () { show('st-ve', 'ok', 'Saved.'); return loadOverview(); })
      .catch(function (e) { show('st-ve', 'err', e.message); });
  };

  el('btn-ve-testcall').onclick = function () {
    show('st-ve', 'busy', 'Starting…');
    api('/api/creators/' + CID + '/qualification-link', { method: 'POST' })
      .then(function (d) { show('st-ve', 'ok', 'Opening…'); window.open(d.url, '_blank'); })
      .catch(function (e) { show('st-ve', 'err', e.message); });
  };

  // Reachable from anywhere on the page, always — this is meant to be the
  // ordinary way of running the dashboard, not a feature buried in one
  // section. Opens in a new tab, same as the qualification test call above.
  el('btn-assistant').onclick = function () {
    show('st-assistant', 'busy', 'Starting…');
    api('/api/creators/' + CID + '/assistant/link', { method: 'POST' })
      .then(function (d) { show('st-assistant', 'ok', 'Opening…'); window.open(d.url, '_blank'); })
      .catch(function (e) { show('st-assistant', 'err', e.message); });
  };

  el('btn-logout').onclick = function () {
    fetch(BASE + '/logout', { method: 'POST' }).then(function () { location.href = '/login'; });
  };

  // ---- youtube
  function loadYoutube() {
    return api('/api/creators/' + CID + '/youtube/status').then(function (d) {
      if (d.channel) {
        el('yt-connected').style.display = 'block';
        el('yt-disconnected').style.display = 'none';
        el('yt-channel').textContent = d.channel;
        el('yt-input').value = d.channel;
        el('yt-stats').innerHTML =
          '<div class="stat"><b>' + d.counts.enumerated + '</b><span>videos found</span></div>' +
          '<div class="stat"><b>' + d.counts.done + '</b><span>processed</span></div>' +
          '<div class="stat"><b>' + d.counts.pending + '</b><span>queued</span></div>' +
          '<div class="stat"><b>' + d.counts.skipped + '</b><span>skipped (Shorts/vlogs)</span></div>' +
          (d.counts.failed ? '<div class="stat"><b>' + d.counts.failed + '</b><span>failed</span></div>' : '');
      } else {
        el('yt-connected').style.display = 'none';
        el('yt-disconnected').style.display = 'block';
      }
      var box = el('yt-conflicts');
      if (!d.conflicts || !d.conflicts.length) { box.innerHTML = ''; return; }
      box.innerHTML = '<p class="note" style="margin-top:1rem"><b>' + d.conflicts.length +
        ' place' + (d.conflicts.length === 1 ? '' : 's') +
        ' where two videos say close to the same thing, close enough that agreement was not confirmed.</b> ' +
        'Nothing was merged or guessed at — this could be a real difference in advice, or just different wording ' +
        'for the same point. Only you know which.</p>';
      d.conflicts.forEach(function (pair) {
        var n = document.createElement('div');
        n.className = 'item';
        n.innerHTML =
          '<h3>' + esc(pair.a_problem) + '</h3>' +
          '<p><b>A:</b> ' + esc(pair.a_guidance) + (pair.a_url ? ' — <a href="' + esc(pair.a_url) + '" target="_blank" rel="noopener">video</a>' : '') + '</p>' +
          '<p><b>B:</b> ' + esc(pair.b_guidance) + (pair.b_url ? ' — <a href="' + esc(pair.b_url) + '" target="_blank" rel="noopener">video</a>' : '') + '</p>' +
          '<div class="row" style="margin-top:.5rem"><button class="danger yt-dismiss" type="button">Dismiss — leave both as-is</button></div>';
        n.querySelector('.yt-dismiss').onclick = function () {
          api('/api/creators/' + CID + '/youtube/conflicts/' + pair.a_id + '/dismiss', { method: 'POST' })
            .then(loadYoutube);
        };
        box.appendChild(n);
      });
    });
  }

  function connectYoutube(channel) {
    if (!channel) return show('st-yt', 'err', 'Enter a channel handle or URL.');
    show('st-yt', 'busy', 'Reading the channel list…');
    api('/api/creators/' + CID + '/youtube/connect', { method: 'POST', body: { channel: channel } })
      .then(function (r) {
        show('st-yt', 'ok', 'Found ' + r.enumerated + ' videos — ' + r.tier1 + ' tutorials, ' + r.tier2 +
          ' general, ' + r.skipped + ' skipped. Processing a few at a time now.');
        return loadYoutube();
      })
      .catch(function (e) { show('st-yt', 'err', e.message); });
  }
  el('btn-yt-connect').onclick = function () { connectYoutube(el('yt-input-first').value.trim()); };
  el('btn-yt-resync').onclick = function () { connectYoutube(el('yt-input').value.trim()); };

  // ---- sources
  function addSource(k, t, x) {
    var d = document.createElement('div');
    d.className = 'src';
    d.innerHTML =
      '<label>What kind</label><select class="s-kind">' +
        '<option value="video_transcript">Video transcript</option>' +
        '<option value="faq">FAQ / questions you get</option>' +
        '<option value="blog">Article or blog post</option>' +
        '<option value="newsletter">Newsletter</option>' +
        '<option value="podcast">Podcast</option>' +
        '<option value="framework">A framework you teach</option>' +
        '<option value="lead_magnet">Lead magnet</option>' +
      '</select>' +
      '<label>Title</label><input class="s-title" placeholder="so you can recognise it later">' +
      '<label>Paste it here</label><textarea class="s-text"></textarea>' +
      '<div class="row" style="margin-top:.5rem"><button class="danger s-rm" type="button">Remove</button></div>';
    el('sources').appendChild(d);
    if (k) d.querySelector('.s-kind').value = k;
    if (t) d.querySelector('.s-title').value = t;
    if (x) d.querySelector('.s-text').value = x;
    d.querySelector('.s-rm').onclick = function () { d.remove(); };
  }
  el('btn-add-src').onclick = function () { addSource(); };

  el('btn-ingest').onclick = function () {
    var srcs = [].slice.call(document.querySelectorAll('#sources .src')).map(function (d) {
      return {
        kind: d.querySelector('.s-kind').value,
        title: d.querySelector('.s-title').value.trim(),
        text: d.querySelector('.s-text').value.trim(),
      };
    }).filter(function (s) { return s.text; });
    if (!srcs.length) return show('st-ingest', 'err', 'Paste something in first.');
    show('st-ingest', 'busy', 'Reading it… this takes a few seconds.');
    el('btn-ingest').disabled = true;
    api('/api/creators/' + CID + '/content', { method: 'POST', body: { sources: srcs } })
      .then(function (r) {
        show('st-ingest', 'ok', 'Added ' + r.stored + ' items — ' + r.without_boundary +
          ' answered in full, ' + r.with_boundary + ' that can route to an offer.');
        el('sources').innerHTML = '';
        addSource();
        return Promise.all([loadOverview(), loadKnowledge()]);
      })
      .catch(function (e) { show('st-ingest', 'err', e.message); })
      .then(function () { el('btn-ingest').disabled = false; });
  };

  // ---- knowledge
  var OFFERS = [];
  function loadKnowledge() {
    return api('/api/creators/' + CID + '/knowledge').then(function (d) {
      var box = el('knowledge');
      if (!d.items.length) { box.innerHTML = '<p class="note">Nothing yet — add some material above.</p>'; return; }
      box.innerHTML = '';
      d.items.forEach(function (it) {
        var n = document.createElement('div');
        n.className = 'item';
        var offOpts = ['<option value="">— no offer —</option>'].concat(OFFERS.map(function (o) {
          return '<option value="' + esc(o.id) + '"' + (o.name === it.boundary_offer ? ' selected' : '') + '>' + esc(o.name) + '</option>';
        })).join('');
        // Collapsed by default: a creator can have 100+ of these, and a page
        // of fully-expanded cards is the single biggest source of scroll on
        // a phone. Same shape as the prospect rows below — one-line summary,
        // everything else behind a toggle.
        n.innerHTML =
          '<h3 class="trunc">' + esc(it.problem) + '</h3>' +
          '<div class="row" style="justify-content:space-between">' +
            '<span class="pill ' + (it.boundary ? 'off' : 'on') + '">' +
              (it.boundary ? 'Routes to ' + esc(it.boundary_offer || 'nothing') : 'Answers fully') +
            '</span>' +
            '<button class="danger k-toggle" type="button">Details</button>' +
          '</div>' +
          '<div class="k-detail" style="display:none">' +
          '<p>' + esc(it.guidance) + '</p>' +
          (it.boundary
            ? '<div class="bnd"><b>Routes to ' + esc(it.boundary_offer || 'nothing') + '</b> — free material stops at: ' + esc(it.boundary) + '</div>'
            : '<p class="note" style="margin:.4rem 0 0">Answered in full · never pitches</p>') +
          '<div class="row" style="margin-top:.6rem">' +
            '<button class="danger k-edit" type="button">Edit</button>' +
            '<button class="danger k-del" type="button">Delete</button>' +
          '</div>' +
          '<div class="k-form" style="display:none">' +
            '<label>Question it answers</label><input class="k-problem" value="' + esc(it.problem) + '">' +
            '<label>The answer</label><textarea class="k-guidance" style="min-height:5rem">' + esc(it.guidance) + '</textarea>' +
            '<label>Where your free material stops (leave blank = answers fully, never pitches)</label>' +
            '<textarea class="k-boundary" style="min-height:3.5rem">' + esc(it.boundary || '') + '</textarea>' +
            '<label>Offer that picks up past that line</label><select class="k-offer">' + offOpts + '</select>' +
            '<div class="row" style="margin-top:.6rem"><button class="k-save" type="button">Save</button></div>' +
          '</div>' +
          '</div>';
        n.querySelector('.k-toggle').onclick = function () {
          var d = n.querySelector('.k-detail');
          d.style.display = d.style.display === 'none' ? 'block' : 'none';
        };
        n.querySelector('.k-edit').onclick = function () {
          var f = n.querySelector('.k-form');
          f.style.display = f.style.display === 'none' ? 'block' : 'none';
        };
        n.querySelector('.k-del').onclick = function () {
          if (!confirm('Delete this? The coach will no longer be able to answer it.')) return;
          api('/api/creators/' + CID + '/knowledge/' + it.id, { method: 'DELETE' })
            .then(function () { return Promise.all([loadOverview(), loadKnowledge()]); });
        };
        n.querySelector('.k-save').onclick = function () {
          var b = n.querySelector('.k-boundary').value.trim();
          api('/api/creators/' + CID + '/knowledge/' + it.id, {
            method: 'PATCH',
            body: {
              problem: n.querySelector('.k-problem').value.trim(),
              guidance: n.querySelector('.k-guidance').value.trim(),
              boundary: b || null,
              boundary_offer_id: b ? (n.querySelector('.k-offer').value || null) : null,
            },
          }).then(function () { return Promise.all([loadOverview(), loadKnowledge()]); });
        };
        box.appendChild(n);
      });
    });
  }

  // ---- offers
  function loadOffers() {
    return api('/api/creators/' + CID + '/offers').then(function (d) {
      OFFERS = d.offers || [];
      var box = el('offers');
      if (!OFFERS.length) { box.innerHTML = '<p class="note">No offers yet — it will simply answer and never pitch.</p>'; return; }
      box.innerHTML = '';
      OFFERS.forEach(function (o) {
        var n = document.createElement('div');
        n.className = 'item';
        n.innerHTML = '<h3>' + esc(o.name) +
          (o.is_free ? ' <span class="pill on">free</span>' : '') +
          (o.price_text ? ' · <span class="note">' + esc(o.price_text) + '</span>' : '') + '</h3>' +
          (o.who_for ? '<p><b>For:</b> ' + esc(o.who_for) + '</p>' : '') +
          (o.covers ? '<p><b>Covers:</b> ' + esc(o.covers) + '</p>' : '') +
          (o.url ? '<p><a href="' + esc(o.url) + '" target="_blank" rel="noopener">' + esc(o.url) + '</a></p>' : '') +
          '<div class="row" style="margin-top:.5rem"><button class="danger o-del" type="button">Remove</button></div>';
        n.querySelector('.o-del').onclick = function () {
          if (!confirm('Remove this offer? Boundaries pointing at it will stop routing.')) return;
          api('/api/creators/' + CID + '/offers/' + o.id, { method: 'DELETE' })
            .then(function () { return loadOffers(); }).then(loadKnowledge).then(loadOverview);
        };
        box.appendChild(n);
      });
    });
  }

  var lastLookedUp = null;

  function lookupOfferFromContent(name, url) {
    if (!name) return;
    show('st-offer-lookup', 'busy', url ? 'Reading your material and the sales page…' : 'Reading your material…');
    el('offer-lookup-sources').innerHTML = '';
    api('/api/creators/' + CID + '/offers/extract', { method: 'POST', body: { name: name, url: url || '' } })
      .then(function (d) {
        var draft = d.draft;
        var notes = (d.scrape_errors || []).slice(0, 2);
        if (!draft || !draft.found) {
          show('st-offer-lookup', 'err', "Couldn't find this in your material" + (url ? ' or on that page' : '') +
            ' — fill it in below yourself.' + (notes.length ? ' (' + notes.join('; ') + ')' : ''));
          return;
        }
        if (draft.who_for) el('o-who').value = draft.who_for;
        if (draft.covers) el('o-covers').value = draft.covers;
        if (draft.price_text) el('o-price').value = draft.price_text;
        if (draft.url && !el('o-url').value.trim()) el('o-url').value = draft.url;
        if (draft.not_who_for) el('o-not-who').value = draft.not_who_for;
        if (draft.recommend_when) el('o-recommend-when').value = draft.recommend_when;
        if (draft.dont_recommend_when) el('o-dont-recommend-when').value = draft.dont_recommend_when;
        if (draft.objections_and_responses) el('o-objections').value = draft.objections_and_responses;
        var pages = d.pages_read || [];
        var msg = pages.length
          ? 'Filled in from your material and ' + pages.length + ' page' + (pages.length === 1 ? '' : 's') +
            ' of the site — check it over before saving.'
          : 'Filled in from your own material — check it over before saving. Price is worth double-checking either way.';
        if (notes.length) msg += ' (' + notes.join('; ') + ')';
        show('st-offer-lookup', 'ok', msg);
        if (draft.sources && draft.sources.length) {
          el('offer-lookup-sources').innerHTML = '<p class="note" style="margin-top:.4rem">From: ' +
            draft.sources.map(function (s) {
              return s.url ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.title) + '</a>' : esc(s.title);
            }).join(', ') + '</p>';
        }
      })
      .catch(function (e) { show('st-offer-lookup', 'err', e.message); });
  }

  // Both fields feed one lookup, so the guard key is both of them — pasting
  // a link after the name already fired should re-run with the page this
  // time, but tabbing back through an unchanged form should not.
  function runLookup(force) {
    var name = el('o-name').value.trim();
    var url = el('o-url').value.trim();
    if (!name) {
      if (force) show('st-offer-lookup', 'err', 'Type the offer name first.');
      return;
    }
    var key = name + '||' + url;
    if (!force && key === lastLookedUp) return;
    lastLookedUp = key;
    lookupOfferFromContent(name, url);
  }

  el('btn-offer-lookup').onclick = function () { runLookup(true); };

  // Also fires on its own the moment you finish filling either field and
  // click or tab elsewhere — you should not have to know a lookup button
  // exists just to get the rest of the form filled in.
  el('o-name').addEventListener('blur', function () { runLookup(false); });
  el('o-url').addEventListener('blur', function () { runLookup(false); });

  el('btn-offer').onclick = function () {
    var name = el('o-name').value.trim();
    if (!name) return show('st-offer', 'err', 'Give it a name.');
    show('st-offer', 'busy', 'Saving…');
    api('/api/creators/' + CID + '/offers', { method: 'POST', body: {
      name: name, who_for: el('o-who').value.trim(), covers: el('o-covers').value.trim(),
      price_text: el('o-price').value.trim(), url: el('o-url').value.trim(),
      is_free: el('o-free').value === '1',
      not_who_for: el('o-not-who').value.trim(), recommend_when: el('o-recommend-when').value.trim(),
      dont_recommend_when: el('o-dont-recommend-when').value.trim(), objections_and_responses: el('o-objections').value.trim(),
      cta_tier: el('o-cta-tier').value,
    }}).then(function () {
      show('st-offer', 'ok', 'Added.');
      ['o-name','o-who','o-covers','o-price','o-url','o-not-who','o-recommend-when','o-dont-recommend-when','o-objections'].forEach(function (i) { el(i).value = ''; });
      return loadOffers().then(loadKnowledge).then(loadOverview);
    }).catch(function (e) { show('st-offer', 'err', e.message); });
  };

  // ---- try it
  el('btn-try').onclick = function () {
    var q = el('q').value.trim();
    if (!q) return show('st-try', 'err', 'Type a question first.');
    show('st-try', 'busy', 'Thinking…');
    el('try-out').innerHTML = '';
    api('/api/leadgen/simulate', { method: 'POST', body: {
      creator_id: CID, from_email: 'preview@example.com', subject: 'Preview', text: q, persist: false,
    }}).then(function (d) {
      show('st-try', 'ok', d.signals.routed_offer_name
        ? 'Pointed them to ' + d.signals.routed_offer_name + ' — because it hit a boundary.'
        : 'Answered in full, no pitch.');
      el('try-out').innerHTML = '<div class="reply">' + esc(d.reply) + '</div>';
    }).catch(function (e) { show('st-try', 'err', e.message); });
  };

  // ---- prospects
  function parseList(json) {
    try {
      var v = JSON.parse(json || '[]');
      return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string'; }) : [];
    } catch (e) { return []; }
  }
  function field(label, value) {
    return value ? '<p><b>' + esc(label) + ':</b> ' + esc(value) + '</p>' : '';
  }
  function fieldDate(label, epochSeconds) {
    return epochSeconds ? field(label, new Date(epochSeconds * 1000).toLocaleDateString()) : '';
  }

  function loadProspects() {
    return api('/api/creators/' + CID + '/prospects').then(function (d) {
      var box = el('prospects');
      if (!d.prospects.length) { box.innerHTML = '<p class="note">Nobody yet.</p>'; return; }
      box.innerHTML = '';
      d.prospects.forEach(function (p) {
        var n = document.createElement('div');
        n.className = 'item';
        var objections = parseList(p.objections_json).join(', ');
        var topics = parseList(p.topics_json).join(', ');
        n.innerHTML =
          '<h3>' + esc(p.email) +
            (p.qualified_at ? ' <span class="pill on">qualified</span>' : '') +
            (p.clicked_offer ? ' <span class="pill on">clicked</span>' : '') + '</h3>' +
          '<p class="trunc">' + esc(p.blocked_on || p.situation || 'No situation captured yet') +
            ' · ' + p.exchanges + ' email' + (p.exchanges === 1 ? '' : 's') + ' · score <b>' + p.score + '</b></p>' +
          '<div class="row" style="margin-top:.5rem"><button class="danger p-toggle" type="button">Full record</button></div>' +
          '<div class="p-detail" style="display:none;margin-top:.6rem">' +
            field('Situation', p.situation) +
            field('Real problem', p.diagnosed_problem) +
            field('Goal', p.goal) +
            field('Tried', p.tried) +
            field('Blocked on', p.blocked_on) +
            field('Experience level', p.knowledge_level) +
            field('Urgency', p.urgency) +
            field('Objections', objections) +
            field('Topics asked about', topics) +
            field('Offer presented', p.offer_pitched ? 'Yes' : 'No') +
            field('Offer clicked', p.clicked_offer ? 'Yes' : 'No') +
            fieldDate('First seen', p.first_seen_at) +
            fieldDate('Qualified since', p.qualified_at) +
          '</div>';
        n.querySelector('.p-toggle').onclick = function () {
          var detail = n.querySelector('.p-detail');
          detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
        };
        box.appendChild(n);
      });
    });
  }

  // ---- your own agent (Part 3: creator-scoped MCP keys)
  function loadMcpKeys() {
    return api('/api/creators/' + CID + '/mcp-keys').then(function (d) {
      var box = el('mcpkey-list');
      var keys = d.keys || [];
      if (!keys.length) { box.innerHTML = '<p class="note">No keys yet.</p>'; return; }
      box.innerHTML = '';
      keys.forEach(function (k) {
        var n = document.createElement('div');
        n.className = 'item';
        var when = new Date(k.created_at * 1000).toLocaleDateString();
        var used = k.last_used_at ? new Date(k.last_used_at * 1000).toLocaleString() : 'never used';
        n.innerHTML =
          '<h3>' + esc(k.label || '(no label)') + (k.revoked_at ? ' <span class="pill off">revoked</span>' : ' <span class="pill on">active</span>') + '</h3>' +
          '<p class="note">Created ' + when + ' · Last used: ' + esc(used) + '</p>' +
          (k.revoked_at ? '' : '<div class="row" style="margin-top:.5rem"><button class="danger key-revoke" type="button">Revoke</button></div>');
        var revokeBtn = n.querySelector('.key-revoke');
        if (revokeBtn) revokeBtn.onclick = function () {
          if (!confirm('Revoke "' + (k.label || 'this key') + '"? Anything using it will stop working immediately.')) return;
          api('/api/creators/' + CID + '/mcp-keys/' + encodeURIComponent(k.token_hash), { method: 'DELETE' }).then(loadMcpKeys);
        };
        box.appendChild(n);
      });
    });
  }

  el('btn-mcpkey-create').onclick = function () {
    show('st-mcpkey', 'busy', 'Creating…');
    api('/api/creators/' + CID + '/mcp-keys', { method: 'POST', body: { label: el('mcpkey-label').value.trim() } })
      .then(function (d) {
        show('st-mcpkey', 'ok', 'Copy this now — it will not be shown again.');
        el('mcpkey-url').value = d.server_url;
        el('mcpkey-token').value = d.token;
        el('mcpkey-new').style.display = 'block';
        el('mcpkey-label').value = '';
        return loadMcpKeys();
      })
      .catch(function (e) { show('st-mcpkey', 'err', e.message); });
  };

  // ---- settings
  el('btn-settings').onclick = function () {
    show('st-settings', 'busy', 'Saving…');
    api('/api/creators/' + CID + '/settings', { method: 'PATCH', body: {
      coach_name: el('s-coach').value.trim(),
      audience: el('s-audience').value.trim(),
      teaching_style: el('s-style').value.trim(),
    }}).then(function () { show('st-settings', 'ok', 'Saved.'); return loadOverview(); })
      .catch(function (e) { show('st-settings', 'err', e.message); });
  };

  el('btn-pw').onclick = function () {
    var current = el('pw-current').value;
    var next = el('pw-new').value;
    if (!current || !next) return show('st-pw', 'err', 'Fill in both fields.');
    if (next.length < 8) return show('st-pw', 'err', 'New password should be at least 8 characters.');
    show('st-pw', 'busy', 'Saving…');
    api('/api/creators/' + CID + '/login', { method: 'PATCH', body: { current_password: current, new_password: next } })
      .then(function () {
        show('st-pw', 'ok', 'Password changed.');
        el('pw-current').value = '';
        el('pw-new').value = '';
      })
      .catch(function (e) { show('st-pw', 'err', e.message); });
  };

  addSource();
  loadOverview().then(loadOffers).then(loadKnowledge).then(loadProspects).then(loadYoutube).then(loadMcpKeys)
    .catch(function (e) { el('sub').textContent = 'Could not load: ' + e.message; });
})();
</script>
</body>
</html>`;
