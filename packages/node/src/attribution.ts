// The one attribution rule every SplitHub store follows. The memory store
// implements it in TypeScript (`attributeVariants`), the SQL stores run the
// query from `variantCountsSql`, and the cloud applies it at ingest
// (splithub-go/src/services/projectStore.ts). Change it here and there together.
//
//   1. A visitor counts once per experiment, in the variant of their earliest
//      exposure (same ts: smallest variant key).
//   2. A goal converts that visitor when its ts is at or after the exposure,
//      minus ATTRIBUTION_SKEW_MS: the Next middleware stamps exposures with the
//      server clock while goals carry the browser clock.
//   3. Goals from visitors who never saw the experiment are ignored.
//   4. Only the first GOAL_DAILY_CAP events of one goal per visitor and UTC day
//      count (ordered by ts, then id); past that only a loop is talking.
//   5. Revenue is the sum of numeric `props.revenue` over the counted goals,
//      per visitor; stores report the per-variant sum and sum of squares.

/** How far a goal may precede the exposure it converts, for clock differences between server and browser. */
export const ATTRIBUTION_SKEW_MS = 60_000;
/** Events of one goal from one visitor counted per UTC day. */
export const GOAL_DAILY_CAP = 50;
const DAY_MS = 86_400_000;

/** Unique exposed and unique converted visitors of one variant. */
export interface VariantCounts {
  variant: string;
  exposures: number;
  conversions: number;
  revenue?: number;
  revenueSum?: number;
  revenueSumSq?: number;
}

/** Per-variant counts every store returns: `revenueSum` / `revenueSumSq` are over per-visitor revenue (non-converted visitors add 0). */
export interface AttributedCounts extends VariantCounts {
  revenue: number;
  revenueSum: number;
  revenueSumSq: number;
}

/** The shape of an event the rule needs. */
export interface AttributionEvent {
  id: string;
  type: 'exposure' | 'goal';
  experiment: string | null;
  variant: string | null;
  goal: string | null;
  visitorId: string;
  ts: number;
  props: Record<string, unknown> | null;
}

export function revenueOf(props: Record<string, unknown> | null | undefined): number {
  const v = props?.revenue;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Reference implementation of the rule over events in memory. */
export function attributeVariants(events: Iterable<AttributionEvent>, experiment: string, goal: string): AttributedCounts[] {
  const first = new Map<string, { variant: string; ts: number }>();
  const goals = new Map<string, AttributionEvent[]>(); // visitor + day -> goal events
  for (const e of events) {
    if (e.type === 'exposure') {
      if (e.experiment !== experiment || !e.variant) continue;
      const prev = first.get(e.visitorId);
      if (prev === undefined || e.ts < prev.ts || (e.ts === prev.ts && e.variant < prev.variant)) first.set(e.visitorId, { variant: e.variant, ts: e.ts });
    } else if (e.goal === goal) {
      const key = `${e.visitorId}\u0000${e.ts - (e.ts % DAY_MS)}`;
      const list = goals.get(key) ?? [];
      list.push(e);
      goals.set(key, list);
    }
  }
  const counted = new Map<string, number[]>(); // visitor -> ts of counted goals
  const revenueByVisitor = new Map<string, number[]>();
  for (const list of goals.values()) {
    list.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const g of list.slice(0, GOAL_DAILY_CAP)) {
      (counted.get(g.visitorId) ?? counted.set(g.visitorId, []).get(g.visitorId)!).push(g.ts);
      (revenueByVisitor.get(g.visitorId) ?? revenueByVisitor.set(g.visitorId, []).get(g.visitorId)!).push(revenueOf(g.props));
    }
  }
  const out = new Map<string, AttributedCounts>();
  for (const [visitor, { variant, ts }] of first) {
    const row = out.get(variant) ?? { variant, exposures: 0, conversions: 0, revenue: 0, revenueSum: 0, revenueSumSq: 0 };
    row.exposures++;
    const times = counted.get(visitor) ?? [];
    const revenues = revenueByVisitor.get(visitor) ?? [];
    let converted = false;
    let revenue = 0;
    times.forEach((t, i) => {
      if (t < ts - ATTRIBUTION_SKEW_MS) return;
      converted = true;
      revenue += revenues[i]!;
    });
    if (converted) {
      row.conversions++;
      row.revenueSum += revenue;
      row.revenueSumSq += revenue * revenue;
      row.revenue = row.revenueSum;
    }
    out.set(variant, row);
  }
  return [...out.values()];
}

export type SqlDialect = 'sqlite' | 'postgres' | 'mysql';
export type AttributionParam = 'experiment' | 'goal' | 'project';

export interface VariantCountsSqlOptions {
  dialect: SqlDialect;
  /** Events table. Defaults to "splithub_events". */
  table?: string;
  /** Column partitioning a shared table by project (adapter-d1); bound from the `project` param. */
  projectColumn?: string;
}

export interface VariantCountsSql {
  sql: string;
  /** Names of the values to bind, in placeholder order (Postgres numbers them, so each name appears once). */
  params: AttributionParam[];
  /** Binds values in the right order. */
  bind(values: { experiment: string; goal: string; project?: string }): unknown[];
}

const IDENT = /^[a-z_][a-z0-9_]*$/i;

function revenueExpr(dialect: SqlDialect, alias: string): string {
  if (dialect === 'postgres') return `CASE WHEN jsonb_typeof(${alias}.props::jsonb -> 'revenue') = 'number' THEN (${alias}.props::jsonb ->> 'revenue')::float8 ELSE 0 END`;
  if (dialect === 'mysql') return `CASE WHEN JSON_TYPE(JSON_EXTRACT(${alias}.props, '$.revenue')) IN ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL') THEN JSON_EXTRACT(${alias}.props, '$.revenue') + 0 ELSE 0 END`;
  return `CASE WHEN json_type(${alias}.props, '$.revenue') IN ('integer', 'real') THEN json_extract(${alias}.props, '$.revenue') ELSE 0 END`;
}

/**
 * The attribution query for an events table with the columns of the SplitHub
 * stores (id, type, experiment, variant, goal, visitor_id, ts, props). Returns
 * one row per variant: variant, exposures, conversions, revenue_sum,
 * revenue_sum_sq. Derived tables only, no CTEs or window functions, so the same
 * shape runs on SQLite, D1, Postgres and MySQL 5.7.
 */
export function variantCountsSql(options: VariantCountsSqlOptions): VariantCountsSql {
  const { dialect } = options;
  const t = options.table ?? 'splithub_events';
  if (!IDENT.test(t)) throw new Error('[splithub] invalid table name');
  if (options.projectColumn !== undefined && !IDENT.test(options.projectColumn)) throw new Error('[splithub] invalid column name');

  const params: AttributionParam[] = [];
  const p = (name: AttributionParam): string => {
    if (dialect === 'postgres') {
      const i = params.indexOf(name);
      if (i >= 0) return `$${i + 1}`;
      params.push(name);
      return `$${params.length}`;
    }
    params.push(name);
    return '?';
  };
  const proj = (alias: string): string => (options.projectColumn ? `${alias}.${options.projectColumn} = ${p('project')} AND ` : '');

  // Placeholders are produced in text order, so build the string front to back.
  const fv = `SELECT x.visitor_id, MIN(x.ts) AS first_ts FROM ${t} x WHERE ${proj('x')}x.type = 'exposure' AND x.experiment = ${p('experiment')} GROUP BY x.visitor_id`;
  const fe = `SELECT MIN(e.variant) AS variant, fv.visitor_id, fv.first_ts
      FROM (${fv}) fv
      JOIN ${t} e ON ${proj('e')}e.type = 'exposure' AND e.experiment = ${p('experiment')} AND e.visitor_id = fv.visitor_id AND e.ts = fv.first_ts
      GROUP BY fv.visitor_id, fv.first_ts`;
  const goalJoin = `${proj('g')}g.type = 'goal' AND g.goal = ${p('goal')} AND g.visitor_id = fe.visitor_id AND g.ts >= fe.first_ts - ${ATTRIBUTION_SKEW_MS}
      AND (SELECT COUNT(*) FROM ${t} g2
           WHERE ${proj('g2')}g2.type = 'goal' AND g2.goal = g.goal AND g2.visitor_id = g.visitor_id
             AND g2.ts >= g.ts - (g.ts % ${DAY_MS}) AND (g2.ts < g.ts OR (g2.ts = g.ts AND g2.id < g.id))) < ${GOAL_DAILY_CAP}`;
  const sql = `SELECT v.variant AS variant, COUNT(*) AS exposures, SUM(v.converted) AS conversions,
       COALESCE(SUM(v.revenue), 0) AS revenue_sum, COALESCE(SUM(v.revenue * v.revenue), 0) AS revenue_sum_sq
FROM (
  SELECT fe.variant, fe.visitor_id,
         CASE WHEN COUNT(g.id) > 0 THEN 1 ELSE 0 END AS converted,
         COALESCE(SUM(${revenueExpr(dialect, 'g')}), 0) AS revenue
  FROM (${fe}) fe
  LEFT JOIN ${t} g ON ${goalJoin}
  GROUP BY fe.variant, fe.visitor_id
) v
GROUP BY v.variant`;

  return {
    sql,
    params,
    bind(values) {
      return params.map((name) => {
        const v = values[name];
        if (v === undefined) throw new Error(`[splithub] missing "${name}" for the attribution query`);
        return v;
      });
    },
  };
}

/** Turns a row of `variantCountsSql` (numbers may come back as strings from pg / mysql2) into counts. */
export function countsFromRow(row: Record<string, unknown>): AttributedCounts {
  const revenueSum = Number(row.revenue_sum ?? 0);
  return {
    variant: String(row.variant),
    exposures: Number(row.exposures ?? 0),
    conversions: Number(row.conversions ?? 0),
    revenue: revenueSum,
    revenueSum,
    revenueSumSq: Number(row.revenue_sum_sq ?? 0),
  };
}
