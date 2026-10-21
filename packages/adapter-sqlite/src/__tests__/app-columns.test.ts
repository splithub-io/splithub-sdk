import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StoredEvent } from '@splithub/node';
import { afterAll, describe, expect, it } from 'vitest';
import { sqliteStore } from '../index';

const dir = mkdtempSync(join(tmpdir(), 'sh-sqlite-app-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const page = (id: string, over: Partial<StoredEvent> = {}): StoredEvent => ({
  id, type: 'page', experiment: 'app', variant: null, goal: null, visitorId: 'v1', sessionId: 's1', ts: Number(id.replace(/\D/g, '')), url: '/home', props: null, receivedAt: 1, ...over,
});

describe('sqliteStore app columns', () => {
  it('stores platform and app_version', async () => {
    const store = sqliteStore({ file: ':memory:' });
    await store.insertEvents([page('p1', { platform: 'ios', app_version: '2.4.1' }), page('p2', { platform: 'web', app_version: null })]);
    const rows = await store.propertyEvents!('app', { before: 100, limit: 10 });
    expect(rows.map((r) => [r.id, r.platform, r.app_version])).toEqual([['p2', 'web', null], ['p1', 'ios', '2.4.1']]);
    store.close?.();
  });

  it('adds the columns to a database made before them and keeps its rows', async () => {
    const file = join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE splithub_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, experiment TEXT, variant TEXT, goal TEXT, visitor_id TEXT NOT NULL, session_id TEXT NOT NULL, ts INTEGER NOT NULL, url TEXT, props TEXT, received_at INTEGER NOT NULL, host TEXT, country TEXT, device TEXT, browser TEXT)`);
    old.prepare(`INSERT INTO splithub_events (id, type, experiment, visitor_id, session_id, ts, url, received_at) VALUES ('p1', 'page', 'app', 'v1', 's1', 1, '/', 1)`).run();
    old.close();

    const store = sqliteStore({ file });
    await store.insertEvents([page('p2', { platform: 'android', app_version: '3.0' })]);
    const rows = await store.propertyEvents!('app', { before: 100, limit: 10 });
    expect(rows.map((r) => [r.id, r.platform, r.app_version])).toEqual([['p2', 'android', '3.0'], ['p1', null, null]]);
    expect((await store.propertyCounts!('app', 0)).pageviews).toBe(2);
    store.close?.();
    // Opening it again is a no-op.
    sqliteStore({ file }).close?.();
  });
});
