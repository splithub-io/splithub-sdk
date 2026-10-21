// Store templates for self-hosted mode: `splithub init --mode self --db postgres|mysql|custom`
// writes splithub/store.ts from one of these. Each implements the Store interface
// from @splithub/node (insertEvents, variantCounts, summaries, and the raw analytics
// reads propertyCounts / propertyEvents) with the same
// attribution rule as the cloud, through variantCountsSql from @splithub/node.

export type DbKind = 'sqlite' | 'postgres' | 'mysql' | 'custom';
export const DB_KINDS: DbKind[] = ['sqlite', 'postgres', 'mysql', 'custom'];

export const PG_STORE = `import { countsFromRow, propertyCountsFromRows, propertyCountsSql, storedEventFromRow, variantCountsSql, type ExperimentSummary, type PropertyCounts, type Store, type StoredEvent, type StoreVariantCounts } from '@splithub/node';
import { Pool } from 'pg';

// SplitHub events in your Postgres. Run once (or add to your migrations):
export const SCHEMA_SQL = \`
CREATE TABLE IF NOT EXISTS splithub_events (
  id          text PRIMARY KEY,
  type        text NOT NULL,            -- exposure | goal | page | event | engage | identify (analytics rows: experiment = property, goal = event name)
  experiment  text,
  variant     text,
  goal        text,
  visitor_id  text NOT NULL,
  session_id  text NOT NULL,
  ts          bigint NOT NULL,          -- client clock, unix ms
  url         text,
  props       jsonb,
  received_at bigint NOT NULL,          -- server clock, unix ms
  host        text,
  country     text,
  device      text,
  browser     text,
  platform    text,                     -- web | ios | android | macos | windows | linux
  app_version text                      -- the app's version; null on websites
);
CREATE INDEX IF NOT EXISTS splithub_events_exp  ON splithub_events (type, experiment, visitor_id, ts);
CREATE INDEX IF NOT EXISTS splithub_events_goal ON splithub_events (type, goal, visitor_id, ts);
-- Tables from before the app columns (the store also adds them on its first insert):
ALTER TABLE splithub_events ADD COLUMN IF NOT EXISTS platform text, ADD COLUMN IF NOT EXISTS app_version text;
\`;

// The attribution rule shared by every SplitHub store (first exposure, 60 s clock skew, 50 goals per visitor and day).
const counts = variantCountsSql({ dialect: 'postgres', table: 'splithub_events' });
// Analytics properties: pageviews, events, engagement and identify rows share the table; raw counts
// only (users = distinct ids sent with identify).
const prop = propertyCountsSql({ dialect: 'postgres', table: 'splithub_events' });

export function pgStore(pool: Pool = new Pool({ connectionString: process.env.DATABASE_URL })): Store {
  // A table made before the app columns gets them on the first insert. Without ALTER rights they are left out.
  let appColumns: Promise<boolean> | null = null;
  const ensureAppColumns = (): Promise<boolean> =>
    (appColumns ??= (async () => {
      const have = async () =>
        (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'splithub_events' AND column_name IN ('platform', 'app_version')")).rows.length === 2;
      if (await have()) return true;
      await pool.query('ALTER TABLE splithub_events ADD COLUMN IF NOT EXISTS platform text, ADD COLUMN IF NOT EXISTS app_version text').catch(() => undefined);
      return have();
    })().catch(() => false));
  return {
    async insertEvents(events: StoredEvent[]) {
      if (events.length === 0) return 0;
      const app = await ensureAppColumns();
      const cols = app ? 17 : 15;
      const values: unknown[] = [];
      const rows = events.map((e, i) => {
        values.push(e.id, e.type, e.experiment, e.variant, e.goal, e.visitorId, e.sessionId, e.ts, e.url, e.props ? JSON.stringify(e.props) : null, e.receivedAt, e.host ?? null, e.country ?? null, e.device ?? null, e.browser ?? null);
        if (app) values.push(e.platform ?? null, e.app_version ?? null);
        return '(' + Array.from({ length: cols }, (_, j) => '$' + (i * cols + j + 1)).join(', ') + ')';
      });
      const r = await pool.query(
        'INSERT INTO splithub_events (id, type, experiment, variant, goal, visitor_id, session_id, ts, url, props, received_at, host, country, device, browser' + (app ? ', platform, app_version' : '') + ') VALUES ' + rows.join(', ') + ' ON CONFLICT (id) DO NOTHING',
        values
      );
      return r.rowCount ?? 0;
    },
    async variantCounts(experiment: string, goal: string): Promise<StoreVariantCounts[]> {
      const r = await pool.query(counts.sql, counts.bind({ experiment, goal }));
      return r.rows.map(countsFromRow);
    },
    async summaries(): Promise<ExperimentSummary[]> {
      const r = await pool.query(
        \`SELECT experiment, COUNT(*)::int AS exposures, COUNT(DISTINCT visitor_id)::int AS visitors, MIN(ts)::bigint AS first_ts, MAX(ts)::bigint AS last_ts
         FROM splithub_events WHERE type = 'exposure' GROUP BY experiment\`
      );
      return r.rows.map((x) => ({ experiment: String(x.experiment), exposures: Number(x.exposures), visitors: Number(x.visitors), firstExposureAt: x.first_ts == null ? null : Number(x.first_ts), lastExposureAt: x.last_ts == null ? null : Number(x.last_ts) }));
    },
    async propertyCounts(property: string, since: number, until?: number): Promise<PropertyCounts> {
      const [totals, events] = await Promise.all([pool.query(prop.totals.sql, prop.totals.bind({ property, since, until })), pool.query(prop.events.sql, prop.events.bind({ property, since, until }))]);
      return propertyCountsFromRows(totals.rows[0], events.rows);
    },
    async propertyEvents(property: string, { before, limit }: { before: number; limit: number }): Promise<StoredEvent[]> {
      const r = await pool.query(prop.rows.sql, prop.rows.bind({ property, before, limit }));
      return r.rows.map(storedEventFromRow);
    },
    close: () => pool.end(),
  };
}
`;

export const MYSQL_STORE = `import { countsFromRow, propertyCountsFromRows, propertyCountsSql, storedEventFromRow, variantCountsSql, type ExperimentSummary, type PropertyCounts, type Store, type StoredEvent, type StoreVariantCounts } from '@splithub/node';
import mysql, { type Pool } from 'mysql2/promise';

// SplitHub events in your MySQL / MariaDB / PlanetScale. Run once (or add to your migrations):
export const SCHEMA_SQL = \`
CREATE TABLE IF NOT EXISTS splithub_events (
  id          VARCHAR(64) PRIMARY KEY,
  type        VARCHAR(16) NOT NULL,     -- exposure | goal | page | event | engage | identify
  experiment  VARCHAR(64) NULL,
  variant     VARCHAR(64) NULL,
  goal        VARCHAR(64) NULL,
  visitor_id  VARCHAR(64) NOT NULL,
  session_id  VARCHAR(64) NOT NULL,
  ts          BIGINT NOT NULL,
  url         VARCHAR(512) NULL,
  props       JSON NULL,
  received_at BIGINT NOT NULL,
  host        VARCHAR(255) NULL,
  country     VARCHAR(8) NULL,
  device      VARCHAR(16) NULL,
  browser     VARCHAR(32) NULL,
  platform    VARCHAR(16) NULL,         -- web | ios | android | macos | windows | linux
  app_version VARCHAR(32) NULL,         -- the app's version; null on websites
  INDEX splithub_events_exp (type, experiment, visitor_id, ts),
  INDEX splithub_events_goal (type, goal, visitor_id, ts)
);
\`;

// The attribution rule shared by every SplitHub store (first exposure, 60 s clock skew, 50 goals per visitor and day).
const counts = variantCountsSql({ dialect: 'mysql', table: 'splithub_events' });
// Analytics properties: pageviews, events, engagement and identify rows share the table; raw counts
// only (users = distinct ids sent with identify).
const prop = propertyCountsSql({ dialect: 'mysql', table: 'splithub_events' });

export function mysqlStore(pool: Pool = mysql.createPool(process.env.DATABASE_URL ?? '')): Store {
  // A table made before the app columns gets them on the first insert. Without ALTER rights they are left out.
  let appColumns: Promise<boolean> | null = null;
  const ensureAppColumns = (): Promise<boolean> =>
    (appColumns ??= (async () => {
      const have = async () => {
        const [rows] = await pool.query("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'splithub_events' AND COLUMN_NAME IN ('platform', 'app_version')");
        return new Set((rows as Array<{ name: string }>).map((r) => r.name));
      };
      const found = await have();
      if (!found.has('platform')) await pool.query('ALTER TABLE splithub_events ADD COLUMN platform VARCHAR(16) NULL').catch(() => undefined);
      if (!found.has('app_version')) await pool.query('ALTER TABLE splithub_events ADD COLUMN app_version VARCHAR(32) NULL').catch(() => undefined);
      return (await have()).size === 2;
    })().catch(() => false));
  return {
    async insertEvents(events: StoredEvent[]) {
      if (events.length === 0) return 0;
      const app = await ensureAppColumns();
      const values = events.map((e) => [e.id, e.type, e.experiment, e.variant, e.goal, e.visitorId, e.sessionId, e.ts, e.url, e.props ? JSON.stringify(e.props) : null, e.receivedAt, e.host ?? null, e.country ?? null, e.device ?? null, e.browser ?? null, ...(app ? [e.platform ?? null, e.app_version ?? null] : [])]);
      const [r] = await pool.query(
        'INSERT IGNORE INTO splithub_events (id, type, experiment, variant, goal, visitor_id, session_id, ts, url, props, received_at, host, country, device, browser' + (app ? ', platform, app_version' : '') + ') VALUES ?',
        [values]
      );
      return (r as { affectedRows: number }).affectedRows;
    },
    async variantCounts(experiment: string, goal: string): Promise<StoreVariantCounts[]> {
      const [rows] = await pool.query(counts.sql, counts.bind({ experiment, goal }));
      return (rows as Array<Record<string, unknown>>).map(countsFromRow);
    },
    async summaries(): Promise<ExperimentSummary[]> {
      const [rows] = await pool.query(
        \`SELECT experiment, COUNT(*) AS exposures, COUNT(DISTINCT visitor_id) AS visitors, MIN(ts) AS first_ts, MAX(ts) AS last_ts
         FROM splithub_events WHERE type = 'exposure' GROUP BY experiment\`
      );
      return (rows as Array<Record<string, unknown>>).map((x) => ({ experiment: String(x.experiment), exposures: Number(x.exposures), visitors: Number(x.visitors), firstExposureAt: x.first_ts == null ? null : Number(x.first_ts), lastExposureAt: x.last_ts == null ? null : Number(x.last_ts) }));
    },
    async propertyCounts(property: string, since: number, until?: number): Promise<PropertyCounts> {
      const [[totals], [events]] = await Promise.all([pool.query(prop.totals.sql, prop.totals.bind({ property, since, until })), pool.query(prop.events.sql, prop.events.bind({ property, since, until }))]);
      return propertyCountsFromRows((totals as Array<Record<string, unknown>>)[0], events as Array<Record<string, unknown>>);
    },
    async propertyEvents(property: string, { before, limit }: { before: number; limit: number }): Promise<StoredEvent[]> {
      const [rows] = await pool.query(prop.rows.sql, prop.rows.bind({ property, before, limit }));
      return (rows as Array<Record<string, unknown>>).map(storedEventFromRow);
    },
    close: () => pool.end(),
  };
}
`;

export const CUSTOM_STORE = `import { attributeVariants, type ExperimentSummary, type Store, type StoredEvent, type StoreVariantCounts } from '@splithub/node';

/**
 * Your own store (Prisma, Drizzle, Supabase, Mongo, anything). Three methods.
 * Attribution rule (keep it, so results match the dashboard):
 *   a visitor counts once per experiment, in the variant of their earliest
 *   exposure (same ts: smallest variant key), and converts when they sent the
 *   goal at or after that exposure (60 s of clock skew allowed); only the first
 *   50 events of one goal per visitor and UTC day count; count unique visitors.
 *   SQL database: run variantCountsSql({ dialect }) from @splithub/node.
 *   Anything else: load the experiment's exposures and the goal's events and
 *   return attributeVariants(events, experiment, goal).
 * Columns worth keeping: id (unique, dedupe on it), type, experiment, variant,
 * goal, visitor_id, session_id, ts, url, props (json), received_at, host,
 * country, device, browser, platform (web | ios | android | macos | windows | linux)
 * and app_version (apps only).
 * Analytics (optional): \`page\`, \`event\`, \`engage\` and \`identify\` rows carry the
 * property key in \`experiment\` (and the event name in \`goal\`); engage props are
 * { ms, scroll }, identify props { uid, traits }. Store them like the others and add
 * propertyCounts(property, since, until?) (or run propertyCountsSql, which also counts users)
 * to read them with \`splithub analytics\`.
 */
export function customStore(): Store {
  return {
    async insertEvents(events: StoredEvent[]): Promise<number> {
      // Insert, skipping ids that already exist. Return how many were inserted.
      throw new Error('implement insertEvents ' + events.length);
    },
    async variantCounts(experiment: string, goal: string): Promise<StoreVariantCounts[]> {
      // Per variant: exposures, conversions, revenueSum and revenueSumSq (per-visitor revenue).
      // Load the exposures of this experiment and the events of this goal, then apply the shared rule.
      const events: StoredEvent[] = [];
      if (events.length === 0) throw new Error('implement variantCounts ' + experiment + ' ' + goal);
      return attributeVariants(events, experiment, goal);
    },
    async summaries(): Promise<ExperimentSummary[]> {
      // Per experiment: exposures, unique visitors, first and last exposure ts (unix ms).
      throw new Error('implement summaries');
    },
  };
}
`;

export function storeTemplate(db: DbKind): string | null {
  return db === 'postgres' ? PG_STORE : db === 'mysql' ? MYSQL_STORE : db === 'custom' ? CUSTOM_STORE : null;
}

/** Import line + factory call used by the route template. */
export function storeUsage(db: DbKind, storeImport: string): { imports: string; factory: string } {
  switch (db) {
    case 'postgres':
      return { imports: `import { pgStore } from '${storeImport}';`, factory: 'pgStore()' };
    case 'mysql':
      return { imports: `import { mysqlStore } from '${storeImport}';`, factory: 'mysqlStore()' };
    case 'custom':
      return { imports: `import { customStore } from '${storeImport}';`, factory: 'customStore()' };
    default:
      return { imports: `import { sqliteStore } from '@splithub/adapter-sqlite';`, factory: `sqliteStore({ file: process.env.SPLITHUB_DB ?? './splithub.db' })` };
  }
}

export function runtimePackages(db: DbKind): string[] {
  return db === 'postgres' ? ['pg'] : db === 'mysql' ? ['mysql2'] : db === 'sqlite' ? ['@splithub/adapter-sqlite'] : [];
}
