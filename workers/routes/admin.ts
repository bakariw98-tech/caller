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

export const adminRoute = new Hono<{ Bindings: Env }>();

/**
 * Creator onboarding and management API — port of src/web/creator-routes.ts's
 * `/api/*` handlers. The dashboard and customer-facing pages (signup, OTP
 * verification, top-up) are not ported in this pass; see docs/DEPLOY.md for
 * what that means for a first test and how to seed a customer directly.
 */
adminRoute.use('/api/*', async (c, next) => {
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
