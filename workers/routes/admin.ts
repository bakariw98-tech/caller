import { Hono } from 'hono';
import type { Env } from '../env.js';
import { loadAppConfig } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { id, now, slugify } from '../../src/util/ids.js';
import type { Course, Creator } from '../../src/domain/types.js';
import { assertPriceAllowed, PriceBelowFloorError } from '../billing/pricing.js';
import { parseCurriculumMarkdown, CurriculumParseError } from '../../src/curriculum/parse-markdown.js';
import { ingestCourse, StructureLostError } from '../curriculum/ingest.js';
import { auditStructure } from '../../src/curriculum/schema.js';
import { createBudget } from '../billing/promotional.js';
import { mintCallToken } from '../mcp/auth.js';
import { buildCoachInstructions } from '../../src/coach/prompt.js';
import { renderCourseToMarkdown } from '../../src/curriculum/render-markdown.js';
import { structureCurriculum, NoUsableSourceError, type RawSource } from '../curriculum/structure.js';

export const adminRoute = new Hono<{ Bindings: Env }>();

/**
 * Creator onboarding and management API — port of src/web/creator-routes.ts's
 * `/api/*` handlers. The dashboard and customer-facing pages (signup, OTP
 * verification, top-up) are not ported in this pass; see docs/DEPLOY.md for
 * what that means for a first test and how to seed a customer directly.
 *
 * Deliberately scoped to this file's own exact routes, NOT a blanket
 * '/api/*' — found live, the hard way, adding the creator login: every
 * `app.route('/', someRoute)` in workers/app.ts mounts at the SAME base
 * path, so Hono flattens every sub-app's `.use()` middleware into one
 * router matched purely by pattern. A blanket '/api/*' here ran on EVERY
 * `/api/*` request in the whole app, including leadgen.ts's and phone-
 * numbers.ts's own routes — and since admin.ts is registered first in
 * app.ts, its admin-token-only check ran (and rejected) before those
 * files' own, more permissive, creator-session-aware checks ever got a
 * chance to execute. Harmless before that gap existed (every file's
 * middleware checked the identical ADMIN_TOKEN, so which one "won" never
 * mattered); silently breaking once one credential family diverged from
 * the others. This file's own routes are genuinely operator-only
 * (creating a creator, curriculum, publishing, agent setup) — the exact
 * path list below, not a wildcard, is what keeps that true without
 * leaking onto anyone else's routes again.
 */
// Exact paths, not patterns with wildcards — deliberately checked with a
// regex per entry (matching `:id`-style segments loosely) rather than
// relying on Hono's own multi-pattern `.use()` overload, which this
// version doesn't accept an array for. Still registered on the broad
// '/api/*' below for compatibility; the narrowing happens inside the
// handler by checking the actual path against this list, so a request
// for a path admin.ts doesn't own just falls through via next() —
// exactly as if this middleware were never in the chain for it.
export const ADMIN_ROUTE_PATTERNS = [
  /^\/api\/creators$/,
  /^\/api\/creators\/[^/]+\/curriculum$/,
  /^\/api\/creators\/[^/]+\/curriculum\/structure$/,
  /^\/api\/curriculum\/audit$/,
  /^\/api\/creators\/[^/]+\/promotional-budget$/,
  /^\/api\/creators\/[^/]+\/publish$/,
  /^\/api\/creators\/[^/]+\/agent-setup$/,
];
adminRoute.use('/api/*', async (c, next) => {
  if (!ADMIN_ROUTE_PATTERNS.some((re) => re.test(c.req.path))) return next();

  const token = c.env.ADMIN_TOKEN;
  if (!token) return c.json({ error: 'ADMIN_TOKEN is not configured' }, 503);
  const header = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  const query = c.req.query('key');
  if (header !== token && query !== token) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

adminRoute.post('/api/creators', async (c) => {
  const db = wrapD1(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const businessName = String(body.business_name ?? '').trim();
  const coachName = String(body.coach_name ?? '').trim();
  if (!businessName || !coachName) return c.json({ error: 'business_name and coach_name are required' }, 400);

  const cfg = loadAppConfig(c.env);
  const price = Number(body.price_per_minute_cents ?? cfg.minPricePerMinuteCents);
  try {
    assertPriceAllowed(price, cfg.minPricePerMinuteCents);
  } catch (err) {
    if (err instanceof PriceBelowFloorError) return c.json({ error: err.message }, 400);
    throw err;
  }

  const creatorId = id('creator');
  const slug = slugify(String(body.slug ?? businessName));
  await db
    .prepare(
      `INSERT INTO creators
         (id, slug, business_name, coach_name, coach_voice, brand_json, welcome_message,
          outcome, audience, methodology, teaching_style, always_do_json, never_do_json,
          ask_questions_when, escalation_policy, escalation_phone, price_per_minute_cents,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    )
    .run(
      creatorId,
      slug,
      businessName,
      coachName,
      String(body.coach_voice ?? 'eve'),
      JSON.stringify(body.brand ?? {}),
      body.welcome_message ? String(body.welcome_message) : null,
      body.outcome ? String(body.outcome) : null,
      body.audience ? String(body.audience) : null,
      body.methodology ? String(body.methodology) : null,
      body.teaching_style ? String(body.teaching_style) : null,
      JSON.stringify(body.always_do ?? []),
      JSON.stringify(body.never_do ?? []),
      body.ask_questions_when ? String(body.ask_questions_when) : null,
      String(body.escalation_policy ?? 'offer_human'),
      body.escalation_phone ? String(body.escalation_phone) : null,
      price,
      now(),
      now(),
    );

  return c.json({ id: creatorId, slug, status: 'draft' }, 201);
});

adminRoute.post('/api/creators/:id/curriculum', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(creatorId);
  if (!creator) return c.json({ error: 'creator not found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { markdown?: string; force?: boolean };
  if (!body.markdown?.trim()) return c.json({ error: 'markdown is required' }, 400);

  let parsed;
  try {
    parsed = parseCurriculumMarkdown(body.markdown);
  } catch (err) {
    const detail = err instanceof CurriculumParseError ? err.message : err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Could not read the course structure', detail }, 400);
  }

  try {
    const res = await ingestCourse(db, creatorId, parsed, { force: body.force === true });
    return c.json({
      course_id: res.courseId,
      modules: res.moduleCount,
      lessons: res.lessonCount,
      steps: res.stepCount,
      problems: res.problemCount,
      references: res.referenceCount,
      issues: res.issues,
    });
  } catch (err) {
    if (err instanceof StructureLostError) {
      return c.json(
        {
          error: 'The course structure did not survive import',
          issues: err.issues,
          hint: 'Every step needs instructions and an expected result.',
        },
        422,
      );
    }
    throw err;
  }
});

/**
 * Turns a creator's raw material — course docs, how-to guides, the questions
 * they get asked constantly, video transcripts — into structured curriculum.
 *
 * Deliberately saves nothing. It returns a *draft* in the ordinary authoring
 * format plus the audit and the source quotes behind each step, so the
 * creator reviews and edits real text and then posts it to the normal
 * curriculum endpoint. Machine-extracted material gets no shortcut around
 * the structure audit or around human approval — see curriculum/structure.ts
 * for why that matters more here than anywhere else in this codebase.
 */
adminRoute.post('/api/creators/:id/curriculum/structure', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(creatorId);
  if (!creator) return c.json({ error: 'creator not found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    sources?: { kind?: string; title?: string; text?: string }[];
    course_title?: string;
  };

  const allowed = new Set(['curriculum', 'guide', 'faq', 'roadblocks', 'transcript', 'notes']);
  const sources: RawSource[] = (body.sources ?? [])
    .filter((s) => typeof s.text === 'string' && s.text.trim())
    .map((s) => ({
      kind: (allowed.has(String(s.kind)) ? String(s.kind) : 'notes') as RawSource['kind'],
      title: s.title?.trim() || undefined,
      text: String(s.text),
    }));

  if (sources.length === 0) return c.json({ error: 'Add some material to work from first.' }, 400);

  try {
    const result = await structureCurriculum({
      apiBase: c.env.XAI_API_BASE,
      apiKey: c.env.XAI_API_KEY,
      model: c.env.XAI_TEXT_MODEL,
      sources,
      courseTitleHint: body.course_title?.trim() || undefined,
    });

    const markdown = renderCourseToMarkdown(result.course);
    const issues = auditStructure(result.course);
    const stepCount = result.course.modules.flatMap((m) => m.lessons.flatMap((l) => l.steps)).length;

    return c.json({
      markdown,
      issues,
      provenance: result.provenance,
      counts: {
        modules: result.course.modules.length,
        lessons: result.course.modules.flatMap((m) => m.lessons).length,
        steps: stepCount,
        problems: result.course.modules
          .flatMap((m) => m.lessons.flatMap((l) => l.steps))
          .reduce((n, s) => n + s.problems.length, 0),
        references: result.course.references.length,
      },
      usage: result.usage,
      note:
        'Draft only — nothing has been saved. Blanks are deliberate: the material did not state them, ' +
        'and inventing them would put words in your mouth. Fill them in, then upload.',
    });
  } catch (err) {
    if (err instanceof NoUsableSourceError) return c.json({ error: err.message }, 400);
    console.error('structuring failed', err);
    return c.json(
      { error: 'Could not structure that material', detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

adminRoute.post('/api/curriculum/audit', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { markdown?: string };
  if (!body.markdown?.trim()) return c.json({ error: 'markdown is required' }, 400);
  try {
    const parsed = parseCurriculumMarkdown(body.markdown);
    return c.json({
      title: parsed.title,
      modules: parsed.modules.length,
      steps: parsed.modules.flatMap((m) => m.lessons.flatMap((l) => l.steps)).length,
      issues: auditStructure(parsed),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

adminRoute.post('/api/creators/:id/promotional-budget', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; minutes?: number; per_customer_minutes?: number };

  const budget = await createBudget(db, {
    creatorId,
    name: String(body.name ?? 'Trial campaign'),
    fundedSeconds: Math.max(0, Number(body.minutes ?? 0)) * 60,
    perCustomerSecondsCap: Math.max(1, Number(body.per_customer_minutes ?? 10)) * 60,
  });
  return c.json(budget, 201);
});

adminRoute.post('/api/creators/:id/publish', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');

  const course = await db
    .prepare('SELECT * FROM courses WHERE creator_id = ? ORDER BY created_at DESC LIMIT 1')
    .get<Course>(creatorId);
  if (!course) return c.json({ error: 'Upload a curriculum before going live' }, 400);

  const steps = await db.prepare('SELECT COUNT(*) AS n FROM steps WHERE course_id = ?').get<{ n: number }>(course.id);
  if (!steps || steps.n === 0) return c.json({ error: 'This course has no steps' }, 400);

  const numberCount = await db
    .prepare('SELECT COUNT(*) AS n FROM phone_numbers WHERE creator_id = ?')
    .get<{ n: number }>(creatorId);
  if (!numberCount || numberCount.n === 0) {
    return c.json({ error: 'Provision a phone number first' }, 400);
  }

  await db.prepare("UPDATE creators SET status = 'live', updated_at = ? WHERE id = ?").run(now(), creatorId);
  return c.json({ status: 'live' });
});

/**
 * Everything a creator needs to paste into xAI's console for a console-
 * managed Voice Agent: the standing instructions and the MCP tool URL, with
 * a long-lived creator-scoped token embedded in it.
 *
 * This exists because of a real limitation, not a missing convenience:
 * xAI's Voice Agent Builder has no API for configuring an Agent on this
 * account (`/v1/agents` -> 403, confirmed) — a human has to paste both of
 * these into the console by hand, for every creator, every time. What this
 * endpoint controls is *what* gets pasted: the instructions are generated
 * from the creator's actual stored fields (methodology, always/never rules,
 * escalation policy — the same buildCoachInstructions() the webhook path
 * uses), not hand-written per creator in a chat window, so onboarding a
 * tenth creator produces this exactly as reliably as the first did.
 *
 * The token is bound to this creator only — never a customer or a call, since
 * there is no per-call session on this integration to bind it to (see
 * mcp/tools.ts's resolveIdentity for how identity actually gets resolved on
 * every tool call instead). A `calls` row backs it purely because
 * mcp_sessions.call_id is a foreign key; it is not a real call and nothing
 * about it behaves like one.
 */
adminRoute.post('/api/creators/:id/agent-setup', async (c) => {
  const db = wrapD1(c.env.DB);
  const creatorId = c.req.param('id');
  const creator = await db.prepare('SELECT * FROM creators WHERE id = ?').get<Creator>(creatorId);
  if (!creator) return c.json({ error: 'creator not found' }, 404);

  const course = await db
    .prepare('SELECT * FROM courses WHERE creator_id = ? ORDER BY created_at DESC LIMIT 1')
    .get<Course>(creatorId);
  if (!course) return c.json({ error: 'Upload a curriculum before generating agent setup' }, 400);

  const instructions = buildCoachInstructions({
    creator,
    course,
    identified: false,
    identityMode: 'passcode',
  });

  const callId = id('call');
  await db
    .prepare(
      `INSERT INTO calls (id, xai_call_id, creator_id, status, started_at)
       VALUES (?, ?, ?, 'active', ?)`,
    )
    .run(callId, `console_agent_${callId}`, creatorId, now());

  const token = await mintCallToken(db, c.env.MCP_TOKEN_SECRET, 365 * 24 * 3600, {
    callId,
    creatorId,
    customerId: null,
    enrollmentId: null,
    courseId: course.id,
  });

  return c.json({
    instructions,
    mcp_url: `${c.env.PUBLIC_BASE_URL}/mcp?token=${token}`,
    expires_in_days: 365,
    note: 'Paste "instructions" into the console\'s Instructions box and "mcp_url" into its Tools/MCP section.',
  });
});
