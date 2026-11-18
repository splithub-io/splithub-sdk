// Raw reads of analytics properties for self-hosted stores. Pageviews and custom
// events sit in the same events table as exposures and goals (`experiment` = the
// property key, `goal` = the event name). Self-hosted answers are counts only;
// reports with breakdowns, sessions, sources and conversions are SplitHub Cloud's.

import type { SplitHubConfig } from '@splithub/core';
import type { SqlDialect } from './attribution';
import { ANALYSIS_UNAVAILABLE } from './raw';
import type { PropertyCounts, Store, StoredEvent } from './store';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DAY_MS = 86_400_000;

export interface PropertyCountsSqlOptions {
  dialect: SqlDialect;
  /** Default `splithub_events`. */
  table?: string;
  /** Column holding the project name when one table serves several projects (D1 store). */
  projectColumn?: string;
}

type Param = 'project' | 'property' | 'since' | 'until' | 'before' | 'limit';

export interface PropertySql {
  sql: string;
  bind(values: Partial<Record<Param, unknown>>): unknown[];
}

/** The queries behind `propertyCounts` / `propertyEvents` for the SplitHub table layout, on SQLite, D1, Postgres and MySQL. */
export function propertyCountsSql(options: PropertyCountsSqlOptions): { totals: PropertySql; events: PropertySql; rows: PropertySql } {
  const t = options.table ?? 'splithub_events';
  if (!IDENT.test(t)) throw new Error('[splithub] invalid table name');
  if (options.projectColumn !== undefined && !IDENT.test(options.projectColumn)) throw new Error('[splithub] invalid column name');
  const build = (parts: (p: (name: Param) => string) => string): PropertySql => {
    const params: Param[] = [];
    const p = (name: Param): string => {
      params.push(name);
      return options.dialect === 'postgres' ? `$${params.length}` : '?';
    };
    const sql = parts(p);
    return {
      sql,
      bind: (values) =>
        params.map((name) => {
          // Stores generated before `until` existed bind only `since`: open-ended then.
          const v = name === 'until' && values.until === undefined ? Number.MAX_SAFE_INTEGER : values[name];
          if (v === undefined) throw new Error(`[splithub] missing "${name}" for the property query`);
          return v;
        }),
    };
  };
  const scope = (p: (name: Param) => string, types: string): string =>
    `${options.projectColumn ? `${options.projectColumn} = ${p('project')} AND ` : ''}type IN (${types}) AND experiment = ${p('property')}`;
  // Visitors and sessions come from pages and events; users are the distinct ids sent with identify.
  const seen = `type IN ('page', 'event')`;
  return {
    totals: build(
      (p) =>
        `SELECT SUM(CASE WHEN type = 'page' THEN 1 ELSE 0 END) AS pageviews, COUNT(DISTINCT CASE WHEN ${seen} THEN visitor_id END) AS visitors, COUNT(DISTINCT CASE WHEN ${seen} THEN session_id END) AS sessions, COUNT(DISTINCT CASE WHEN type = 'identify' THEN ${uidExpr(options.dialect)} END) AS users FROM ${t} WHERE ${scope(p, `'page', 'event', 'identify'`)} AND ts >= ${p('since')} AND ts < ${p('until')}`
    ),
    events: build(
      (p) =>
        `SELECT goal AS name, COUNT(*) AS count, COUNT(DISTINCT visitor_id) AS visitors FROM ${t} WHERE ${scope(p, `'event'`)} AND ts >= ${p('since')} AND ts < ${p('until')} GROUP BY goal ORDER BY count DESC LIMIT 200`
    ),
    rows: build((p) => `SELECT * FROM ${t} WHERE ${scope(p, `'page', 'event', 'engage', 'identify'`)} AND ts < ${p('before')} ORDER BY ts DESC LIMIT ${p('limit')}`),
  };
}

/** The user id of an identify row, from its JSON props. */
function uidExpr(dialect: SqlDialect): string {
  if (dialect === 'postgres') return `(props::jsonb ->> 'uid')`;
  if (dialect === 'mysql') return `JSON_UNQUOTE(JSON_EXTRACT(props, '$.uid'))`;
  return `json_extract(props, '$.uid')`;
}

/** Rows of `propertyCountsSql().totals` and `.events` (numbers may come back as strings from pg / mysql2) as counts. */
export function propertyCountsFromRows(totals: Record<string, unknown> | undefined, events: Array<Record<string, unknown>>): PropertyCounts {
  return {
    pageviews: Number(totals?.pageviews ?? 0),
    visitors: Number(totals?.visitors ?? 0),
    sessions: Number(totals?.sessions ?? 0),
    users: Number(totals?.users ?? 0),
    events: events.map((r) => ({ name: String(r.name), count: Number(r.count ?? 0), visitors: Number(r.visitors ?? 0) })),
  };
}

/** A row of `propertyCountsSql().rows` (snake_case columns) as a stored event. */
export function storedEventFromRow(r: Record<string, unknown>): StoredEvent {
  let props: Record<string, unknown> | null = null;
  if (typeof r.props === 'string') {
    try {
      props = JSON.parse(r.props) as Record<string, unknown>;
    } catch {
      props = null;
    }
  } else if (r.props && typeof r.props === 'object') props = r.props as Record<string, unknown>;
  const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return {
    id: String(r.id),
    type: String(r.type) as StoredEvent['type'],
    experiment: s(r.experiment),
    variant: s(r.variant),
    goal: s(r.goal),
    visitorId: String(r.visitor_id),
    sessionId: String(r.session_id),
    ts: Number(r.ts),
    url: s(r.url),
    props,
    receivedAt: Number(r.received_at ?? r.ts),
    host: s(r.host),
    country: s(r.country),
    device: s(r.device),
    browser: s(r.browser),
    // Columns added for apps; rows of stores without them keep the old shape.
    ...('platform' in r ? { platform: s(r.platform) } : {}),
    ...('app_version' in r ? { app_version: s(r.app_version) } : {}),
  };
}

export interface RawPropertyReport {
  property: string;
  status: string;
  name: string | null;
  description: string | null;
  goals: string[];
  /** Days counted: the last `days` days, or from..to. */
  days: number;
  /** The UTC days counted, both inclusive. */
  range: { from: string; to: string };
  counts: PropertyCounts | null;
  analysis: typeof ANALYSIS_UNAVAILABLE;
}

export const PROPERTY_REPORTS_UNAVAILABLE = {
  ...ANALYSIS_UNAVAILABLE,
  message: 'Reports with pages, sources, sessions and conversions come with SplitHub Cloud.',
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The span a raw property read covers: `from` / `to` (YYYY-MM-DD, UTC days, both inclusive; either
 * alone works) or the last `days` days. An error string for a malformed range.
 */
export function rawPropertyRange(options: { days?: number; from?: string | null; to?: string | null; now?: number }): { since: number; until: number; days: number; range: { from: string; to: string } } | string {
  const now = options.now ?? Date.now();
  const { from, to } = options;
  if ((from && !DAY.test(from)) || (to && !DAY.test(to))) return 'from and to are days like 2026-10-01';
  if (!from && !to) {
    const days = Math.max(1, Math.min(365, Math.floor(options.days ?? 30)));
    const since = now - days * DAY_MS;
    return { since, until: now + 1, days, range: { from: dayOf(since), to: dayOf(now) } };
  }
  const end = to ? Date.parse(`${to}T00:00:00Z`) + DAY_MS : now + 1;
  const since = from ? Date.parse(`${from}T00:00:00Z`) : end - 30 * DAY_MS;
  if (Number.isNaN(since) || Number.isNaN(end)) return 'from and to are days like 2026-10-01';
  if (since >= end) return 'from must be on or before to';
  const days = Math.ceil((end - since) / DAY_MS);
  if (days > 400) return 'a range covers at most 400 days';
  return { since, until: end, days, range: { from: dayOf(since), to: dayOf(end - 1) } };
}

/** Raw counts of one property of the config. Null for an unknown key; throws on a malformed range (check it with `rawPropertyRange` first). */
export async function rawPropertyReport(config: SplitHubConfig, store: Store, key: string, options: { days?: number; from?: string | null; to?: string | null; now?: number } = {}): Promise<RawPropertyReport | null> {
  const property = (config.properties ?? []).find((p) => p.key === key);
  if (!property) return null;
  const span = rawPropertyRange(options);
  if (typeof span === 'string') throw new Error(`[splithub] ${span}`);
  return {
    property: key,
    status: property.status,
    name: property.name ?? null,
    description: property.description,
    goals: property.goals,
    days: span.days,
    range: span.range,
    counts: store.propertyCounts ? await store.propertyCounts(key, span.since, span.until) : null,
    analysis: PROPERTY_REPORTS_UNAVAILABLE,
  };
}
