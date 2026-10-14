import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { D1Like, D1StatementLike } from './index';

/**
 * Minimal D1Database shim over Node's built-in SQLite (Node 22.13+), for unit
 * tests of code that targets Cloudflare D1. Supports prepare/bind/all/first/run,
 * batch and exec. Not for production.
 */
export function sqliteD1(file = ':memory:'): D1Like & { exec(sql: string): Promise<void>; raw: DatabaseSyncType } {
  const get = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const mod = get ? (get('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType } | undefined) : undefined;
  if (!mod) throw new Error('sqliteD1 needs Node.js 22.13+ (node:sqlite)');
  const db = new mod.DatabaseSync(file);

  const statement = (sql: string, params: unknown[] = []): D1StatementLike & { first<T>(): Promise<T | null> } => ({
    bind(...values: unknown[]) {
      return statement(sql, values);
    },
    async all<T>() {
      const rows = db.prepare(sql).all(...(params as never[])) as T[];
      return { results: rows };
    },
    async first<T>() {
      const row = db.prepare(sql).get(...(params as never[])) as T | undefined;
      return row ?? null;
    },
    async run() {
      const r = db.prepare(sql).run(...(params as never[]));
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });

  return {
    raw: db,
    prepare: (sql: string) => statement(sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
    },
  };
}
