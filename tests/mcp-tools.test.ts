import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDb, type DB } from '../src/db/index.js';
import { parseCurriculumMarkdown } from '../src/curriculum/parse-markdown.js';
import { ingestCourse } from '../src/curriculum/ingest.js';
import { getOrCreateEnrollment } from '../src/state/transitions.js';
import { callTool, type ToolContext } from '../src/mcp/tools.js';
import { topUp } from '../src/billing/wallet.js';
import { id, now } from '../src/util/ids.js';
import type { McpSession } from '../src/mcp/auth.js';
import type { Enrollment } from '../src/domain/types.js';

const SAMPLE = readFileSync('examples/curriculum-sample.md', 'utf8');

function makeWorld(db: DB, label: string) {
  const creatorId = id('creator');
  db.prepare(
    `INSERT INTO creators (id, slug, business_name, coach_name, escalation_policy, escalation_phone,
                           price_per_minute_cents, created_at, updated_at)
     VALUES (?, ?, ?, 'Coach', 'offer_human', '+15550100200', 75, ?, ?)`,
  ).run(creatorId, `slug-${label}-${creatorId}`, `${label} Co`, now(), now());

  const { courseId } = ingestCourse(
    db,
    creatorId,
    parseCurriculumMarkdown(SAMPLE.replace('The Open Crumb Method', `${label} Method`)),
  );

  const customerId = id('cust');
  db.prepare(
    `INSERT INTO customers (id, creator_id, name, phone_e164, verified_at, created_at)
     VALUES (?, ?, 'Dana Whitfield', ?, ?, ?)`,
  ).run(customerId, creatorId, `+1555${Math.floor(Math.random() * 10_000_000)}`, now(), now());

  const enrollment = getOrCreateEnrollment(db, customerId, courseId);
  topUp(db, { customerId, creatorId, seconds: 1800, paidCents: 2250 });

  const callId = id('call');
  db.prepare(
    `INSERT INTO calls (id, xai_call_id, creator_id, customer_id, enrollment_id, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
  ).run(callId, `xai_${callId}`, creatorId, customerId, enrollment.id, now());

  const session: McpSession = {
    token_hash: 'hash',
    call_id: callId,
    creator_id: creatorId,
    customer_id: customerId,
    enrollment_id: enrollment.id,
    course_id: courseId,
    expires_at: now() + 3600,
    revoked_at: null,
    created_at: now(),
  };

  return { creatorId, courseId, customerId, enrollment, callId, session };
}

function ctxFor(db: DB, session: McpSession): ToolContext {
  return { db, session };
}

describe('caller-scoped tools', () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it('reports position and progress for an identified caller', async () => {
    const world = makeWorld(db, 'Open');
    const res = await callTool(ctxFor(db, world.session), 'get_caller_state', {});
    const data = res.data as Record<string, unknown>;

    expect(data.identified).toBe(true);
    expect(data.first_name).toBe('Dana');
    expect(String(data.position)).toContain('Module 1');
    expect(data.minutes_remaining).toBe(30);
  });

  it('withholds everything from an unidentified caller', async () => {
    const world = makeWorld(db, 'Open');
    const anon: McpSession = { ...world.session, customer_id: null, enrollment_id: null };

    for (const tool of ['get_caller_state', 'get_current_step', 'record_progress']) {
      const res = await callTool(ctxFor(db, anon), tool, { event: 'completed_step' });
      const data = res.data as Record<string, unknown>;
      expect(data.identified).toBe(false);
      expect(JSON.stringify(data)).not.toContain('Dana');
    }
  });

  it('serves step material with the creator\'s troubleshooting attached', async () => {
    const world = makeWorld(db, 'Open');
    const res = await callTool(ctxFor(db, world.session), 'get_current_step', {});
    const data = res.data as Record<string, any>;

    expect(data.position).toContain('Module 1');
    expect(data.expected_result).toContain('double');
    expect(data.common_problems.length).toBe(3);
    // Nothing internal is exposed to the model.
    expect(JSON.stringify(data)).not.toMatch(/step_[a-f0-9]{8}/);
  });

  it('cannot reach another creator\'s course through any tool', async () => {
    const mine = makeWorld(db, 'Open');
    makeWorld(db, 'Rival');

    const byPosition = await callTool(ctxFor(db, mine.session), 'get_step_by_position', { module: 2, step: 1 });
    expect(JSON.stringify(byPosition.data)).not.toContain('Rival');

    const search = await callTool(ctxFor(db, mine.session), 'search_curriculum', { query: 'dough temperature' });
    expect(JSON.stringify(search.data)).not.toContain('Rival');

    const diagnose = await callTool(ctxFor(db, mine.session), 'diagnose_problem', { symptom: 'dough is soupy' });
    expect(JSON.stringify(diagnose.data)).not.toContain('Rival');
  });
});

describe('grounding behaviour', () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it('tells the coach to refuse rather than improvise when nothing matches', async () => {
    const world = makeWorld(db, 'Open');
    const res = await callTool(ctxFor(db, world.session), 'search_curriculum', {
      query: 'quarterly tax filing deadlines for sole traders',
    });
    const data = res.data as Record<string, unknown>;

    expect(data.found).toBe(false);
    expect(String(data.message)).toMatch(/does not cover/i);
    expect(String(data.message)).toMatch(/general knowledge/i);
  });

  it('returns the documented fix for a symptom at the caller\'s step', async () => {
    const world = makeWorld(db, 'Open');
    const res = await callTool(ctxFor(db, world.session), 'diagnose_problem', {
      symptom: 'my starter smells like nail polish remover',
    });
    const data = res.data as Record<string, any>;

    expect(data.found).toBe(true);
    expect(JSON.stringify(data.troubleshooting)).toContain('twice a day');
  });

  it('marks material pulled from elsewhere in the course as needing a check', async () => {
    const world = makeWorld(db, 'Open');
    const res = await callTool(ctxFor(db, world.session), 'diagnose_problem', {
      symptom: 'the loaf is gummy inside after cooling',
    });
    const data = res.data as Record<string, any>;

    expect(data.found).toBe(true);
    expect(data.from_elsewhere).toBe(true);
    expect(String(data.guidance)).toMatch(/check it fits/i);
  });
});

describe('progress recording', () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it('advances the caller when a step completes', async () => {
    const world = makeWorld(db, 'Open');
    const res = await callTool(ctxFor(db, world.session), 'record_progress', { event: 'completed_step' });
    const data = res.data as Record<string, any>;

    expect(data.recorded).toBe(true);
    expect(data.now_on).toContain('float test');

    const after = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(world.enrollment.id) as Enrollment;
    expect(after.current_step_id).not.toBe(world.enrollment.current_step_id);
  });

  it('records a problem without moving the caller', async () => {
    const world = makeWorld(db, 'Open');
    await callTool(ctxFor(db, world.session), 'record_progress', {
      event: 'hit_problem',
      problem: 'Starter never doubles',
    });

    const after = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(world.enrollment.id) as Enrollment;
    expect(after.current_step_id).toBe(world.enrollment.current_step_id);

    const rows = db
      .prepare("SELECT * FROM state_transitions WHERE enrollment_id = ? AND event_type = 'hit_problem'")
      .all(world.enrollment.id);
    expect(rows).toHaveLength(1);
  });
});

describe('escalation', () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it('records the question for the creator when no transfer is wanted', async () => {
    const world = makeWorld(db, 'Open');
    const res = await callTool(ctxFor(db, world.session), 'request_human', {
      reason: 'Asked about sourdough for a commercial bakery, not covered',
      question: 'How do I scale this to fifty loaves?',
    });

    expect((res.data as Record<string, unknown>).transferring).toBe(false);
    const escalations = db.prepare('SELECT * FROM escalations WHERE creator_id = ?').all(world.creatorId);
    expect(escalations).toHaveLength(1);
  });

  it('transfers when asked, and still logs the question', async () => {
    const world = makeWorld(db, 'Open');
    let transferredTo: string | null = null;

    const res = await callTool(
      {
        db,
        session: world.session,
        transferCall: async (target) => {
          transferredTo = target;
        },
      },
      'request_human',
      { reason: 'Caller asked for a person', transfer: true },
    );

    expect((res.data as Record<string, unknown>).transferring).toBe(true);
    expect(transferredTo).toBe('+15550100200');
    expect(db.prepare('SELECT * FROM escalations WHERE creator_id = ?').all(world.creatorId)).toHaveLength(1);
  });

  it('falls back to a message the coach can say when the transfer fails', async () => {
    const world = makeWorld(db, 'Open');
    const res = await callTool(
      {
        db,
        session: world.session,
        transferCall: async () => {
          throw new Error('SIP REFER rejected');
        },
      },
      'request_human',
      { reason: 'Caller asked for a person', transfer: true },
    );

    const data = res.data as Record<string, unknown>;
    expect(data.transferring).toBe(false);
    expect(String(data.say)).toMatch(/follow up/i);
  });
});
