// The generated Postgres / MySQL stores, run against fake pools: they write platform and
// app_version, add the columns to a table made before them, and leave them out without ALTER rights.
import { transformSync } from 'esbuild';
import * as node from '@splithub/node';
import type { Store, StoredEvent } from '@splithub/node';
import { describe, expect, it } from 'vitest';
import { MYSQL_STORE, PG_STORE } from '../templates-store';

type Query = { sql: string; values?: unknown };

function load(source: string, modules: Record<string, unknown>): Record<string, unknown> {
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
  const module = { exports: {} as Record<string, unknown> };
  const req = (id: string): unknown => {
    if (id in modules) return modules[id];
    throw new Error(`unexpected import ${id}`);
  };
  new Function('module', 'exports', 'require', code)(module, module.exports, req);
  return module.exports;
}

const event = (over: Partial<StoredEvent> = {}): StoredEvent => ({
  id: 'e1',
  type: 'exposure',
  experiment: 'hero',
  variant: 'control',
  goal: null,
  visitorId: 'v1',
  sessionId: 's1',
  ts: 1,
  url: null,
  props: null,
  receivedAt: 1,
  platform: 'ios',
  app_version: '2.4.1',
  ...over,
});

/** A pool over one table whose columns start as `columns`; ALTER succeeds unless `canAlter` is false. */
function fakePool(kind: 'pg' | 'mysql', columns: string[], canAlter = true) {
  const have = new Set(columns);
  const queries: Query[] = [];
  const query = async (sql: string, values?: unknown) => {
    queries.push({ sql, values });
    let rows: unknown[] = [];
    if (/information_schema/i.test(sql)) rows = ['platform', 'app_version'].filter((c) => have.has(c)).map((c) => (kind === 'pg' ? { column_name: c } : { name: c }));
    else if (/^ALTER/i.test(sql)) {
      if (!canAlter) throw new Error('permission denied');
      for (const c of ['platform', 'app_version']) if (sql.includes(c)) have.add(c);
    } else if (/^INSERT/i.test(sql)) {
      const n = kind === 'pg' ? (sql.match(/\(\$/g) ?? []).length : (values as unknown[][])[0]!.length;
      return kind === 'pg' ? { rows: [], rowCount: n } : [{ affectedRows: n }];
    }
    return kind === 'pg' ? { rows, rowCount: rows.length } : [rows];
  };
  return { pool: { query, end: async () => undefined }, queries, have };
}

const pgStore = (pool: unknown): Store => (load(PG_STORE, { '@splithub/node': node, pg: { Pool: class {} } }).pgStore as (p: unknown) => Store)(pool);
const mysqlStore = (pool: unknown): Store =>
  (load(MYSQL_STORE, { '@splithub/node': node, 'mysql2/promise': { default: { createPool: () => ({}) } } }).mysqlStore as (p: unknown) => Store)(pool);

describe('Postgres store template', () => {
  it('declares the app columns and migrates older tables in SCHEMA_SQL', () => {
    expect(PG_STORE).toMatch(/platform\s+text/);
    expect(PG_STORE).toContain('ADD COLUMN IF NOT EXISTS platform text, ADD COLUMN IF NOT EXISTS app_version text');
  });

  it('adds the columns once to an older table, then writes them', async () => {
    const f = fakePool('pg', []);
    const store = pgStore(f.pool);
    expect(await store.insertEvents([event(), event({ id: 'e2', platform: 'web', app_version: null })])).toBe(2);
    await store.insertEvents([event({ id: 'e3' })]);
    expect(f.queries.filter((q) => /^ALTER/.test(q.sql))).toHaveLength(1);
    const insert = f.queries.find((q) => /^INSERT/.test(q.sql))!;
    expect(insert.sql).toContain('browser, platform, app_version)');
    expect((insert.values as unknown[]).slice(15, 17)).toEqual(['ios', '2.4.1']);
    expect((insert.values as unknown[]).slice(32, 34)).toEqual(['web', null]);
  });

  it('leaves the columns out when the table lacks them and ALTER is refused', async () => {
    const f = fakePool('pg', [], false);
    expect(await pgStore(f.pool).insertEvents([event()])).toBe(1);
    const insert = f.queries.find((q) => /^INSERT/.test(q.sql))!;
    expect(insert.sql).not.toContain('platform');
    expect(insert.values as unknown[]).toHaveLength(15);
  });
});

describe('MySQL store template', () => {
  it('declares the app columns', () => {
    expect(MYSQL_STORE).toMatch(/platform\s+VARCHAR\(16\) NULL/);
    expect(MYSQL_STORE).toMatch(/app_version VARCHAR\(32\) NULL/);
  });

  it('adds only the missing column, then writes both', async () => {
    const f = fakePool('mysql', ['platform']);
    expect(await mysqlStore(f.pool).insertEvents([event()])).toBe(1);
    const alters = f.queries.filter((q) => /^ALTER/.test(q.sql)).map((q) => q.sql);
    expect(alters).toEqual(['ALTER TABLE splithub_events ADD COLUMN app_version VARCHAR(32) NULL']);
    const insert = f.queries.find((q) => /^INSERT/.test(q.sql))!;
    expect(insert.sql).toContain('platform, app_version)');
    expect((insert.values as unknown[][][])[0]![0]!.slice(15)).toEqual(['ios', '2.4.1']);
  });

  it('skips the ALTER when the columns exist, and leaves them out when ALTER is refused', async () => {
    const ready = fakePool('mysql', ['platform', 'app_version']);
    await mysqlStore(ready.pool).insertEvents([event()]);
    expect(ready.queries.some((q) => /^ALTER/.test(q.sql))).toBe(false);

    const locked = fakePool('mysql', [], false);
    await mysqlStore(locked.pool).insertEvents([event()]);
    const insert = locked.queries.find((q) => /^INSERT/.test(q.sql))!;
    expect(insert.sql).not.toContain('platform');
    expect((insert.values as unknown[][][])[0]![0]).toHaveLength(15);
  });
});
