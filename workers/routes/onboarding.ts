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

const PAGE = /* html */ `<!doctype html>
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
    <button id="btn-creator">Create coach</button>
    <div id="status-creator" class="status"></div>
  </section>

  <section id="s-curriculum">
    <h2>2. Paste the curriculum<span class="badge">structured, not a blob</span></h2>
    <p class="hint">See the format at the top of <code>src/curriculum/parse-markdown.ts</code> — modules, lessons, steps, each with instructions, an expected result, and common problems.</p>
    <textarea id="curriculum" placeholder="# Course: Your Course Title&#10;Outcome: ...&#10;&#10;## Module: ...&#10;### Lesson: ...&#10;#### Step: ...&#10;Instructions: ...&#10;Expected result: ...&#10;Problem: ...&#10;  Fix: ..."></textarea>
    <button id="btn-curriculum">Check &amp; upload</button>
    <label style="display:inline-flex;align-items:center;gap:.4rem;font-weight:400;margin-top:.6rem">
      <input type="checkbox" id="force" style="width:auto"> Upload anyway if there are errors (draft only — can't go live yet)
    </label>
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
</div>

<script>
(function () {
  const base = location.origin;
  let token = '';
  let creatorId = '';
  let creatorSlug = '';

  document.getElementById('webhook-url').textContent = base + '/webhooks/xai';

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
  async function call(path, body) {
    const res = await fetch(base + path, {
      method: 'POST',
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
      show('creator', 'ok', 'Created — <code>' + res.id + '</code> (slug: ' + res.slug + ')');
      complete('creator');
      unlock('curriculum');
    } catch (e) {
      show('creator', 'err', e.message);
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
    } catch (e) {
      show('publish', 'err', e.message);
    }
  };
})();
</script>
</body>
</html>`;
