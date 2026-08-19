import { Hono } from 'hono';
import type { Env } from '../env.js';

export const onboardingRoute = new Hono<{ Bindings: Env }>();

/**
 * Creator setup, as a page instead of a sequence of curl commands.
 *
 * This is still gated by the platform's single ADMIN_TOKEN — see the
 * comment in routes/admin.ts. That token is entered once into the field
 * below and held in memory for the page's lifetime (not persisted anywhere,
 * not sent except as the Authorization header on the calls this page makes),
 * and every action below is a plain fetch() against the same JSON API a
 * script could call. This page is a client for that API, not a new backend.
 */
onboardingRoute.get('/onboard', (c) => {
  return c.html(PAGE);
});

export const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up a coach</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem 6rem; background: #f7f7f8; color: #1a1a1c;
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 40rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .35rem; }
  h2 { font-size: 1.1rem; margin: 0 0 .5rem; }
  .lede { color: #6d6d72; margin: 0 0 1.75rem; }
  section {
    background: #fff; border: 1px solid #e5e5e7; border-radius: 12px;
    padding: 1.25rem 1.35rem; margin-bottom: 1rem; opacity: .45; pointer-events: none; transition: opacity .15s;
  }
  section.active { opacity: 1; pointer-events: auto; }
  section.done { opacity: .75; pointer-events: auto; }
  label { display: block; font-weight: 600; font-size: .88rem; margin: .9rem 0 .3rem; }
  label:first-of-type { margin-top: 0; }
  input, textarea, select {
    width: 100%; padding: .6rem .7rem; font: inherit; border: 1px solid #d6d6da; border-radius: 8px;
    background: #fff; color: inherit;
  }
  textarea { min-height: 10rem; font-family: ui-monospace, monospace; font-size: .85rem; resize: vertical; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
  .hint { color: #8a8a90; font-size: .82rem; margin: .3rem 0 0; }
  button {
    margin-top: 1rem; padding: .65rem 1.1rem; font: inherit; font-weight: 600; cursor: pointer;
    background: #1a1a1c; color: #fff; border: 0; border-radius: 8px;
  }
  button.secondary { background: #eceef0; color: #1a1a1c; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .status { margin-top: .85rem; padding: .75rem .9rem; border-radius: 8px; font-size: .88rem; display: none; }
  .status.show { display: block; }
  .status.ok { background: #edf7ee; color: #1e5e2a; }
  .status.err { background: #fdf0ee; color: #8a3527; }
  .issues { margin: .5rem 0 0; padding-left: 1.1rem; font-size: .85rem; }
  .issues li.error { color: #8a3527; background: none; padding: 0; }
  .issues li.warning { color: #8a6a15; }
  .result { background: #f7f7f8; border-radius: 8px; padding: .8rem .9rem; margin-top: .75rem; font-size: .88rem; }
  .result a { color: #1a1a1c; }
  .source { border: 1px solid #e5e5e7; border-radius: 10px; padding: .85rem; margin-bottom: .7rem; background: #fbfbfc; }
  .source-head { display: flex; gap: .5rem; align-items: center; margin-bottom: .5rem; }
  .source-head select { width: auto; flex: 0 0 auto; }
  .source-head input { flex: 1 1 auto; }
  .source-head button { margin: 0; padding: .35rem .6rem; background: #eceef0; color: #6d6d72; font-size: .8rem; }
  .source textarea { min-height: 7rem; }
  .prov { border-left: 2px solid #e5e5e7; padding: .35rem .6rem; margin: .35rem 0; font-size: .82rem; }
  .prov .p-path { font-weight: 600; }
  .prov .p-quote { color: #6d6d72; font-style: italic; }
  .badge { display: inline-block; font-size: .72rem; font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; background: #eceef0; color: #6d6d72; border-radius: 4px; padding: .15rem .4rem; margin-left: .4rem; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Set up a coach</h1>
  <p class="lede">Five steps. Each one unlocks the next once it succeeds.</p>

  <section id="s-token" class="active">
    <h2>Admin key</h2>
    <p class="hint">The platform admin token — this page never stores it anywhere; it's held in memory for this tab only.</p>
    <input id="token" type="password" placeholder="Admin token" autocomplete="off">
    <button id="btn-token">Continue</button>
    <div id="status-token" class="status"></div>
  </section>

  <section id="s-creator">
    <h2>1. Tell us about the coach<span class="badge">business info</span></h2>
    <label>Creator / business name</label>
    <input id="business_name" placeholder="Open Crumb Baking">
    <label>Coach's name</label>
    <input id="coach_name" placeholder="Rosa">
    <label>What outcome do you help people achieve?</label>
    <input id="outcome" placeholder="Bake a reliably open-crumb sourdough loaf at home">
    <label>Who is the customer?</label>
    <input id="audience" placeholder="Home bakers who already keep a starter but get dense loaves">
    <div class="row">
      <div>
        <label>Coach voice</label>
        <select id="coach_voice">
          <option value="eve">eve</option>
          <option value="ara">ara</option>
          <option value="atlas">atlas</option>
          <option value="luna">luna</option>
          <option value="orion">orion</option>
        </select>
      </div>
      <div>
        <label>Price per minute (cents)</label>
        <input id="price_per_minute_cents" type="number" min="50" step="1" value="75">
        <p class="hint">Platform floor is 50¢/min.</p>
      </div>
    </div>
    <label>Methodology, in your own words</label>
    <textarea id="methodology" style="min-height:5rem" placeholder="The method this coach teaches — this shapes every answer it gives."></textarea>
    <label>Always do / never do (one per line each)</label>
    <div class="row">
      <textarea id="always_do" style="min-height:5rem" placeholder="Ask for the actual measurement before diagnosing"></textarea>
      <textarea id="never_do" style="min-height:5rem" placeholder="Never recommend a shortcut that skips the method"></textarea>
    </div>
    <label>If a caller needs a human</label>
    <select id="escalation_policy">
      <option value="offer_human">Offer to connect them</option>
      <option value="transfer">Transfer immediately when asked</option>
      <option value="ticket_only">Just pass the question along</option>
    </select>
    <label>Phone number to transfer to (optional)</label>
    <input id="escalation_phone" placeholder="+15550100200">
    <label>Login email (optional — lets them log into their own dashboard right away)</label>
    <input id="login_email" type="email" placeholder="creator@example.com">
    <label>Initial password (optional — tell them this yourself; they can change it once logged in)</label>
    <input id="login_password" type="password" autocomplete="new-password" placeholder="at least 8 characters">
    <button id="btn-creator">Create coach</button>
    <div id="status-creator" class="status"></div>
  </section>

  <section id="s-curriculum">
    <h2>2. Add your material<span class="badge">any format</span></h2>
    <p class="hint">
      Paste whatever you already have — your course outline, a how-to guide, the questions customers ask
      you constantly, the roadblocks they hit, a video transcript. Add as many blocks as you like and say
      what each one is. We'll turn it into the structure the coach needs, then you review it.
    </p>
    <div id="sources"></div>
    <button id="btn-add-source" class="secondary" type="button">+ Add another block</button>
    <button id="btn-structure">Build my curriculum</button>
    <div id="status-structure" class="status"></div>

    <div id="draft-wrap" style="display:none">
      <label>Your curriculum <span class="hint" style="display:inline">— edit anything before uploading</span></label>
      <textarea id="curriculum"></textarea>
      <details id="provenance-wrap" style="margin:.6rem 0">
        <summary class="hint" style="cursor:pointer">Where did each part come from?</summary>
        <div id="provenance" style="max-height:16rem;overflow:auto;margin-top:.5rem"></div>
      </details>
      <button id="btn-curriculum">Check &amp; upload</button>
      <label style="display:inline-flex;align-items:center;gap:.4rem;font-weight:400;margin-top:.6rem">
        <input type="checkbox" id="force" style="width:auto"> Upload anyway if there are errors (draft only — can't go live yet)
      </label>
    </div>
    <div id="status-curriculum" class="status"></div>
  </section>

  <section id="s-phone">
    <h2>3. Attach a phone number<span class="badge">manual — see note</span></h2>
    <p class="hint">
      Provision the number in the xAI console (Voice Agents), then paste the result here. The webhook
      signing secret is shown once at creation — copy it right away, xAI won't show it again.
      Set the number's webhook to <code id="webhook-url">…</code> if the console asks for one.
    </p>
    <div class="row">
      <div>
        <label>Phone number</label>
        <input id="e164" placeholder="+14155550100">
      </div>
      <div>
        <label>Webhook signing secret</label>
        <input id="signing_secret" placeholder="whsec_… (optional on console-managed numbers)">
      </div>
    </div>
    <button id="btn-phone">Attach number</button>
    <button id="btn-phone-skip" class="secondary" type="button">Skip for now</button>
    <div id="status-phone" class="status"></div>
  </section>

  <section id="s-budget">
    <h2>4. Free trial minutes<span class="badge">optional</span></h2>
    <div class="row">
      <div>
        <label>Total minutes to fund</label>
        <input id="promo_minutes" type="number" min="0" value="0">
      </div>
      <div>
        <label>Minutes per customer</label>
        <input id="promo_per_customer" type="number" min="1" value="10">
      </div>
    </div>
    <p class="hint">Leave the total at 0 to skip — no trial pool means no free minutes, on purpose.</p>
    <button id="btn-budget">Set trial pool</button>
    <button id="btn-budget-skip" class="secondary" type="button">Skip</button>
    <div id="status-budget" class="status"></div>
  </section>

  <section id="s-publish">
    <h2>5. Go live</h2>
    <button id="btn-publish">Publish</button>
    <div id="status-publish" class="status"></div>
  </section>

  <section id="s-agent">
    <h2>6. Set up the xAI console agent</h2>
    <p class="hint">
      xAI's console has no API for configuring an Agent on this account, so this one paste is unavoidable —
      but what you paste is generated from what you entered above, not written by hand. In the console,
      open (or create) the Agent for this number, paste the box below into <strong>Instructions</strong>,
      and paste the URL into its <strong>Tools / MCP</strong> section as a remote MCP server.
    </p>
    <label>Instructions</label>
    <textarea id="agent-instructions" readonly style="min-height:14rem"></textarea>
    <button id="btn-copy-instructions" class="secondary" type="button">Copy instructions</button>
    <label>MCP server URL <span class="hint" style="display:inline">(valid for 1 year)</span></label>
    <input id="agent-mcp-url" readonly>
    <button id="btn-copy-url" class="secondary" type="button">Copy URL</button>
    <div id="status-agent" class="status"></div>
  </section>
</div>

<script>
(function () {
  const base = location.origin;
  let token = '';
  let creatorId = '';
  let creatorSlug = '';

  document.getElementById('webhook-url').textContent = base + '/webhooks/xai';

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }
  function show(id, kind, html) {
    const el = document.getElementById('status-' + id);
    el.className = 'status show ' + kind;
    el.innerHTML = html;
  }
  function unlock(id) {
    document.getElementById('s-' + id).classList.add('active');
  }
  function complete(id) {
    const el = document.getElementById('s-' + id);
    el.classList.remove('active');
    el.classList.add('done', 'active');
  }
  async function call(path, body, method) {
    const res = await fetch(base + path, {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
    return data;
  }
  function lines(id) {
    return document.getElementById(id).value.split('\\n').map((s) => s.trim()).filter(Boolean);
  }

  document.getElementById('btn-token').onclick = async () => {
    token = document.getElementById('token').value.trim();
    if (!token) return show('token', 'err', 'Enter the admin token first.');
    try {
      // Cheapest authenticated call available, just to confirm the token works.
      await call('/api/curriculum/audit', { markdown: '# Course: check\\n## Module: m\\n### Lesson: l\\n#### Step: s\\nInstructions: x\\nExpected result: y\\n' });
      show('token', 'ok', 'Token accepted.');
      complete('token');
      unlock('creator');
    } catch (e) {
      show('token', 'err', 'That token was rejected: ' + e.message);
    }
  };

  document.getElementById('btn-creator').onclick = async () => {
    const businessName = document.getElementById('business_name').value.trim();
    const coachName = document.getElementById('coach_name').value.trim();
    if (!businessName || !coachName) return show('creator', 'err', 'Business name and coach name are required.');
    try {
      const res = await call('/api/creators', {
        business_name: businessName,
        coach_name: coachName,
        outcome: document.getElementById('outcome').value.trim() || undefined,
        audience: document.getElementById('audience').value.trim() || undefined,
        methodology: document.getElementById('methodology').value.trim() || undefined,
        coach_voice: document.getElementById('coach_voice').value,
        price_per_minute_cents: Number(document.getElementById('price_per_minute_cents').value) || 75,
        always_do: lines('always_do'),
        never_do: lines('never_do'),
        escalation_policy: document.getElementById('escalation_policy').value,
        escalation_phone: document.getElementById('escalation_phone').value.trim() || undefined,
      });
      creatorId = res.id;
      creatorSlug = res.slug;

      const loginEmail = document.getElementById('login_email').value.trim();
      const loginPassword = document.getElementById('login_password').value;
      if (loginEmail && loginPassword) {
        try {
          await call('/api/creators/' + creatorId + '/login', { login_email: loginEmail, new_password: loginPassword }, 'PATCH');
        } catch (e) {
          // The creator itself is already made — a login-setup failure (e.g. that
          // email already belongs to another creator) shouldn't block the rest of
          // the wizard. It can always be set later the same way.
          show('creator', 'ok', 'Created — <code>' + res.id + '</code> (slug: ' + res.slug + '). Login was NOT set: ' + e.message);
          complete('creator');
          unlock('curriculum');
          return;
        }
      }

      show('creator', 'ok', 'Created — <code>' + res.id + '</code> (slug: ' + res.slug + ')' + (loginEmail && loginPassword ? ' — login set.' : ''));
      complete('creator');
      unlock('curriculum');
    } catch (e) {
      show('creator', 'err', e.message);
    }
  };

  // ---- raw material blocks -------------------------------------------------
  const SOURCE_KINDS = [
    ['curriculum', 'Course / curriculum'],
    ['guide', 'How-to guide'],
    ['faq', 'Questions I get asked'],
    ['roadblocks', 'Common roadblocks'],
    ['transcript', 'Video / audio transcript'],
    ['notes', 'Notes / other'],
  ];

  function addSourceBlock(kind) {
    const wrap = document.createElement('div');
    wrap.className = 'source';
    const opts = SOURCE_KINDS.map(
      (k) => '<option value="' + k[0] + '"' + (k[0] === kind ? ' selected' : '') + '>' + k[1] + '</option>',
    ).join('');
    wrap.innerHTML =
      '<div class="source-head">' +
      '<select class="s-kind">' + opts + '</select>' +
      '<input class="s-title" placeholder="What is this? (optional)">' +
      '<button type="button" class="s-remove">Remove</button>' +
      '</div>' +
      '<textarea class="s-text" placeholder="Paste it here — rough is fine."></textarea>';
    wrap.querySelector('.s-remove').onclick = () => {
      if (document.querySelectorAll('#sources .source').length > 1) wrap.remove();
    };
    document.getElementById('sources').appendChild(wrap);
  }
  addSourceBlock('curriculum');
  document.getElementById('btn-add-source').onclick = () => addSourceBlock('faq');

  function collectSources() {
    return [...document.querySelectorAll('#sources .source')]
      .map((el) => ({
        kind: el.querySelector('.s-kind').value,
        title: el.querySelector('.s-title').value.trim(),
        text: el.querySelector('.s-text').value,
      }))
      .filter((s) => s.text.trim());
  }

  function renderIssues(issues) {
    if (!issues || !issues.length) return '';
    return '<ul class="issues">' + issues
      .map((i) => '<li class="' + i.severity + '"><strong>' + i.path + '</strong> — ' + i.message + '</li>')
      .join('') + '</ul>';
  }

  document.getElementById('btn-structure').onclick = async () => {
    const sources = collectSources();
    if (!sources.length) return show('structure', 'err', 'Paste some material first.');

    const btn = document.getElementById('btn-structure');
    btn.disabled = true;
    show('structure', 'ok', 'Reading your material… this can take a minute for a big course.');
    try {
      const res = await call('/api/creators/' + creatorId + '/curriculum/structure', {
        sources,
        course_title: document.getElementById('outcome').value.trim() || undefined,
      });

      document.getElementById('curriculum').value = res.markdown;
      document.getElementById('draft-wrap').style.display = 'block';

      document.getElementById('provenance').innerHTML = (res.provenance || [])
        .map((p) => '<div class="prov"><div class="p-path">' + esc(p.path) + '</div><div class="p-quote">“' + esc(p.quote) + '”</div></div>')
        .join('') || '<p class="hint">No quotes returned.</p>';

      const c = res.counts;
      const errors = (res.issues || []).filter((i) => i.severity === 'error');
      let html = 'Found ' + c.modules + ' module(s), ' + c.steps + ' step(s), ' +
        c.problems + ' documented problem(s), ' + c.references + ' reference(s). ' +
        'Cost $' + (res.usage.costUsd || 0).toFixed(3) + '.';
      if (errors.length) {
        html += '<p style="margin:.5rem 0 0"><strong>' + errors.length + ' gap(s) to fill in.</strong> ' +
          'These were left blank on purpose — your material didn\\'t state them, and guessing would put ' +
          'words in your mouth. Edit the curriculum below, then upload.</p>';
      }
      html += renderIssues(res.issues);
      show('structure', errors.length ? 'err' : 'ok', html);
    } catch (e) {
      show('structure', 'err', e.message);
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById('btn-curriculum').onclick = async () => {
    const markdown = document.getElementById('curriculum').value;
    if (!markdown.trim()) return show('curriculum', 'err', 'Paste some curriculum first.');
    try {
      const res = await call('/api/creators/' + creatorId + '/curriculum', {
        markdown,
        force: document.getElementById('force').checked,
      });
      const errors = (res.issues || []).filter((i) => i.severity === 'error');
      const warnings = (res.issues || []).filter((i) => i.severity === 'warning');
      let html = res.steps + ' step(s), ' + res.problems + ' documented problem(s) uploaded.';
      if (errors.length || warnings.length) {
        html += '<ul class="issues">' + (res.issues || [])
          .map((i) => '<li class="' + i.severity + '"><strong>' + i.path + '</strong> — ' + i.message + '</li>')
          .join('') + '</ul>';
      }
      show('curriculum', errors.length ? 'err' : 'ok', html + (errors.length ? '<p style="margin:.5rem 0 0">Fix these before publishing, or check "upload anyway" for a draft.</p>' : ''));
      if (!errors.length || document.getElementById('force').checked) {
        complete('curriculum');
        unlock('phone');
        unlock('budget');
        unlock('publish');
      }
    } catch (e) {
      show('curriculum', 'err', e.message + (e.data && e.data.issues ? '<ul class="issues">' + e.data.issues.map((i) => '<li class="' + i.severity + '">' + i.message + '</li>').join('') + '</ul>' : ''));
    }
  };

  document.getElementById('btn-phone').onclick = async () => {
    const e164 = document.getElementById('e164').value.trim();
    if (!e164) return show('phone', 'err', 'Enter the number you provisioned in the xAI console.');
    try {
      const res = await call('/api/creators/' + creatorId + '/phone-number/manual', {
        e164,
        signing_secret: document.getElementById('signing_secret').value.trim() || 'unset',
      });
      show('phone', 'ok', 'Attached ' + res.e164 + '.');
      complete('phone');
    } catch (e) {
      show('phone', 'err', e.message);
    }
  };
  document.getElementById('btn-phone-skip').onclick = () => complete('phone');

  document.getElementById('btn-budget').onclick = async () => {
    const minutes = Number(document.getElementById('promo_minutes').value) || 0;
    if (minutes <= 0) { complete('budget'); return show('budget', 'ok', 'Skipped — no trial pool.'); }
    try {
      await call('/api/creators/' + creatorId + '/promotional-budget', {
        name: 'Launch trial',
        minutes,
        per_customer_minutes: Number(document.getElementById('promo_per_customer').value) || 10,
      });
      show('budget', 'ok', 'Trial pool funded: ' + minutes + ' minutes total.');
      complete('budget');
    } catch (e) {
      show('budget', 'err', e.message);
    }
  };
  document.getElementById('btn-budget-skip').onclick = () => { complete('budget'); show('budget', 'ok', 'Skipped.'); };

  document.getElementById('btn-publish').onclick = async () => {
    try {
      await call('/api/creators/' + creatorId + '/publish', {});
      const link = base + '/c/' + creatorSlug;
      show('publish', 'ok', '<strong>Live.</strong><div class="result">Customer sign-up page: <a href="' + link + '">' + link + '</a></div>');
      complete('publish');
      unlock('agent');
      await loadAgentSetup();
    } catch (e) {
      show('publish', 'err', e.message);
    }
  };

  async function loadAgentSetup() {
    try {
      const res = await call('/api/creators/' + creatorId + '/agent-setup', {});
      document.getElementById('agent-instructions').value = res.instructions;
      document.getElementById('agent-mcp-url').value = res.mcp_url;
      show('agent', 'ok', 'Generated from what you entered above — paste both into the console.');
    } catch (e) {
      show('agent', 'err', 'Could not generate agent setup: ' + e.message);
    }
  }

  function wireCopy(buttonId, fieldId) {
    document.getElementById(buttonId).onclick = async () => {
      const field = document.getElementById(fieldId);
      field.select();
      try {
        await navigator.clipboard.writeText(field.value);
        show('agent', 'ok', 'Copied.');
      } catch {
        show('agent', 'ok', 'Selected — copy with your browser\\'s usual shortcut.');
      }
    };
  }
  wireCopy('btn-copy-instructions', 'agent-instructions');
  wireCopy('btn-copy-url', 'agent-mcp-url');
})();
</script>
</body>
</html>`;
