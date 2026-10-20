import type { StoredEvent } from '@splithub/node';
import { describe, expect, it } from 'vitest';
import { sqliteStore } from '../index';

const row = (id: string, type: StoredEvent['type'], visitorId: string, props: Record<string, unknown> | null, ts = 1000): StoredEvent => ({
  id, type, experiment: 'site', variant: null, goal: type === 'event' ? 'Clicked' : null, visitorId, sessionId: `s_${visitorId}`, ts, url: '/', props, receivedAt: ts,
});

describe('sqliteStore analytics', () => {
  it('keeps engage and identify rows and counts users', async () => {
    const store = sqliteStore({ file: ':memory:' });
    await store.insertEvents([
      row('p1', 'page', 'v1', null),
      row('e1', 'event', 'v2', null),
      row('n1', 'engage', 'v1', { ms: 3000, scroll: 40 }),
      row('i1', 'identify', 'v1', { uid: 'u_1', traits: { plan: 'pro' } }),
      row('i2', 'identify', 'v3', { uid: 'u_1' }),
      row('i3', 'identify', 'v4', { uid: 'u_2' }),
    ]);
    expect(await store.propertyCounts!('site', 0)).toEqual({ pageviews: 1, visitors: 2, sessions: 2, users: 2, events: [{ name: 'Clicked', count: 1, visitors: 1 }] });
    // `until` is exclusive: rows at ts 1000 fall outside [0, 1000).
    expect(await store.propertyCounts!('site', 0, 1000)).toEqual({ pageviews: 0, visitors: 0, sessions: 0, users: 0, events: [] });
    expect(await store.propertyCounts!('site', 0, 1001)).toMatchObject({ pageviews: 1, users: 2 });
    const rows = await store.propertyEvents!('site', { before: 2000, limit: 10 });
    expect(rows.map((r) => r.type).sort()).toEqual(['engage', 'event', 'identify', 'identify', 'identify', 'page']);
    expect(rows.find((r) => r.id === 'n1')?.props).toEqual({ ms: 3000, scroll: 40 });
    store.close?.();
  });
});
