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
 *
 * Layout: a persistent left nav (a hamburger + slide-out drawer under
 * ~880px) with one panel visible at a time, instead of every section
 * stacked on one long page — see the mobile-scroll complaint this redesign
 * answers. Overview leads with what the AI actually did for the creator's
 * audience (who showed up, what happened to them, what they asked about),
 * not "142 knowledge items" — that count still exists, it just lives in
 * Content now, where it's a progress indicator instead of a headline.
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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #f6f5f2; color: #1b1a17;
    font-family: "Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 15px; line-height: 1.5; -webkit-font-smoothing: antialiased;
  }
  a { color: #1b1a17; } a:hover { color: #2a78d6; }

  .app { display: flex; min-height: 100vh; }

  /* ---------- rail / drawer ---------- */
  .rail {
    flex: 0 0 236px; background: #fdfcfa; border-right: 1px solid #e9e7e2;
    padding: 20px 14px 16px; display: flex; flex-direction: column;
    position: sticky; top: 0; height: 100vh;
  }
  .brand { display: flex; align-items: center; gap: 10px; padding: 0 8px 20px; }
  .mark { width: 30px; height: 30px; border-radius: 8px; background: #1b1a17; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; flex: 0 0 auto; }
  .brand b { display: block; font-size: 14.5px; font-weight: 600; letter-spacing: -.005em; }
  .brand span { display: block; font-size: 11.5px; color: #8e8b84; margin-top: 1px; }
  nav { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
  .nav-label { font-size: 10.5px; font-weight: 600; color: #a5a29a; text-transform: uppercase; letter-spacing: .09em; padding: 16px 8px 6px; }
  .nav-label:first-child { padding-top: 2px; }
  .nav-item { display: flex; align-items: center; gap: 10px; padding: 8px 8px; border-radius: 8px; font-size: 13.5px; font-weight: 500; color: #5b5852; cursor: pointer; min-height: 40px; }
  .nav-item svg { flex: 0 0 auto; opacity: .65; }
  .nav-item:hover { background: #f2f0eb; }
  .nav-item.active { background: #ecebe5; color: #1b1a17; font-weight: 600; }
  .nav-item.active svg { opacity: 1; }
  .rail-foot { margin-top: auto; padding-top: 14px; border-top: 1px solid #e9e7e2; }
  .signout { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px; border: none; background: none; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 500; color: #5b5852; cursor: pointer; }
  .signout:hover { background: #f2f0eb; }
  .scrim { display: none; position: fixed; inset: 0; background: rgba(20,18,14,.42); z-index: 3; }
  .scrim.open { display: block; }

  /* ---------- main area ---------- */
  .mainarea { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .topbar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; height: 60px; padding: 0 24px; background: #fdfcfa; border-bottom: 1px solid #e9e7e2; }
  .hbtn { display: none; width: 40px; height: 40px; align-items: center; justify-content: center; border: none; background: none; padding: 0; cursor: pointer; color: #1b1a17; border-radius: 9px; margin-left: -8px; }
  .hbtn:active { background: #f2f0eb; }
  .topbar .title { font-size: 15.5px; font-weight: 600; letter-spacing: -.01em; flex: 1; }
  .assistbtn { display: inline-flex; align-items: center; gap: 7px; font: inherit; font-weight: 600; font-size: 13px; padding: 8px 14px; border-radius: 9px; border: 1px solid #1b1a17; background: #1b1a17; color: #fff; cursor: pointer; }
  .assistbtn:disabled { opacity: .55; cursor: default; }
  #st-assistant.status { margin: 0 0 0 4px; }

  main { flex: 1; padding: 26px 36px 44px; }
  .panel[hidden] { display: none; }
  .panelhead { margin-bottom: 18px; }
  .panelhead h1 { font-size: 22px; font-weight: 600; letter-spacing: -.02em; margin: 0; }
  .panelhead p { margin: 3px 0 0; font-size: 13.5px; color: #7d7a73; }

  .card { background: #fff; border: 1px solid #e9e7e2; border-radius: 13px; padding: 20px 22px; margin-bottom: 14px; }
  .card h2 { font-size: 14.5px; font-weight: 600; letter-spacing: -.005em; margin: 0; }
  .card .sub { margin: 3px 0 0; font-size: 12.5px; color: #8e8b84; }
  .cardhead { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }

  /* ---------- hero band ---------- */
  .hero { background: #1b1a17; border-radius: 15px; padding: 26px 28px; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; gap: 34px; flex-wrap: wrap; }
  .hero-eyebrow { font-size: 10.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: rgba(255,255,255,.5); }
  .hero-value { font-size: 60px; font-weight: 700; letter-spacing: -.038em; line-height: 1; color: #fff; margin: 12px 0 8px; }
  .hero-label { font-size: 15px; font-weight: 500; color: rgba(255,255,255,.76); }
  .hero-delta { display: inline-flex; align-items: center; gap: 5px; margin-top: 14px; padding: 4px 10px 4px 8px; border-radius: 999px; background: rgba(255,255,255,.09); font-size: 12.5px; font-weight: 600; }
  .hero-delta.up { color: #4ec46e; } .hero-delta.down { color: #ef8686; } .hero-delta.flat { color: rgba(255,255,255,.6); }
  .hero-spark { flex: 0 0 auto; text-align: right; }
  .hero-spark .cap { font-size: 10.5px; font-weight: 500; letter-spacing: .05em; text-transform: uppercase; color: rgba(255,255,255,.38); margin-bottom: 8px; }

  /* ---------- funnel strip ---------- */
  .strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); padding: 0; }
  .metric { padding: 18px 16px; border-left: 1px solid #eeece7; }
  .metric:first-child { border-left: none; }
  .metric .mv { font-size: 25px; font-weight: 700; letter-spacing: -.025em; line-height: 1.1; }
  .metric .ml { font-size: 12px; color: #7d7a73; font-weight: 500; margin-top: 2px; }
  .chip { display: inline-flex; align-items: center; gap: 3px; font-size: 11.5px; font-weight: 600; margin-top: 10px; }
  .chip.up { color: #006300; } .chip.down { color: #b3261e; } .chip.flat { color: #8e8b84; }

  /* ---------- chart ---------- */
  .cols { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 14px; margin-bottom: 14px; }
  .cols > .card { margin-bottom: 0; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: #5b5852; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
  .chartwrap { position: relative; }
  .tip { position: absolute; top: 4px; transform: translateX(-50%); background: #1b1a17; color: #fff; border-radius: 9px; padding: 8px 11px; font-size: 12px; pointer-events: none; opacity: 0; transition: opacity .1s; white-space: nowrap; box-shadow: 0 6px 20px rgba(20,18,14,.22); }
  .tip.on { opacity: 1; }
  .tip-day { font-size: 10.5px; color: rgba(255,255,255,.55); font-weight: 500; margin-bottom: 5px; }
  .tip-row { display: flex; align-items: center; gap: 7px; margin-top: 3px; }
  .tip-row b { margin-left: auto; font-weight: 600; }
  .tip-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }

  /* ---------- topics ---------- */
  .topic { display: flex; align-items: center; gap: 10px; margin-bottom: 13px; }
  .topic .rank { flex: 0 0 15px; font-size: 11px; font-weight: 600; color: #b3afa6; }
  .topic .body { flex: 1; min-width: 0; }
  .topic .trow { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 5px; }
  .topic .name { font-size: 13px; font-weight: 500; }
  .topic .pct { font-size: 13px; font-weight: 600; }
  .track { height: 6px; background: #f0eee9; border-radius: 4px; overflow: hidden; }
  .fill { height: 100%; background: #2a78d6; border-radius: 4px; }
  .fill.muted { background: #cfccc4; }

  /* ---------- forms / lists (shared across panels) ---------- */
  h2.h2std { font-size: 1.02rem; margin: 0 0 .15rem; }
  .note { color: #8e8b84; font-size: .84rem; margin: 0 0 .9rem; }
  label { display: block; font-weight: 600; font-size: 12.5px; margin: 14px 0 6px; color: #45433e; }
  label:first-child { margin-top: 0; }
  input, textarea, select { width: 100%; padding: 9px 11px; font: inherit; font-size: 16px; border: 1px solid #dcd9d3; border-radius: 9px; background: #fff; color: inherit; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: #1b1a17; }
  textarea { min-height: 8rem; resize: vertical; font-size: 14px; }
  button { font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 9px; border: 1px solid #1b1a17; background: #1b1a17; color: #fff; cursor: pointer; font-size: 13.5px; }
  button:disabled { opacity: .5; cursor: default; }
  button.ghost { background: #fff; color: #1b1a17; border-color: #dcd9d3; }
  button.ghost:hover { border-color: #b9b5ac; }
  button.danger { background: #fff; color: #b3261e; border-color: #e4c3c0; padding: .3rem .6rem; font-size: .82rem; font-weight: 500; }
  .row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
  .grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
  .stats { display: flex; gap: 1.4rem; flex-wrap: wrap; margin: .2rem 0 0; }
  .stat b { display: block; font-size: 1.3rem; line-height: 1.2; }
  .stat span { color: #8e8b84; font-size: .8rem; }
  .pill { display: inline-block; padding: .15rem .5rem; border-radius: 999px; font-size: .76rem; font-weight: 600; }
  .pill.on { background: #e8f2ea; color: #16643a; }
  .pill.off { background: #fdecea; color: #b3261e; }
  .item { border: 1px solid #e9e7e2; border-radius: 11px; padding: .8rem .9rem; margin-bottom: .6rem; }
  .item h3 { font-size: .93rem; margin: 0 0 .35rem; }
  .trunc { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .item p { margin: .25rem 0; font-size: .88rem; color: #4a4a4f; }
  .bnd { background: #fff8e6; border-left: 3px solid #e0a800; padding: .4rem .6rem; margin-top: .5rem; font-size: .85rem; border-radius: 0 6px 6px 0; }
  .bnd b { color: #8a6100; }
  .status { font-size: .87rem; margin-top: .6rem; min-height: 1.2em; }
  .status.ok { color: #16643a; } .status.err { color: #b3261e; } .status.busy { color: #7d7a73; }
  .src { border: 1px dashed #dcd9d3; border-radius: 10px; padding: .8rem .9rem; margin-bottom: .6rem; }
  .reply { background: #f7f6f2; border-radius: 8px; padding: .8rem .9rem; white-space: pre-wrap; font-size: .89rem; margin-top: .7rem; }
  .msg { border: 1px solid #e9e7e2; border-radius: 10px; padding: .7rem .85rem; margin-bottom: .55rem; }
  .msg .mhead { display: flex; justify-content: space-between; align-items: baseline; gap: .6rem; margin-bottom: .35rem; flex-wrap: wrap; }
  .msg .mwho { font-weight: 700; font-size: .82rem; }
  .msg .mwho.recap { color: #8a6100; }
  .msg .mwhen { font-size: .76rem; color: #8e8b84; white-space: nowrap; }
  .msg .msubject { font-size: .8rem; color: #6d6d72; font-style: italic; margin-bottom: .3rem; }
  .msg .mbody { white-space: pre-wrap; font-size: .88rem; color: #3a3934; }
  table { width: 100%; border-collapse: collapse; font-size: .87rem; }
  th, td { text-align: left; padding: .45rem .3rem; border-bottom: 1px solid #f0eee9; }
  th { color: #8e8b84; font-weight: 600; font-size: .8rem; }
  details.advanced { margin-top: 4px; }
  details.advanced > summary { cursor: pointer; font-weight: 700; font-size: 1rem; padding: .4rem 0; }

  @media (max-width: 880px) {
    .rail {
      position: fixed; top: 0; left: 0; bottom: 0; z-index: 4; width: 82%; max-width: 300px;
      transform: translateX(-100%); transition: transform .22s cubic-bezier(.32,.72,0,1);
      box-shadow: 2px 0 26px rgba(20,18,14,.16); height: 100%;
    }
    .rail.open { transform: translateX(0); }
    .hbtn { display: flex; }
    main { padding: 18px 16px 40px; }
    .hero { padding: 20px; }
    .hero-value { font-size: 46px; }
    .hero-spark { display: none; }
    .strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .metric:nth-child(2n+1) { border-left: none; }
    .metric:nth-child(n+3) { border-top: 1px solid #eeece7; }
    .cols { grid-template-columns: 1fr; }
    .grid2 { grid-template-columns: 1fr; }
    .assistbtn span.label { display: none; }
  }
</style>
</head>
<body>
<div class="app">
  <div class="scrim" id="scrim"></div>
  <aside class="rail" id="rail">
    <div class="brand">
      <div class="mark" id="mark-letter">·</div>
      <div><b id="biz">Loading…</b><span id="sub"></span></div>
    </div>
    <nav id="nav">
      <div class="nav-label">Your AI</div>
      <div class="nav-item" data-view="overview">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16V9M7.7 16V4M12.3 16v-5M17 16V7"/></svg>
        <span>Overview</span>
      </div>
      <div class="nav-item" data-view="leads">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="7" r="2.6"/><path d="M2.5 16.5c0-2.8 2.5-4.6 5-4.6s5 1.8 5 4.6"/><circle cx="15" cy="8.3" r="2"/><path d="M13.5 11.9c2 .3 3.4 1.9 3.9 4.1"/></svg>
        <span>Leads</span>
      </div>
      <div class="nav-item" data-view="offers">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3H5a1 1 0 0 0-1 1v6l9 9 7-7-9-9Z"/><circle cx="7.6" cy="7.6" r="1.1"/></svg>
        <span>Offers</span>
      </div>
      <div class="nav-label">Setup</div>
      <div class="nav-item" data-view="content">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h6l4 4v10a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M12 3v4h4"/></svg>
        <span>Content</span>
      </div>
      <div class="nav-item" data-view="voice">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h2.4l1.1 3.4-1.6 1.4a10.6 10.6 0 0 0 4.9 4.9l1.4-1.6L16.6 12.6v2.7c0 1-.8 1.8-1.8 1.7C8.9 16.5 4 11.6 3.3 5.9 3.2 4.9 4 3 5 3Z"/></svg>
        <span>Voice escalation</span>
      </div>
      <div class="nav-item" data-view="connect">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3v4M13 3v4M5 7h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5V7Z"/><path d="M10 15v2"/></svg>
        <span>Connect agent</span>
      </div>
      <div class="nav-item" data-view="settings">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="2.6"/><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.1 5.1l1.4 1.4M13.5 13.5l1.4 1.4M5.1 14.9l1.4-1.4M13.5 6.5l1.4-1.4"/></svg>
        <span>Settings</span>
      </div>
    </nav>
    <div class="rail-foot">
      <button class="signout" id="btn-logout" type="button">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 17H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3M13 13.5 16.5 10 13 6.5M16.5 10H8"/></svg>
        <span>Log out</span>
      </button>
    </div>
  </aside>

  <div class="mainarea">
    <div class="topbar">
      <button class="hbtn" id="btn-hamburger" type="button">
        <svg width="21" height="21" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 5.5h14M3 10h14M3 14.5h14"/></svg>
      </button>
      <div class="title" id="page-title">Overview</div>
      <button class="assistbtn" id="btn-assistant" type="button">🎙️ <span class="label">Talk to your assistant</span></button>
      <span class="status" id="st-assistant"></span>
    </div>

    <main>
      <!-- ================= OVERVIEW ================= -->
      <section class="panel" data-panel="overview">
        <p class="note" id="email-line"></p>
        <div class="hero" id="hero"></div>
        <div class="card strip" id="funnel-strip" style="padding:0"></div>

        <div class="cols">
          <div class="card">
            <div class="cardhead">
              <div><h2 class="h2std">Audience activity</h2><p class="sub">Conversations and leads, day by day — last 30 days.</p></div>
              <div class="legend">
                <div class="legend-item"><span class="legend-dot" style="background:#2a78d6"></span>Conversations</div>
                <div class="legend-item"><span class="legend-dot" style="background:#eb6834"></span>Leads</div>
              </div>
            </div>
            <div class="chartwrap" id="chartwrap"></div>
          </div>

          <div class="card">
            <div class="cardhead"><div><h2 class="h2std">What they're asking about</h2><p class="sub">Share of tagged topics, last 30 days.</p></div></div>
            <div id="topics-list"></div>
          </div>
        </div>

        <div class="card">
          <h2 class="h2std">Try a question</h2>
          <p class="note">Exactly what a real email would produce, without sending anything or saving a prospect.</p>
          <textarea id="q" style="min-height:5rem" placeholder="Ask the sort of thing someone would email you…"></textarea>
          <div class="row" style="margin-top:.6rem"><button id="btn-try">See the reply</button></div>
          <div class="status" id="st-try"></div>
          <div id="try-out"></div>
        </div>
      </section>

      <!-- ================= LEADS ================= -->
      <section class="panel" data-panel="leads" hidden>
        <div class="panelhead"><h1>Leads</h1><p>Every address that has emailed in is a lead the moment it arrives. The conversation enriches it from there — situation, real problem, goal, what's in the way — until there's enough to judge an offer honestly. That's "qualified".</p></div>
        <div class="card">
          <h2 class="h2std">All time</h2>
          <div class="stats" id="lead-funnel" style="margin-top:.6rem"></div>
          <div class="row" style="margin-top:1rem"><a id="btn-export-csv" class="ghost" style="text-decoration:none;font-weight:600;padding:9px 16px;border-radius:9px;border:1px solid #dcd9d3;color:#1b1a17;font-size:13.5px" href="#">Export CSV</a></div>
        </div>
        <div id="prospects"></div>
      </section>

      <!-- ================= OFFERS ================= -->
      <section class="panel" data-panel="offers" hidden>
        <div class="panelhead"><h1>Offers</h1><p>Two kinds. <b>Free</b> things — your videos, guides, tools — get sent any time they'd genuinely help. <b>Paid</b> things are only recommended once it understands their situation, the real problem, and what they want.</p></div>
        <div class="card">
          <div id="offers"></div>
          <details id="offer-add-details">
            <summary style="cursor:pointer;font-size:.9rem;margin-top:.5rem;font-weight:600">Add an offer</summary>
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
              is on. Everything here is spoken from directly; nothing is invented beyond it.</p>
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
        </div>
      </section>

      <!-- ================= CONTENT ================= -->
      <section class="panel" data-panel="content" hidden>
        <div class="panelhead"><h1>Content</h1><p>What the coach can actually answer from.</p></div>
        <div class="card">
          <h2 class="h2std">Add material</h2>
          <p class="note">Paste anything you already have — a video transcript, an FAQ, a newsletter, notes. It gets broken into
            problem-and-answer pairs. Nothing is invented: if your material doesn't answer something, it's left out rather than made up.</p>
          <div id="sources"></div>
          <div class="row">
            <button class="ghost" id="btn-add-src" type="button">+ Another block</button>
            <button id="btn-ingest">Add to knowledge</button>
          </div>
          <div class="status" id="st-ingest"></div>
        </div>

        <div class="card">
          <h2 class="h2std">YouTube channel</h2>
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
        </div>

        <details class="advanced" id="advanced-details">
          <summary>Advanced — the raw knowledge base</summary>
          <p class="note" style="margin:.5rem 0 .9rem">This is the coach's actual memory, item by item — every extracted
            question-and-answer pair, and any videos that disagreed closely enough to need your call. Most days you'll
            never open this; it's here for when a reply sounds off and you want to see or fix exactly where that came from.</p>
          <div class="card">
            <h2 class="h2std">Knowledge</h2>
            <p class="note">A <b>boundary</b> is the only thing that makes it mention a paid offer — items without one get
              answered in full and never pitch. Edit or delete anything that's wrong.</p>
            <div id="knowledge"></div>
          </div>
          <div class="card">
            <h2 class="h2std">Sync conflicts</h2>
            <p class="note">Places where two videos said close to the same thing, close enough that agreement wasn't
              confirmed automatically. Nothing was merged or guessed at — this could be a real difference in advice, or
              just different wording for the same point. Only you know which.</p>
            <div id="yt-conflicts"></div>
          </div>
        </details>
      </section>

      <!-- ================= VOICE ESCALATION ================= -->
      <section class="panel" data-panel="voice" hidden>
        <div class="panelhead"><h1>Voice escalation</h1><p>When someone writes in showing real interest, instead of a written reply they get a warm
          invitation to call — and the call itself is the real sales conversation: discovery, a diagnosis they
          confirm out loud, and only then an honestly-earned offer. This is not a smaller version of email; it's
          where the actual conversion happens.</p></div>
        <div class="card">
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
        </div>
      </section>

      <!-- ================= CONNECT AGENT ================= -->
      <section class="panel" data-panel="connect" hidden>
        <div class="panelhead"><h1>Connect your own agent</h1><p>The same assistant you can talk to above, reachable from Claude Desktop or any MCP-capable agent of
          your own. Creating one gives you a single link — paste that in as the connector, nothing else to configure. It's
          shown to you exactly once, so copy it before closing this. <b>Treat it like a password:</b> it can read and
          change everything above, including sending email as you, for as long as it exists. Revoke it any time you no
          longer recognize it.</p></div>
        <div class="card">
          <label>Label (so you can tell keys apart later)</label>
          <input id="mcpkey-label" placeholder="e.g. my laptop, Claude Desktop">
          <div class="row" style="margin-top:.6rem"><button id="btn-mcpkey-create" class="ghost" type="button">Create a key</button></div>
          <div class="status" id="st-mcpkey"></div>
          <div id="mcpkey-new" style="display:none;margin-top:.7rem">
            <label>Paste this in as the connector — copy it now, it will not be shown again</label>
            <div class="row">
              <input id="mcpkey-url" readonly style="flex:1">
              <button id="btn-mcpkey-copy" class="ghost" type="button" style="flex:0 0 auto">Copy</button>
            </div>
          </div>
          <div id="mcpkey-list" style="margin-top:.8rem"></div>
        </div>
      </section>

      <!-- ================= SETTINGS ================= -->
      <section class="panel" data-panel="settings" hidden>
        <div class="panelhead"><h1>Settings</h1><p>Voice, persona, and login.</p></div>
        <div class="card">
          <h2 class="h2std">Voice</h2>
          <p class="note">How it writes. Changes apply to the next reply.</p>
          <div class="grid2">
            <div><label>Name it signs as</label><input id="s-coach"></div>
            <div><label>Who you're talking to</label><input id="s-audience"></div>
          </div>
          <label>How you sound</label><textarea id="s-style" style="min-height:4rem"></textarea>
          <div class="row" style="margin-top:.7rem"><button id="btn-settings">Save</button></div>
          <div class="status" id="st-settings"></div>
        </div>
        <div class="card">
          <h2 class="h2std">Login</h2>
          <p class="note">Change the password you use to log in.</p>
          <div class="grid2">
            <div><label>Current password</label><input id="pw-current" type="password" autocomplete="current-password"></div>
            <div><label>New password</label><input id="pw-new" type="password" autocomplete="new-password"></div>
          </div>
          <div class="row" style="margin-top:.7rem"><button id="btn-pw" class="ghost">Change password</button></div>
          <div class="status" id="st-pw"></div>
        </div>
      </section>
    </main>
  </div>
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
  function fmt(n) { return (n == null ? 0 : n).toLocaleString(); }

  // ---- nav / panel switching
  var VIEWS = ['overview', 'leads', 'offers', 'content', 'voice', 'connect', 'settings'];
  var TITLES = { overview: 'Overview', leads: 'Leads', offers: 'Offers', content: 'Content', voice: 'Voice escalation', connect: 'Connect your own agent', settings: 'Settings' };
  var navItems = [].slice.call(document.querySelectorAll('.nav-item'));

  function closeDrawer() { el('rail').classList.remove('open'); el('scrim').classList.remove('open'); }
  function openDrawer() { el('rail').classList.add('open'); el('scrim').classList.add('open'); }

  function switchView(view, pushHash) {
    if (VIEWS.indexOf(view) === -1) view = 'overview';
    document.querySelectorAll('.panel').forEach(function (p) {
      p.hidden = p.getAttribute('data-panel') !== view;
    });
    navItems.forEach(function (n) {
      n.classList.toggle('active', n.getAttribute('data-view') === view);
    });
    el('page-title').textContent = TITLES[view];
    document.title = TITLES[view] + ' · Coach dashboard';
    if (pushHash !== false && location.hash !== '#' + view) location.hash = view;
    closeDrawer();
    window.scrollTo(0, 0);
  }

  navItems.forEach(function (n) {
    n.addEventListener('click', function () { switchView(n.getAttribute('data-view')); });
  });
  el('btn-hamburger').onclick = openDrawer;
  el('scrim').onclick = closeDrawer;
  window.addEventListener('hashchange', function () { switchView(location.hash.slice(1), false); });
  switchView(location.hash ? location.hash.slice(1) : 'overview', false);

  // ---- overview
  function loadOverview() {
    return api('/api/creators/' + CID + '/overview').then(function (d) {
      el('biz').textContent = d.creator.business_name;
      el('mark-letter').textContent = (d.creator.business_name || '?').trim().charAt(0).toUpperCase() || '?';
      el('sub').textContent = 'Answering as ' + d.creator.coach_name + ' · ' + d.creator.status;
      el('lead-funnel').innerHTML =
        '<div class="stat"><b>' + fmt(d.counts.leads) + '</b><span>leads captured</span></div>' +
        '<div class="stat"><b>' + fmt(d.counts.qualified) + '</b><span>qualified</span></div>' +
        '<div class="stat"><b>' + fmt(d.counts.offers_presented) + '</b><span>offers presented</span></div>' +
        '<div class="stat"><b>' + fmt(d.counts.offer_clicks) + '</b><span>offer clicks</span></div>';
      el('email-line').innerHTML = d.email
        ? '<span class="pill on">Live</span> Answering mail sent to <b>' + esc(d.email.gmail_address) + '</b>, checked every minute.'
        : '<span class="pill off">Not connected</span> No inbox connected yet, so nothing is being answered.';
      el('s-coach').value = d.creator.coach_name || '';
      el('s-audience').value = d.creator.audience || '';
      el('s-style').value = d.creator.teaching_style || '';
      renderVoice(d.voice);
      renderActivity(d.activity);
    });
  }

  // ---- activity (Overview hero / funnel / chart / topics) — all real
  // numbers from /overview's activity block (see workers/leadgen/activity.ts).
  function deltaChip(m) {
    if (m.deltaPct == null) return '<span class="chip up">' + upIcon() + 'New</span>';
    var abs = Math.abs(m.deltaPct);
    if (m.dir === 'flat') return '<span class="chip flat">Flat vs last 30d</span>';
    var icon = m.dir === 'up' ? upIcon() : downIcon();
    return '<span class="chip ' + m.dir + '">' + icon + abs + '% vs last 30d</span>';
  }
  function upIcon() { return '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:2px"><path d="M2.5 7.6 6 4.1l3.5 3.5"/></svg>'; }
  function downIcon() { return '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:2px"><path d="M2.5 4.4 6 7.9l3.5-3.5"/></svg>'; }

  function heroSparkPath(values, w, h) {
    var max = 0;
    for (var i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
    if (max <= 0) max = 1;
    var n = values.length;
    var pts = values.map(function (v, i) {
      var x = (i / (n - 1)) * w;
      var y = h - 6 - (v / max) * (h - 16);
      return (i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
    });
    return { line: pts.join(' '), area: 'M0,' + h + ' ' + pts.map(function (p) { return p.replace(/^M/, 'L'); }).join(' ') + ' L' + w + ',' + h + ' Z' };
  }

  function renderActivity(a) {
    if (!a) { el('hero').innerHTML = ''; el('funnel-strip').innerHTML = ''; el('chartwrap').innerHTML = ''; el('topics-list').innerHTML = ''; return; }

    // ---- hero
    var spark = heroSparkPath(a.trend.conversations, 330, 104);
    el('hero').innerHTML =
      '<div>' +
        '<div class="hero-eyebrow">Last 30 days</div>' +
        '<div class="hero-value">' + fmt(a.hero.value) + '</div>' +
        '<div class="hero-label">' + esc(a.hero.label) + '</div>' +
        '<div class="hero-delta ' + a.hero.dir + '">' + (a.hero.deltaPct == null ? 'New this period' : (a.hero.deltaPct > 0 ? '+' : '') + a.hero.deltaPct + '% vs the 30 days before') + '</div>' +
      '</div>' +
      '<div class="hero-spark">' +
        '<div class="cap">Daily, last 30 days</div>' +
        '<svg width="330" height="104" viewBox="0 0 330 104" style="display:block">' +
          '<defs><linearGradient id="heroFade" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="#86b6ef" stop-opacity="0.34"/><stop offset="100%" stop-color="#86b6ef" stop-opacity="0"/>' +
          '</linearGradient></defs>' +
          '<path d="' + spark.area + '" fill="url(#heroFade)"/>' +
          '<path d="' + spark.line + '" fill="none" stroke="#86b6ef" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
        '</svg>' +
      '</div>';

    // ---- funnel strip
    el('funnel-strip').innerHTML = a.funnel.map(function (m) {
      return '<div class="metric"><div class="mv">' + fmt(m.value) + '</div><div class="ml">' + esc(m.label) + '</div>' + deltaChip(m) + '</div>';
    }).join('');

    // ---- trend chart (real daily conversations + leads, last 30 days)
    renderTrendChart(a.trend);

    // ---- topics
    var topics = a.topics || [];
    if (!topics.length) {
      el('topics-list').innerHTML = '<p class="note">Nothing tagged yet — this fills in as more conversations happen.</p>';
    } else {
      el('topics-list').innerHTML = topics.map(function (t, i) {
        return '<div class="topic">' +
          '<span class="rank">' + (i + 1) + '</span>' +
          '<div class="body"><div class="trow"><span class="name">' + esc(t.name) + '</span><span class="pct">' + t.pct + '%</span></div>' +
          '<div class="track"><div class="fill' + (t.name === 'Everything else' ? ' muted' : '') + '" style="width:' + t.pct + '%"></div></div></div>' +
        '</div>';
      }).join('');
    }
  }

  function renderTrendChart(trend) {
    var days = trend.days, conv = trend.conversations, leads = trend.leads;
    var n = days.length;
    var W = 560, H = 210, PL = 30, PR = 46, PT = 14, PB = 26;
    var PW = W - PL - PR, PH = H - PT - PB;
    var maxV = 0;
    for (var i = 0; i < n; i++) { if (conv[i] > maxV) maxV = conv[i]; if (leads[i] > maxV) maxV = leads[i]; }
    var yMax = Math.max(4, Math.ceil(maxV / 4) * 4);
    function xAt(i) { return PL + (n > 1 ? (i / (n - 1)) * PW : PW / 2); }
    function yAt(v) { return PT + PH - (v / yMax) * PH; }
    function pts(a) { return a.map(function (v, i) { return xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1); }).join(' '); }
    function area(a) {
      var d = 'M' + xAt(0).toFixed(1) + ',' + yAt(a[0]).toFixed(1);
      for (var i = 1; i < a.length; i++) d += ' L' + xAt(i).toFixed(1) + ',' + yAt(a[i]).toFixed(1);
      d += ' L' + xAt(a.length - 1).toFixed(1) + ',' + yAt(0).toFixed(1) + ' L' + xAt(0).toFixed(1) + ',' + yAt(0).toFixed(1) + ' Z';
      return d;
    }
    var gy0 = yAt(0).toFixed(1), gy1 = yAt(yMax / 2).toFixed(1), gy2 = yAt(yMax).toFixed(1);
    var plotR = (PL + PW).toFixed(1), labelX = (PL + PW + 9).toFixed(1);
    var endConvY = yAt(conv[n - 1]).toFixed(1), endLeadY = yAt(leads[n - 1]).toFixed(1);

    el('chartwrap').innerHTML =
      '<svg id="trend-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block;cursor:crosshair">' +
        '<defs>' +
          '<linearGradient id="convFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2a78d6" stop-opacity="0.13"/><stop offset="100%" stop-color="#2a78d6" stop-opacity="0"/></linearGradient>' +
          '<linearGradient id="leadFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#eb6834" stop-opacity="0.13"/><stop offset="100%" stop-color="#eb6834" stop-opacity="0"/></linearGradient>' +
        '</defs>' +
        '<line x1="' + PL + '" y1="' + gy0 + '" x2="' + plotR + '" y2="' + gy0 + '" stroke="#e9e7e2" stroke-width="1"/>' +
        '<line x1="' + PL + '" y1="' + gy1 + '" x2="' + plotR + '" y2="' + gy1 + '" stroke="#f0eee9" stroke-width="1"/>' +
        '<line x1="' + PL + '" y1="' + gy2 + '" x2="' + plotR + '" y2="' + gy2 + '" stroke="#f0eee9" stroke-width="1"/>' +
        '<text x="0" y="' + gy0 + '" dy="3.5" font-size="10.5" fill="#a5a29a">0</text>' +
        '<text x="0" y="' + gy1 + '" dy="3.5" font-size="10.5" fill="#a5a29a">' + Math.round(yMax / 2) + '</text>' +
        '<text x="0" y="' + gy2 + '" dy="3.5" font-size="10.5" fill="#a5a29a">' + yMax + '</text>' +
        '<text x="' + PL + '" y="204" font-size="10.5" fill="#a5a29a">' + esc(days[0]) + '</text>' +
        '<text x="' + plotR + '" y="204" font-size="10.5" fill="#a5a29a" text-anchor="end">' + esc(days[n - 1]) + '</text>' +
        '<path d="' + area(conv) + '" fill="url(#convFade)"/>' +
        '<path d="' + area(leads) + '" fill="url(#leadFade)"/>' +
        '<g id="trend-hover" style="display:none"><line id="trend-hover-line" y1="' + PT + '" y2="' + gy0 + '" stroke="#c9c5bc" stroke-width="1"/>' +
          '<circle id="trend-hover-conv" r="4.5" fill="#2a78d6" stroke="#fff" stroke-width="2"/>' +
          '<circle id="trend-hover-lead" r="4.5" fill="#eb6834" stroke="#fff" stroke-width="2"/></g>' +
        '<polyline points="' + pts(conv) + '" fill="none" stroke="#2a78d6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<polyline points="' + pts(leads) + '" fill="none" stroke="#eb6834" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<circle cx="' + plotR + '" cy="' + endConvY + '" r="4" fill="#2a78d6" stroke="#fff" stroke-width="2"/>' +
        '<circle cx="' + plotR + '" cy="' + endLeadY + '" r="4" fill="#eb6834" stroke="#fff" stroke-width="2"/>' +
        '<text x="' + labelX + '" y="' + endConvY + '" dy="4" font-size="11.5" font-weight="600" fill="#45433e">' + conv[n - 1] + '</text>' +
        '<text x="' + labelX + '" y="' + endLeadY + '" dy="4" font-size="11.5" font-weight="600" fill="#45433e">' + leads[n - 1] + '</text>' +
      '</svg>' +
      '<div class="tip" id="trend-tip"><div class="tip-day" id="trend-tip-day"></div>' +
        '<div class="tip-row"><span class="tip-dot" style="background:#2a78d6"></span>Conversations<b id="trend-tip-conv"></b></div>' +
        '<div class="tip-row"><span class="tip-dot" style="background:#eb6834"></span>Leads<b id="trend-tip-lead"></b></div></div>';

    var svg = el('trend-svg');
    svg.addEventListener('mousemove', function (e) {
      var rect = svg.getBoundingClientRect();
      var relX = ((e.clientX - rect.left) / rect.width) * W;
      var idx = Math.round(((relX - PL) / PW) * (n - 1));
      idx = Math.max(0, Math.min(n - 1, idx));
      var hx = xAt(idx);
      el('trend-hover').style.display = 'block';
      el('trend-hover-line').setAttribute('x1', hx); el('trend-hover-line').setAttribute('x2', hx);
      el('trend-hover-conv').setAttribute('cx', hx); el('trend-hover-conv').setAttribute('cy', yAt(conv[idx]));
      el('trend-hover-lead').setAttribute('cx', hx); el('trend-hover-lead').setAttribute('cy', yAt(leads[idx]));
      var tip = el('trend-tip');
      tip.classList.add('on');
      tip.style.left = Math.max(14, Math.min(86, (hx / W) * 100)) + '%';
      el('trend-tip-day').textContent = days[idx];
      el('trend-tip-conv').textContent = conv[idx];
      el('trend-tip-lead').textContent = leads[idx];
    });
    svg.addEventListener('mouseleave', function () {
      el('trend-hover').style.display = 'none';
      el('trend-tip').classList.remove('on');
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
  // section. Lives in the topbar, which is present on every panel. Opens
  // in a new tab, same as the qualification test call above.
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

  // ---- transcript (the actual email exchange, verbatim — distinct from
  // the extracted "Full record" fields above, which are the AI's
  // understanding OF the conversation, not the conversation itself).
  function renderTranscript(messages) {
    if (!messages.length) return '<p class="note">No messages recorded yet.</p>';
    return messages.map(function (m) {
      var isRecap = m.kind === 'call_recap';
      var who = m.direction === 'inbound' ? 'They wrote' : (isRecap ? 'Internal call recap' : 'We replied');
      var when = new Date(m.created_at * 1000).toLocaleString();
      return '<div class="msg">' +
        '<div class="mhead"><span class="mwho' + (isRecap ? ' recap' : '') + '">' + esc(who) + '</span><span class="mwhen">' + esc(when) + '</span></div>' +
        (m.subject ? '<div class="msubject">' + esc(m.subject) + '</div>' : '') +
        '<div class="mbody">' + esc(m.body) + '</div>' +
        (m.routed_offer_name ? '<p class="note" style="margin-top:.4rem">Routed to: ' + esc(m.routed_offer_name) + '</p>' : '') +
        '</div>';
    }).join('');
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
          '<div class="row" style="margin-top:.5rem">' +
            '<button class="danger p-toggle" type="button">Full record</button>' +
            '<button class="danger p-transcript-toggle" type="button">View transcript</button>' +
          '</div>' +
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
          '</div>' +
          '<div class="p-transcript" style="display:none;margin-top:.6rem"></div>';
        n.querySelector('.p-toggle').onclick = function () {
          var detail = n.querySelector('.p-detail');
          detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
        };
        var transcriptBox = n.querySelector('.p-transcript');
        var transcriptLoaded = false;
        n.querySelector('.p-transcript-toggle').onclick = function () {
          var willShow = transcriptBox.style.display === 'none';
          if (willShow && !transcriptLoaded) {
            transcriptBox.innerHTML = '<p class="note">Loading…</p>';
            transcriptBox.style.display = 'block';
            api('/api/creators/' + CID + '/prospects/' + p.id + '/messages').then(function (d2) {
              transcriptLoaded = true;
              transcriptBox.innerHTML = renderTranscript(d2.messages || []);
            }).catch(function (e) {
              transcriptBox.innerHTML = '<p class="note">Could not load: ' + esc(e.message) + '</p>';
            });
          } else {
            transcriptBox.style.display = willShow ? 'block' : 'none';
          }
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
        el('mcpkey-url').value = d.connector_url;
        el('mcpkey-new').style.display = 'block';
        el('mcpkey-label').value = '';
        return loadMcpKeys();
      })
      .catch(function (e) { show('st-mcpkey', 'err', e.message); });
  };

  el('btn-mcpkey-copy').onclick = function () {
    el('mcpkey-url').select();
    navigator.clipboard.writeText(el('mcpkey-url').value)
      .then(function () { show('st-mcpkey', 'ok', 'Copied.'); })
      .catch(function () { show('st-mcpkey', 'err', 'Could not copy automatically — select the text and copy it yourself.'); });
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
