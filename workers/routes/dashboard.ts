import { Hono } from 'hono';
import type { Env } from '../env.js';

export const dashboardRoute = new Hono<{ Bindings: Env }>();

/**
 * One creator's own control panel.
 *
 * Distinct from /onboard, which walks the *platform operator* through
 * creating a creator from scratch. This is the page the creator themselves
 * lives in afterwards: add material, fix what extraction got wrong, try a
 * question before a real prospect asks it, see who has been writing in.
 *
 * Auth is the admin token carried in the query string rather than typed into
 * a field on every visit, so the whole thing is one bookmarkable link. That
 * is a deliberate trade and worth being honest about: anyone holding the URL
 * holds the access. It is not made public precisely because this page can
 * put words in the creator's outgoing email and can read prospects' real
 * addresses — an unauthenticated version would let a stranger do both. Same
 * secret as before, one less thing to retype.
 */
dashboardRoute.get('/dashboard/:creatorId', (c) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token) return c.text('ADMIN_TOKEN is not configured', 503);
  if (c.req.query('key') !== token) {
    return c.html(DENIED, 401);
  }
  return c.html(PAGE);
});

const DENIED = /* html */ `<!doctype html><html><head><meta charset="utf-8"><title>Dashboard</title>
<style>body{font:16px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:30rem;margin:5rem auto;padding:0 1.5rem;color:#1a1a1c}code{background:#f2f2f4;padding:.15rem .35rem;border-radius:4px;font-size:.85em}</style>
</head><body>
<h2>Not your link</h2>
<p>This dashboard opens from a link that carries its own key, like
<code>/dashboard/&lt;creator-id&gt;?key=&lt;admin-token&gt;</code>. Use the full link you were given and bookmark it.</p>
</body></html>`;

const PAGE = /* html */ `<!doctype html>
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
  input, textarea, select { width: 100%; padding: .55rem .65rem; font: inherit; border: 1px solid #d6d6da; border-radius: 8px; background: #fff; color: inherit; }
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
</style>
</head>
<body>
<div class="wrap">
  <h1 id="biz">Loading…</h1>
  <p class="sub" id="sub"></p>

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
    <h2>Knowledge</h2>
    <p class="note">What the coach can actually answer from. A <b>boundary</b> is the only thing that makes it mention a paid
      offer — items without one get answered in full and never pitch. Edit or delete anything that's wrong.</p>
    <div id="knowledge"></div>
  </section>

  <section>
    <h2>Offers</h2>
    <p class="note">What it points people to, but only when a boundary says the free material genuinely stops.</p>
    <div id="offers"></div>
    <details>
      <summary style="cursor:pointer;font-size:.88rem;margin-top:.5rem">Add an offer</summary>
      <label>Name</label><input id="o-name" placeholder="e.g. Kong AI">
      <label>Who it's for</label><input id="o-who" placeholder="who specifically benefits">
      <label>What it covers</label><textarea id="o-covers" style="min-height:4rem" placeholder="be precise — it will never claim more than this"></textarea>
      <label>Price</label><input id="o-price" placeholder="e.g. $390 one-time">
      <label>Link</label><input id="o-url" placeholder="https://">
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
    <h2>People who wrote in</h2>
    <p class="note">Ranked by how close they look to buying — depth of conversation, whether they hit a boundary, whether they clicked.</p>
    <div id="prospects"></div>
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
</div>

<script>
(function () {
  var parts = location.pathname.split('/');
  var CID = parts[parts.length - 1];
  var KEY = new URLSearchParams(location.search).get('key');
  var BASE = location.origin;

  function api(path, opts) {
    opts = opts || {};
    var url = BASE + path + (path.indexOf('?') === -1 ? '?' : '&') + 'key=' + encodeURIComponent(KEY);
    return fetch(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
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
      el('email-line').innerHTML = d.email
        ? '<span class="pill on">Live</span> Answering mail sent to <b>' + esc(d.email.gmail_address) + '</b>, checked every minute.'
        : '<span class="pill off">Not connected</span> No inbox connected yet, so nothing is being answered.';
      el('s-coach').value = d.creator.coach_name || '';
      el('s-audience').value = d.creator.audience || '';
      el('s-style').value = d.creator.teaching_style || '';
    });
  }

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
        n.innerHTML =
          '<h3>' + esc(it.problem) + '</h3>' +
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
          '</div>';
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
        n.innerHTML = '<h3>' + esc(o.name) + (o.price_text ? ' · <span class="note">' + esc(o.price_text) + '</span>' : '') + '</h3>' +
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

  el('btn-offer').onclick = function () {
    var name = el('o-name').value.trim();
    if (!name) return show('st-offer', 'err', 'Give it a name.');
    show('st-offer', 'busy', 'Saving…');
    api('/api/creators/' + CID + '/offers', { method: 'POST', body: {
      name: name, who_for: el('o-who').value.trim(), covers: el('o-covers').value.trim(),
      price_text: el('o-price').value.trim(), url: el('o-url').value.trim(),
    }}).then(function () {
      show('st-offer', 'ok', 'Added.');
      ['o-name','o-who','o-covers','o-price','o-url'].forEach(function (i) { el(i).value = ''; });
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
  function loadProspects() {
    return api('/api/creators/' + CID + '/prospects').then(function (d) {
      var box = el('prospects');
      if (!d.prospects.length) { box.innerHTML = '<p class="note">Nobody yet.</p>'; return; }
      var rows = d.prospects.map(function (p) {
        return '<tr><td>' + esc(p.email) + '</td><td>' + esc(p.blocked_on || p.situation || '—') +
          '</td><td>' + p.exchanges + '</td><td>' + (p.clicked_offer ? 'yes' : '') + '</td><td><b>' + p.score + '</b></td></tr>';
      }).join('');
      box.innerHTML = '<table><tr><th>Email</th><th>Stuck on</th><th>Emails</th><th>Clicked</th><th>Score</th></tr>' + rows + '</table>';
    });
  }

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

  addSource();
  loadOverview().then(loadOffers).then(loadKnowledge).then(loadProspects)
    .catch(function (e) { el('sub').textContent = 'Could not load: ' + e.message; });
})();
</script>
</body>
</html>`;
