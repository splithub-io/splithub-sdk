import type { StoredEvent } from '@splithub/node';
import { describe, expect, it } from 'vitest';
import { d1Schema, d1Store } from '../index';
import { sqliteD1 } from '../testing';

const row = (id: string, type: StoredEvent['type'], visitorId: string, props: Record<string, unknown> | null, ts = 1000): StoredEvent => ({
  id, type, experiment: 'site', variant: null, goal: null, visitorId, sessionId: `s_${visitorId}`, ts, url: '/', props, receivedAt: ts,
});

describe('d1Store analytics', () => {
  it('keeps engage and identify rows per project and counts users', async () => {
    const db = sqliteD1();
    await db.exec(d1Schema());
    const store = d1Store(db, { project: 'a' });
    const other = d1Store(db, { project: 'b' });
    await store.insertEvents([row('p1', 'page', 'v1', null), row('n1', 'engage', 'v1', { ms: 1200, scroll: 80 }), row('i1', 'identify', 'v1', { uid: 'u_1' }), row('i2', 'identify', 'v2', { uid: 'u_2' })]);
    await other.insertEvents([row('i9', 'identify', 'v9', { uid: 'u_9' })]);
    expect(await store.propertyCounts!('site', 0)).toMatchObject({ pageviews: 1, visitors: 1, users: 2 });
    expect(await store.propertyCounts!('site', 0, 1)).toMatchObject({ pageviews: 0, visitors: 0, users: 0 });
    expect(await other.propertyCounts!('site', 0)).toMatchObject({ pageviews: 0, visitors: 0, users: 1 });
    expect((await store.propertyEvents!('site', { before: 2000, limit: 10 })).map((r) => r.type).sort()).toEqual(['engage', 'identify', 'identify', 'page']);
  });
});
