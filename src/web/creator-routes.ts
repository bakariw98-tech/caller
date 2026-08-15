import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { id, now, slugify } from '../util/ids.js';
import type { Course, Creator } from '../domain/types.js';
import { dashboardPage, esc, money } from './views.js';
import { assertPriceAllowed, PriceBelowFloorError } from '../billing/pricing.js';
import { parseCurriculumMarkdown } from '../curriculum/parse-markdown.js';
import { ingestCourse, StructureLostError } from '../curriculum/ingest.js';
import { auditStructure } from '../curriculum/schema.js';
import {
  clarificationThemes,
  coachPerformance,
  openEscalations,
  stuckPoints,
} from '../analytics/curriculum-intelligence.js';
import { createBudget } from '../billing/promotional.js';

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!config.adminToken) {
    if (config.env === 'development') return true;
    reply.code(503).send({ error: 'ADMIN_TOKEN must be configured outside development' });
    return false;
  }
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const query = (req.query as { key?: string }).key;
  if (header === config.adminToken || query === config.adminToken) return true;
  reply.code(401).send({ error: 'unauthorized' });
  return false;
}

/**
 * Creator-facing surface: onboarding and the dashboard.
 *
 * The onboarding questions are about teaching, not configuration — a creator
 * should feel like they are launching a product, not assembling one. Nothing
 * here asks them to think about voices, prompts, tools or retrieval.
 */
export function registerCreatorRoutes(app: FastifyInstance): void {
  // ------------------------------------------------------------- onboarding --

  app.post('/api/creators', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const businessName = String(body.business_name ?? '').trim();
    const coachName = String(body.coach_name ?? '').trim();
    if (!businessName || !coachName) {
      return reply.code(400).send({ error: 'business_name and coach_name are required' });
    }

    const price = Number(body.price_per_minute_cents ?? config.economics.minPricePerMinuteCents);
    try {
      assertPriceAllowed(price);
    } catch (err) {
      if (err instanceof PriceBelowFloorError) return reply.code(400).send({ error: err.message });
      throw err;
    }

    const creatorId = id('creator');
    const slug = slugify(String(body.slug ?? businessName));
    getDb()
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

    return reply.code(201).send({ id: creatorId, slug, status: 'draft' });
  });

  /**
   * Curriculum upload.
   *
   * Answers with the structure audit rather than a bare success, because the
   * useful feedback at this moment is "step 4 has no expected result" — the
   * thing that would quietly turn the coach into a chatbot.
   */
  app.post('/api/creators/:id/curriculum', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const creatorId = (req.params as { id: string }).id;
    const creator = getDb().prepare('SELECT * FROM creators WHERE id = ?').get(creatorId) as
      | Creator
      | undefined;
    if (!creator) return reply.code(404).send({ error: 'creator not found' });

    const body = (req.body ?? {}) as { markdown?: string; force?: boolean };
    if (!body.markdown?.trim()) return reply.code(400).send({ error: 'markdown is required' });

    let parsed;
    try {
      parsed = parseCurriculumMarkdown(body.markdown);
    } catch (err) {
      return reply.code(400).send({
        error: 'Could not read the course structure',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const result = ingestCourse(getDb(), creatorId, parsed, { force: body.force === true });
      return reply.send({
        course_id: result.courseId,
        modules: result.moduleCount,
        lessons: result.lessonCount,
        steps: result.stepCount,
        problems: result.problemCount,
        references: result.referenceCount,
        issues: result.issues,
      });
    } catch (err) {
      if (err instanceof StructureLostError) {
        return reply.code(422).send({
          error: 'The course structure did not survive import',
          issues: err.issues,
          hint:
            'Every step needs instructions and an expected result. Without them the coach cannot tell ' +
            'a caller whether their result is right or what to do next.',
        });
      }
      throw err;
    }
  });

  /** Dry run: audit without writing, for the upload preview. */
  app.post('/api/curriculum/audit', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = (req.body ?? {}) as { markdown?: string };
    if (!body.markdown?.trim()) return reply.code(400).send({ error: 'markdown is required' });

    try {
      const parsed = parseCurriculumMarkdown(body.markdown);
      return reply.send({
        title: parsed.title,
        modules: parsed.modules.length,
        steps: parsed.modules.flatMap((m) => m.lessons.flatMap((l) => l.steps)).length,
        issues: auditStructure(parsed),
      });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/creators/:id/promotional-budget', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const creatorId = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { name?: string; minutes?: number; per_customer_minutes?: number };

    const budget = createBudget(getDb(), {
      creatorId,
      name: String(body.name ?? 'Trial campaign'),
      fundedSeconds: Math.max(0, Number(body.minutes ?? 0)) * 60,
      perCustomerSecondsCap: Math.max(1, Number(body.per_customer_minutes ?? 10)) * 60,
    });
    return reply.code(201).send(budget);
  });

  app.post('/api/creators/:id/publish', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const creatorId = (req.params as { id: string }).id;
    const db = getDb();

    const course = db
      .prepare('SELECT * FROM courses WHERE creator_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(creatorId) as Course | undefined;
    if (!course) return reply.code(400).send({ error: 'Upload a curriculum before going live' });

    const steps = db.prepare('SELECT COUNT(*) AS n FROM steps WHERE course_id = ?').get(course.id) as {
      n: number;
    };
    if (steps.n === 0) return reply.code(400).send({ error: 'This course has no steps' });

    const number = db
      .prepare('SELECT COUNT(*) AS n FROM phone_numbers WHERE creator_id = ?')
      .get(creatorId) as { n: number };
    if (number.n === 0) {
      return reply.code(400).send({ error: 'Provision a phone number first (npm run provision)' });
    }

    db.prepare("UPDATE creators SET status = 'live', updated_at = ? WHERE id = ?").run(now(), creatorId);
    return reply.send({ status: 'live' });
  });

  // -------------------------------------------------------------- dashboard --

  app.get('/dashboard/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const creatorId = (req.params as { id: string }).id;
    const db = getDb();
    const creator = db.prepare('SELECT * FROM creators WHERE id = ?').get(creatorId) as Creator | undefined;
    if (!creator) return reply.code(404).send('Not found');

    const perf = coachPerformance(db, creatorId);
    const stuck = stuckPoints(db, creatorId);
    const themes = clarificationThemes(db, creatorId);
    const escalations = openEscalations(db, creatorId, 10);

    const stat = (k: string, v: string) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;

    const body = `
      <h1>${esc(creator.coach_name)} — ${esc(creator.business_name)}</h1>

      <h2>Last 30 days</h2>
      <div class="grid">
        ${stat('Customers coached', String(perf.activeCustomers))}
        ${stat('Sessions', String(perf.sessions))}
        ${stat('Minutes', String(perf.minutes))}
        ${stat('Revenue', money(perf.revenueCents))}
        ${stat('Per customer', money(perf.revenuePerCustomerCents))}
        ${stat('Called again', String(perf.repeatCallers))}
        ${stat('Trial → paid', `${perf.trialConversionPercent.toFixed(0)}%`)}
        ${stat('Cost per hour', `$${perf.costPerHourDollars.toFixed(2)}`)}
      </div>

      <h2>What your customers get stuck on</h2>
      ${
        stuck.length === 0
          ? '<p class="muted">Nothing yet — this fills in as people call.</p>'
          : stuck
              .map(
                (s) => `<div class="insight">
                  <strong>Module ${s.moduleSeq}, ${esc(s.stepTitle)}</strong> came up in
                  ${s.sessionPercent.toFixed(0)}% of sessions (${s.problemCount} time${s.problemCount === 1 ? '' : 's'}).
                  ${s.sampleProblems.length ? `<div class="muted">e.g. "${esc(s.sampleProblems[0])}"</div>` : ''}
                </div>`,
              )
              .join('')
      }

      <h2>Words customers keep asking about</h2>
      ${
        themes.length === 0
          ? '<p class="muted">Nothing repeated yet.</p>'
          : `<p>${themes.map((t) => `${esc(t.term)} <span class="muted">(${t.occurrences})</span>`).join(' · ')}</p>`
      }

      <h2>Questions waiting on you</h2>
      ${
        escalations.length === 0
          ? '<p class="muted">None open.</p>'
          : `<table><tr><th>Customer</th><th>Step</th><th>Question</th></tr>${escalations
              .map(
                (e) =>
                  `<tr><td>${esc(e.customerName ?? '—')}</td><td>${esc(e.stepTitle ?? '—')}</td><td>${esc(
                    e.question ?? e.reason,
                  )}</td></tr>`,
              )
              .join('')}</table>`
      }`;

    return reply
      .type('text/html')
      .send(dashboardPage({ title: `${creator.coach_name} dashboard`, body }));
  });
}
