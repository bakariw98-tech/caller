import type { SqlDb } from '../db/types.js';

/**
 * Backs the dashboard's Overview panel — the redesign that replaced "142
 * knowledge items" (an implementation detail) with numbers about what the
 * AI actually did for the creator's audience: who showed up, what happened
 * to them, and what they were asking about. Every number here is a real
 * query result, nothing synthesized — see each field's own comment for
 * exactly what it counts and why that's the honest way to count it.
 */

interface DeltaRow {
  askers_30d: number;
  askers_prev30d: number;
  new_leads_30d: number;
  new_leads_prev30d: number;
  qualified_30d: number;
  qualified_prev30d: number;
  offers_recommended_30d: number;
  offers_recommended_prev30d: number;
  link_clicks_30d: number;
  link_clicks_prev30d: number;
}

interface CallsAcceptedRow {
  n: number;
}

interface DailyRow {
  day: string;
  n: number;
}

interface TopicRow {
  topics_json: string;
}

export interface FunnelMetric {
  key: string;
  label: string;
  value: number;
  deltaPct: number | null;
  dir: 'up' | 'down' | 'flat';
}

export interface TopicShare {
  name: string;
  count: number;
  pct: number;
}

export interface ActivitySummary {
  hero: FunnelMetric;
  funnel: FunnelMetric[];
  trend: { days: string[]; conversations: number[]; leads: number[] };
  topics: TopicShare[];
}

export function computeDelta(cur: number, prev: number): { pct: number | null; dir: 'up' | 'down' | 'flat' } {
  // prev === 0 with cur > 0 is not a meaningful percentage (division by
  // zero) — the frontend reads a null pct as "new this period" rather than
  // inventing a number like "∞%" or silently showing 0%.
  if (prev === 0) return { pct: null, dir: cur > 0 ? 'up' : 'flat' };
  const pct = Math.round(((cur - prev) / prev) * 100);
  return { pct, dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' };
}

function metric(key: string, label: string, cur: number, prev: number): FunnelMetric {
  const d = computeDelta(cur, prev);
  return { key, label, value: cur, deltaPct: d.pct, dir: d.dir };
}

/**
 * Every prospect's topics_json is a lifetime-accumulated set (see
 * prospects.ts's applyProspectSignals — new topics are unioned onto
 * whatever was there before), not a per-message log. Scoping to prospects
 * active in the last 30 days (last_seen_at) is therefore an approximation
 * of "what people asked about this month", not an exact one: a prospect
 * who returns this month after months away still carries old topic tags
 * alongside anything new. Good enough to be genuinely useful, honest about
 * its limits in this comment rather than the UI.
 */
export function tallyTopics(rows: TopicRow[]): TopicShare[] {
  const counts = new Map<string, { display: string; count: number }>();
  let total = 0;
  for (const row of rows) {
    let arr: unknown;
    try {
      arr = JSON.parse(row.topics_json || '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { display: trimmed, count: 1 });
      total += 1;
    }
  }
  const sorted = [...counts.values()].sort((a, b) => b.count - a.count);
  const top = sorted.slice(0, 5);
  const restCount = sorted.slice(5).reduce((sum, t) => sum + t.count, 0);
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  const result: TopicShare[] = top.map((t) => ({ name: t.display, count: t.count, pct: pct(t.count) }));
  if (restCount > 0) result.push({ name: 'Everything else', count: restCount, pct: pct(restCount) });
  return result;
}

/** Fills every day in [today-29, today] (UTC, matching SQLite's date('unixepoch')) with 0 where the query found nothing, so the chart never has a gap. */
export function fillDaily(rows: DailyRow[], days: number, nowSeconds: number): { keys: string[]; values: number[] } {
  const map = new Map(rows.map((r) => [r.day, r.n]));
  const todayMs = nowSeconds * 1000;
  const keys: string[] = [];
  const values: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(todayMs - i * 86_400_000).toISOString().slice(0, 10);
    keys.push(key);
    values.push(map.get(key) ?? 0);
  }
  return { keys, values };
}

export async function buildActivitySummary(
  db: SqlDb,
  creatorId: string,
  since30d: number,
  prev30dStart: number,
  nowSeconds: number,
): Promise<ActivitySummary> {
  const delta = await db
    .prepare(
      `SELECT
         (SELECT COUNT(DISTINCT prospect_id) FROM prospect_messages
            WHERE creator_id = ? AND direction = 'inbound' AND created_at >= ?) AS askers_30d,
         (SELECT COUNT(DISTINCT prospect_id) FROM prospect_messages
            WHERE creator_id = ? AND direction = 'inbound' AND created_at >= ? AND created_at < ?) AS askers_prev30d,
         (SELECT COUNT(*) FROM prospects WHERE creator_id = ? AND first_seen_at >= ?) AS new_leads_30d,
         (SELECT COUNT(*) FROM prospects WHERE creator_id = ? AND first_seen_at >= ? AND first_seen_at < ?) AS new_leads_prev30d,
         (SELECT COUNT(*) FROM prospects WHERE creator_id = ? AND qualified_at >= ?) AS qualified_30d,
         (SELECT COUNT(*) FROM prospects WHERE creator_id = ? AND qualified_at >= ? AND qualified_at < ?) AS qualified_prev30d,
         (SELECT COUNT(DISTINCT prospect_id) FROM prospect_messages
            WHERE creator_id = ? AND routed_offer_id IS NOT NULL AND created_at >= ?) AS offers_recommended_30d,
         (SELECT COUNT(DISTINCT prospect_id) FROM prospect_messages
            WHERE creator_id = ? AND routed_offer_id IS NOT NULL AND created_at >= ? AND created_at < ?) AS offers_recommended_prev30d,
         (SELECT COUNT(DISTINCT oc.prospect_id) FROM offer_clicks oc JOIN offers o ON o.id = oc.offer_id
            WHERE oc.creator_id = ? AND o.is_free = 0 AND oc.clicked_at >= ?) AS link_clicks_30d,
         (SELECT COUNT(DISTINCT oc.prospect_id) FROM offer_clicks oc JOIN offers o ON o.id = oc.offer_id
            WHERE oc.creator_id = ? AND o.is_free = 0 AND oc.clicked_at >= ? AND oc.clicked_at < ?) AS link_clicks_prev30d`,
    )
    .get<DeltaRow>(
      creatorId, since30d,
      creatorId, prev30dStart, since30d,
      creatorId, since30d,
      creatorId, prev30dStart, since30d,
      creatorId, since30d,
      creatorId, prev30dStart, since30d,
      creatorId, since30d,
      creatorId, prev30dStart, since30d,
      creatorId, since30d,
      creatorId, prev30dStart, since30d,
    );
  const d: DeltaRow =
    delta ?? {
      askers_30d: 0, askers_prev30d: 0, new_leads_30d: 0, new_leads_prev30d: 0,
      qualified_30d: 0, qualified_prev30d: 0, offers_recommended_30d: 0, offers_recommended_prev30d: 0,
      link_clicks_30d: 0, link_clicks_prev30d: 0,
    };

  const callsAcceptedPrev = await db
    .prepare(
      `SELECT COUNT(DISTINCT c.prospect_id) AS n FROM calls c
        WHERE c.creator_id = ? AND c.kind = 'qualification' AND c.started_at >= ? AND c.started_at < ? AND c.prospect_id IS NOT NULL`,
    )
    .get<CallsAcceptedRow>(creatorId, prev30dStart, since30d);
  const callsAcceptedCur = await db
    .prepare(
      `SELECT COUNT(DISTINCT c.prospect_id) AS n FROM calls c
        WHERE c.creator_id = ? AND c.kind = 'qualification' AND c.started_at >= ? AND c.prospect_id IS NOT NULL`,
    )
    .get<CallsAcceptedRow>(creatorId, since30d);

  const convDailyRows = await db
    .prepare(
      `SELECT date(created_at, 'unixepoch') AS day, COUNT(DISTINCT prospect_id) AS n
         FROM prospect_messages WHERE creator_id = ? AND direction = 'inbound' AND created_at >= ?
        GROUP BY day`,
    )
    .all<DailyRow>(creatorId, since30d);
  const leadsDailyRows = await db
    .prepare(
      `SELECT date(first_seen_at, 'unixepoch') AS day, COUNT(*) AS n
         FROM prospects WHERE creator_id = ? AND first_seen_at >= ?
        GROUP BY day`,
    )
    .all<DailyRow>(creatorId, since30d);
  const conv = fillDaily(convDailyRows, 30, nowSeconds);
  const leads = fillDaily(leadsDailyRows, 30, nowSeconds);

  const topicRows = await db
    .prepare('SELECT topics_json FROM prospects WHERE creator_id = ? AND last_seen_at >= ?')
    .all<TopicRow>(creatorId, since30d);
  const topics = tallyTopics(topicRows);

  return {
    hero: metric('askers', 'People who asked your AI for help', d.askers_30d, d.askers_prev30d),
    funnel: [
      metric('new_leads', 'New leads', d.new_leads_30d, d.new_leads_prev30d),
      metric('qualified', 'Qualified', d.qualified_30d, d.qualified_prev30d),
      metric('offers_recommended', 'Offers recommended', d.offers_recommended_30d, d.offers_recommended_prev30d),
      metric('link_clicks', 'Link clicks', d.link_clicks_30d, d.link_clicks_prev30d),
      metric('calls_accepted', 'Calls accepted', callsAcceptedCur?.n ?? 0, callsAcceptedPrev?.n ?? 0),
    ],
    trend: { days: conv.keys, conversations: conv.values, leads: leads.values },
    topics,
  };
}
