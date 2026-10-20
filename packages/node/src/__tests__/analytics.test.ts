import { createClient, defineConfig, type EventBatch, type SplitHubEvent } from '@splithub/core';
import { describe, expect, it } from 'vitest';
import { createSplitHubHandler } from '../handler';
import { createMemoryStore } from '../store';
import { validateBatch } from '../validate';
import { propertyCountsSql, rawPropertyRange } from '../analytics';

const config = defineConfig({
  project: 'demo',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' } },
  experiments: {},
  properties: { site: { goals: ['signup'] }, old: { status: 'paused' } },
});

const now = Date.now();
const page = (id: string, vid: string, prop = 'site', url = '/'): SplitHubEvent => ({ id, type: 'page', prop, vid, sid: `s_${vid}`, ts: now, url, title: 'Home', ref: 'https://google.com/' });
const event = (id: string, vid: string, name: string): SplitHubEvent => ({ id, type: 'event', prop: 'site', name, vid, sid: `s_${vid}`, ts: now, url: '/pricing', props: { plan: 'pro' } });

function post(handler: ReturnType<typeof createSplitHubHandler>, events: SplitHubEvent[]) {
  const body: EventBatch = { project: 'demo', sdk: 'test', events };
  return handler(new Request('http://x/api/splithub', { method: 'POST', body: JSON.stringify(body) }));
}

describe('analytics events', () => {
  it('validates pages and events into the shared columns', () => {
    const r = validateBatch({ project: 'demo', events: [page('p_00000001', 'v1'), event('v_00000001', 'v1', 'Video Played')] }, 'demo', now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.events[0]).toMatchObject({ type: 'page', experiment: 'site', goal: null, url: '/', props: { title: 'Home', ref: 'https://google.com/' } });
    expect(r.events[1]).toMatchObject({ type: 'event', experiment: 'site', goal: 'Video Played', props: { plan: 'pro' } });
    expect(validateBatch({ project: 'demo', events: [{ ...event('v_00000002', 'v1', 'x'), name: '<script>' }] }, 'demo')).toMatchObject({ ok: true, events: [], dropped: 1, errors: ['event.name is invalid'] });
    expect(validateBatch({ project: 'demo', events: [{ ...page('p_00000002', 'v1'), url: undefined }] }, 'demo')).toMatchObject({ ok: true, dropped: 1 });
  });

  it('stores running properties only and reports raw counts', async () => {
    const store = createMemoryStore();
    const handler = createSplitHubHandler({ config, store });
    const res = await post(handler, [page('p_00000001', 'v1'), page('p_00000002', 'v1', 'site', '/pricing'), page('p_00000003', 'v2'), event('v_00000001', 'v1', 'signup'), page('p_00000004', 'v3', 'old'), page('p_00000005', 'v3', 'nope')]);
    expect(res.status).toBe(202);
    expect(store.events).toHaveLength(4);

    const one = await (await handler(new Request('http://x/api/splithub/properties/site'))).json();
    expect(one).toMatchObject({ property: 'site', status: 'running', goals: ['signup'], counts: { pageviews: 3, visitors: 2, sessions: 2, events: [{ name: 'signup', count: 1, visitors: 1 }] }, analysis: { available: false } });

    const list = await (await handler(new Request('http://x/api/splithub/properties'))).json();
    expect(list.properties.map((p: { property: string }) => p.property)).toEqual(['site', 'old']);

    const raw = await (await handler(new Request('http://x/api/splithub/properties/site/events?limit=2'))).json();
    expect(raw.events).toHaveLength(2);
    expect((await handler(new Request('http://x/api/splithub/properties/nope'))).status).toBe(404);
  });

  it('analytics rows never count as exposures or goals', async () => {
    const store = createMemoryStore();
    const r = validateBatch({ project: 'demo', events: [event('v_00000003', 'v1', 'signup')] }, 'demo');
    if (!r.ok) throw new Error(r.error);
    await store.insertEvents(r.events);
    expect(await store.summaries()).toEqual([]);
    expect(await store.variantCounts('site', 'signup')).toEqual([]);
  });

  it('the client sends pages and events to the property it names', async () => {
    const sent: EventBatch[] = [];
    const client = createClient(config, { visitorId: 'v1', sessionId: 's1', property: 'site', transport: { send: async (b) => void sent.push(b) } });
    client.pageview('/pricing');
    client.pageview('/pricing');
    client.track('Video Played', { id: 3 });
    client.track('signup');
    await client.flush();
    const events = sent.flatMap((b) => b.events);
    expect(events.filter((e) => e.type === 'page')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'event').map((e) => (e as { name: string }).name)).toEqual(['Video Played', 'signup']);
    // One row per action: the ingest derives the goals from the event rows.
    expect(events.filter((e) => e.type === 'goal')).toEqual([]);
  });

  it('reads a from / to range of UTC days, and refuses a malformed one', async () => {
    const store = createMemoryStore();
    const handler = createSplitHubHandler({ config, store });
    const at = (id: string, day: string) => {
      const ts = Date.parse(`${day}T12:00:00Z`);
      return { id, type: 'page' as const, experiment: 'site', variant: null, goal: null, visitorId: `v_${id}`, sessionId: `s_${id}`, ts, url: '/', props: null, receivedAt: ts };
    };
    await store.insertEvents([at('p11', '2026-10-01'), at('p12', '2026-10-02'), at('p13', '2026-10-05')]);
    const read = async (q: string) => (await handler(new Request(`http://x/api/splithub/properties/site?${q}`))).json();
    expect(await read('from=2026-10-01&to=2026-10-02')).toMatchObject({ days: 2, range: { from: '2026-10-01', to: '2026-10-02' }, counts: { pageviews: 2 } });
    expect(await read('from=2026-10-02&to=2026-10-05')).toMatchObject({ days: 4, counts: { pageviews: 2 } });
    expect(await read('to=2026-10-01')).toMatchObject({ days: 30, range: { from: '2026-09-02', to: '2026-10-01' }, counts: { pageviews: 1 } });
    const bad = await handler(new Request('http://x/api/splithub/properties/site?from=2026-10-05&to=2026-10-01'));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'invalid_range', hint: expect.stringContaining('2026-10-01') });
    expect((await handler(new Request('http://x/api/splithub/properties?from=yesterday'))).status).toBe(400);
    expect(rawPropertyRange({ days: 7, now: Date.parse('2026-10-08T00:00:00Z') })).toMatchObject({ days: 7, range: { from: '2026-10-01', to: '2026-10-08' } });
  });

  it('builds placeholders per dialect', () => {
    const pg = propertyCountsSql({ dialect: 'postgres', projectColumn: 'project_id' });
    expect(pg.totals.sql).toContain('$4');
    expect(pg.totals.bind({ project: 'p', property: 'site', since: 1, until: 5 })).toEqual(['p', 'site', 1, 5]);
    // A store generated before `until` binds only `since`: the range stays open-ended.
    expect(pg.totals.bind({ project: 'p', property: 'site', since: 1 })).toEqual(['p', 'site', 1, Number.MAX_SAFE_INTEGER]);
    const my = propertyCountsSql({ dialect: 'mysql' });
    expect(my.rows.bind({ property: 'site', before: 2, limit: 10 })).toEqual(['site', 2, 10]);
  });
});
