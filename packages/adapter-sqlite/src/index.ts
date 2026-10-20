import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// Loaded via getBuiltinModule so bundlers never rewrite the specifier
// (esbuild turns `node:sqlite` into a bare `sqlite` package for older targets).
type SqliteModule = { DatabaseSync: typeof DatabaseSyncType };
function loadSqlite(): SqliteModule {
  const get = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const mod = get ? (get('node:sqlite') as SqliteModule | undefined) : undefined;
  if (!mod) throw new Error('[splithub] @splithub/adapter-sqlite needs Node.js 22.13 or newer (built-in node:sqlite).');
  return mod;
}
import { countsFromRow, propertyCountsFromRows, propertyCountsSql, storedEventFromRow, variantCountsSql, type Store } from '@splithub/node';

export interface SqliteStoreOptions {
  /** File path, or ":memory:". Defaults to "./splithub.db". */
  file?: string;
  /** Table name. Defaults to "splithub_events". */
  table?: string;
}

/**
 * Persistent store backed by Node's built-in SQLite (Node 22.13+). Nothing to
 * compile, nothing to configure:
 *
 * ```ts
 * import { sqliteStore } from '@splithub/adapter-sqlite';
 * const store = sqliteStore({ file: './splithub.db' });
 * ```
 */
export function sqliteStore(options: SqliteStoreOptions = {}): Store {
  const table = options.table ?? 'splithub_events';
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error('[splithub] invalid table name');
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(options.file ?? './splithub.db');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
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
      browser TEXT
    );
    CREATE INDEX IF NOT EXISTS ${table}_exp ON ${table} (type, experiment, visitor_id, ts);
    CREATE INDEX IF NOT EXISTS ${table}_goal ON ${table} (type, goal, visitor_id, ts);
  `);

  // Older self-hosted databases predate the metadata columns.
  const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  for (const col of ['host', 'country', 'device', 'browser']) {
    if (!existing.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO ${table} (id, type, experiment, variant, goal, visitor_id, session_id, ts, url, props, received_at, host, country, device, browser)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // The shared attribution rule from @splithub/node (first exposure, skew, daily goal cap).
  const attribution = variantCountsSql({ dialect: 'sqlite', table });
  const counts = db.prepare(attribution.sql);

  const summary = db.prepare(`
    SELECT experiment, COUNT(*) AS exposures, COUNT(DISTINCT visitor_id) AS visitors,
           MIN(ts) AS firstExposureAt, MAX(ts) AS lastExposureAt
    FROM ${table}
    WHERE type = 'exposure'
    GROUP BY experiment
  `);

  // Analytics properties: raw counts and rows (pageviews and events share the table).
  const prop = propertyCountsSql({ dialect: 'sqlite', table });
  const propTotals = db.prepare(prop.totals.sql);
  const propEvents = db.prepare(prop.events.sql);
  const propRows = db.prepare(prop.rows.sql);

  return {
    async insertEvents(events) {
      let n = 0;
      db.exec('BEGIN');
      try {
        for (const e of events) {
          const r = insert.run(e.id, e.type, e.experiment, e.variant, e.goal, e.visitorId, e.sessionId, e.ts, e.url, e.props ? JSON.stringify(e.props) : null, e.receivedAt, e.host ?? null, e.country ?? null, e.device ?? null, e.browser ?? null);
          n += Number(r.changes);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return n;
    },
    async variantCounts(experiment, goal) {
      return (counts.all(...(attribution.bind({ experiment, goal }) as string[])) as Array<Record<string, unknown>>).map(countsFromRow);
    },
    async propertyCounts(property, since, until) {
      const totals = propTotals.all(...(prop.totals.bind({ property, since, until }) as Array<string | number>))[0] as Record<string, unknown> | undefined;
      const events = propEvents.all(...(prop.events.bind({ property, since, until }) as Array<string | number>)) as Array<Record<string, unknown>>;
      return propertyCountsFromRows(totals, events);
    },
    async propertyEvents(property, { before, limit }) {
      return (propRows.all(...(prop.rows.bind({ property, before, limit }) as Array<string | number>)) as Array<Record<string, unknown>>).map(storedEventFromRow);
    },
    async summaries() {
      return (summary.all() as unknown[]).map((row) => {
        const r = row as Record<string, unknown>;
        return {
          experiment: String(r.experiment),
          exposures: Number(r.exposures),
          visitors: Number(r.visitors),
          firstExposureAt: r.firstExposureAt == null ? null : Number(r.firstExposureAt),
          lastExposureAt: r.lastExposureAt == null ? null : Number(r.lastExposureAt),
        };
      });
    },
    close() {
      db.close();
    },
  };
}
