import type { StoredEvent } from '@splithub/node';
import { describe, expect, it } from 'vitest';
import { d1Migrations, d1Schema, d1Store } from '../index';
import { sqliteD1 } from '../testing';

const page = (id: string, over: Partial<StoredEvent> = {}): StoredEvent => ({
  id, type: 'page', experiment: 'app', variant: null, goal: null, visitorId: 'v1', sessionId: 's1', ts: Number(id.replace(/\D/g, '')), url: '/home', props: null, receivedAt: 1, ...over,
});

/** The schema before the app columns. */
const oldSchema = (table = 'sh_events') => d1Schema(table).replace(/\s*platform TEXT,\s*app_version TEXT,/, '');

describe('d1Store app columns', () => {
  it('stores platform and app_version, basic and extended', async () => {
    const db = sqliteD1();
    await db.exec(d1Schema());
    for (const meta of ['basic', 'extended'] as const) {
      const store = d1Store(db, { project: meta, meta });
      await store.insertEvents([page('p1', { platform: 'ios', app_version: '2.4.1', os: 'iOS' }), page('p2', { platform: 'web' })]);
      const rows = await store.propertyEvents!('app', { before: 100, limit: 10 });
      expect(rows.map((r) => [r.id, r.platform, r.app_version])).toEqual([['p2', 'web', null], ['p1', 'ios', '2.4.1']]);
    }
  });

  it('adds the columns to a table made by an older d1Schema() on the first insert', async () => {
    const db = sqliteD1();
    await db.exec(oldSchema());
    db.raw.prepare(`INSERT INTO sh_events (project_id, id, type, experiment, visitor_id, session_id, ts, url, received_at) VALUES ('p', 'p1', 'page', 'app', 'v1', 's1', 1, '/', 1)`).run();
    const store = d1Store(db, { project: 'p' });
    await store.insertEvents([page('p2', { platform: 'android', app_version: '3.0' })]);
    await store.insertEvents([page('p3', { platform: 'android', app_version: '3.1' })]);
    const rows = await store.propertyEvents!('app', { before: 100, limit: 10 });
    expect(rows.map((r) => [r.id, r.platform, r.app_version])).toEqual([['p3', 'android', '3.1'], ['p2', 'android', '3.0'], ['p1', null, null]]);
    expect((await store.propertyCounts!('app', 0)).pageviews).toBe(3);
  });

  it('d1Migrations brings an old table up to date by hand', async () => {
    const db = sqliteD1();
    await db.exec(oldSchema('ev'));
    for (const sql of d1Migrations('ev')) await db.exec(sql);
    const cols = (db.raw.prepare('PRAGMA table_info(ev)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['platform', 'app_version']));
  });

  it('still inserts when the columns cannot be added', async () => {
    const db = sqliteD1();
    await db.exec(oldSchema());
    // A binding that refuses ALTER (read-only migration rights): the insert leaves the app columns out.
    const locked = { ...db, prepare: (sql: string) => (/^ALTER/.test(sql) ? { ...db.prepare(sql), run: async () => { throw new Error('not authorized'); } } : db.prepare(sql)) };
    const store = d1Store(locked, { project: 'p' });
    expect(await store.insertEvents([page('p1', { platform: 'ios' })])).toBe(1);
    const rows = await store.propertyEvents!('app', { before: 100, limit: 10 });
    expect(rows[0]).not.toHaveProperty('platform');
  });
});
