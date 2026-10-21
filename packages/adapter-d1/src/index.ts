import { countsFromRow, propertyCountsFromRows, propertyCountsSql, storedEventFromRow, variantCountsSql, type ExperimentSummary, type Store, type StoredEvent } from '@splithub/node';

/** Structural subset of Cloudflare's D1Database so this package has no Workers type dependency. */
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch<T = unknown>(statements: D1StatementLike[]): Promise<Array<{ success: boolean; meta?: { changes?: number } ; results?: T[] }>>;
}
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
}

export interface D1StoreOptions {
  /** Project id used to partition the shared events table. */
  project: string;
  /** Table name. Defaults to "sh_events". */
  table?: string;
  /** 'extended' also writes os, language, city, region, referrer and utm_* (columns from d1Schema() of v2.1+). */
  meta?: 'basic' | 'extended';
}

/** DDL for the events table. Apply once as a migration. */
export function d1Schema(table = 'sh_events'): string {
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  experiment TEXT,
  variant TEXT,
  goal TEXT,
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  url TEXT,
  props TEXT,
  received_at INTEGER NOT NULL,
  host TEXT,
  country TEXT,
  device TEXT,
  browser TEXT,
  os TEXT,
  language TEXT,
  city TEXT,
  region TEXT,
  referrer TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  platform TEXT,
  app_version TEXT,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS ${table}_exp ON ${table} (project_id, type, experiment, visitor_id, ts);
CREATE INDEX IF NOT EXISTS ${table}_goal ON ${table} (project_id, type, goal, visitor_id, ts);
`.trim();
}

/** ALTER statements that bring a table made by an older d1Schema() up to date (the app columns). */
export function d1Migrations(table = 'sh_events'): string[] {
  return APP_COLUMNS.map((c) => `ALTER TABLE ${table} ADD COLUMN ${c} TEXT`);
}

const APP_COLUMNS = ['platform', 'app_version'] as const;

// Per database binding and table: whether the app columns exist. Only a yes is kept, so a table
// created after the first insert (or a failed check) is looked at again on the next batch.
const appColumnsReady = new WeakMap<D1Like, Set<string>>();

/** Adds platform / app_version to an existing table once; false when the table cannot take them (the insert then leaves them out). */
async function ensureAppColumns(db: D1Like, table: string): Promise<boolean> {
  if (appColumnsReady.get(db)?.has(table)) return true;
  const columns = async (): Promise<Set<string>> => new Set((await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map((c) => c.name));
  try {
    let have = await columns();
    if (have.size === 0) return false;
    for (const c of APP_COLUMNS) {
      if (have.has(c)) continue;
      // Two isolates may race on the same ALTER; the re-read below settles it.
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${c} TEXT`).run().catch(() => undefined);
    }
    have = await columns();
    if (!APP_COLUMNS.every((c) => have.has(c))) return false;
  } catch {
    return false;
  }
  const set = appColumnsReady.get(db) ?? new Set<string>();
  set.add(table);
  appColumnsReady.set(db, set);
  return true;
}

/**
 * Store on Cloudflare D1. One table for all projects, partitioned by project_id.
 *
 * ```ts
 * const store = d1Store(env.DB, { project: projectId });
 * ```
 */
export function d1Store(db: D1Like, options: D1StoreOptions): Store {
  const table = options.table ?? 'sh_events';
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error('[splithub] invalid table name');
  const project = options.project;

  const extended = options.meta === 'extended';
  const extraCols = extended ? ', os, language, city, region, referrer, utm_source, utm_medium, utm_campaign, utm_term, utm_content' : '';
  const extraMarks = extended ? ', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?' : '';
  const insertSql = (app: boolean): string => `INSERT OR IGNORE INTO ${table} (project_id, id, type, experiment, variant, goal, visitor_id, session_id, ts, url, props, received_at, host, country, device, browser${extraCols}${app ? ', platform, app_version' : ''})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${extraMarks}${app ? ', ?, ?' : ''})`;

  // The shared attribution rule from @splithub/node (first exposure, skew, daily goal cap).
  const attribution = variantCountsSql({ dialect: 'sqlite', table, projectColumn: 'project_id' });

  const prop = propertyCountsSql({ dialect: 'sqlite', table, projectColumn: 'project_id' });

  const summarySql = `
    SELECT experiment, COUNT(*) AS exposures, COUNT(DISTINCT visitor_id) AS visitors,
           MIN(ts) AS firstExposureAt, MAX(ts) AS lastExposureAt
    FROM ${table}
    WHERE project_id = ? AND type = 'exposure'
    GROUP BY experiment`;

  return {
    async insertEvents(events: StoredEvent[]) {
      if (events.length === 0) return 0;
      const app = await ensureAppColumns(db, table);
      const sql = insertSql(app);
      const statements = events.map((e) =>
        db.prepare(sql).bind(
          project, e.id, e.type, e.experiment, e.variant, e.goal, e.visitorId, e.sessionId, e.ts, e.url, e.props ? JSON.stringify(e.props) : null, e.receivedAt, e.host ?? null, e.country ?? null, e.device ?? null, e.browser ?? null,
          ...(extended ? [e.os ?? null, e.language ?? null, e.city ?? null, e.region ?? null, e.referrer ?? null, e.utm_source ?? null, e.utm_medium ?? null, e.utm_campaign ?? null, e.utm_term ?? null, e.utm_content ?? null] : []),
          ...(app ? [e.platform ?? null, e.app_version ?? null] : [])
        )
      );
      const results = await db.batch(statements);
      return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
    },
    async variantCounts(experiment, goal) {
      const { results } = await db.prepare(attribution.sql).bind(...attribution.bind({ experiment, goal, project })).all<Record<string, unknown>>();
      return results.map(countsFromRow);
    },
    async propertyCounts(property, since, until) {
      const [totals, events] = await Promise.all([
        db.prepare(prop.totals.sql).bind(...prop.totals.bind({ project, property, since, until })).all<Record<string, unknown>>(),
        db.prepare(prop.events.sql).bind(...prop.events.bind({ project, property, since, until })).all<Record<string, unknown>>(),
      ]);
      return propertyCountsFromRows(totals.results[0], events.results);
    },
    async propertyEvents(property, { before, limit }) {
      const { results } = await db.prepare(prop.rows.sql).bind(...prop.rows.bind({ project, property, before, limit })).all<Record<string, unknown>>();
      return results.map(storedEventFromRow);
    },
    async summaries() {
      const { results } = await db.prepare(summarySql).bind(project).all<Record<string, unknown>>();
      return results.map(
        (r): ExperimentSummary => ({
          experiment: String(r.experiment),
          exposures: Number(r.exposures),
          visitors: Number(r.visitors),
          firstExposureAt: r.firstExposureAt == null ? null : Number(r.firstExposureAt),
          lastExposureAt: r.lastExposureAt == null ? null : Number(r.lastExposureAt),
        })
      );
    },
  };
}
