import { defineConfig, type SplitHubEvent } from '@splithub/core';
import { describe, expect, it } from 'vitest';
import { createSplitHubHandler } from '../handler';
import { createMemoryStore } from '../store';
import { validateBatch } from '../validate';
import { propertyCountsSql } from '../analytics';

const config = defineConfig({
  project: 'demo',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' } },
  experiments: { hero: { kind: 'component', status: 'running', variants: { control: 1, bold: 1 }, goal: 'signup' } },
  properties: { site: {} },
});
const now = Date.now();
const base = (id: string, vid = 'v1') => ({ id, vid, sid: `s_${vid}`, ts: now });

describe('engage and identify', () => {
  it('validates them into the shared columns', () => {
    const r = validateBatch(
      {
        project: 'demo',
        events: [
          { ...base('n_00000001'), type: 'engage', prop: 'site', url: '/pricing', ms: 4200.4, scroll: 140 },
          { ...base('i_00000001'), type: 'identify', prop: 'SITE', uid: ' u_42 ', traits: { plan: 'pro', seats: 3, deep: { no: 1 } } },
        ],
      },
      'demo',
      now
    );
    expect(r.ok && r.dropped).toBe(0);
    if (!r.ok) return;
    expect(r.events[0]).toMatchObject({ type: 'engage', experiment: 'site', goal: null, url: '/pricing', props: { ms: 4200, scroll: 100 } });
    expect(r.events[1]).toMatchObject({ type: 'identify', experiment: 'site', goal: null, url: null, props: { uid: 'u_42', traits: { plan: 'pro', seats: 3 } } });
  });

  it('drops bad events one by one and keeps the rest of the batch', async () => {
    const store = createMemoryStore();
    const handler = createSplitHubHandler({ config, store });
    const events = [
      { ...base('e_00000001'), type: 'exposure', exp: 'hero', var: 'control' },
      { ...base('g_00000001'), type: 'goal', goal: 'Video Played' },
      { ...base('g_00000002'), type: 'goal', goal: 'signup', props: { blob: 'x'.repeat(5000) } },
      { ...base('n_00000002'), type: 'engage', prop: 'site', url: '/', ms: 'long', scroll: 10 },
      { ...base('i_00000002'), type: 'identify', prop: 'site', uid: '' },
      { ...base('p_00000001'), type: 'page', prop: 'site', url: '/' },
    ] as unknown as SplitHubEvent[];
    const res = await handler(new Request('http://x/api/splithub', { method: 'POST', body: JSON.stringify({ project: 'demo', events }) }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { received: number; inserted: number; dropped: number; errors: string[] };
    expect(body).toMatchObject({ received: 6, inserted: 2, dropped: 4 });
    expect(body.errors).toContain('goal.goal is invalid');
    expect(store.events.map((e) => e.type)).toEqual(['exposure', 'page']);
  });

  it('counts users and keeps engage and identify rows in the raw tail', async () => {
    const store = createMemoryStore();
    const handler = createSplitHubHandler({ config, store });
    const events = [
      { ...base('p_00000011'), type: 'page', prop: 'site', url: '/' },
      { ...base('n_00000011'), type: 'engage', prop: 'site', url: '/', ms: 3000, scroll: 50 },
      { ...base('i_00000011'), type: 'identify', prop: 'site', uid: 'u_1' },
      { ...base('i_00000012', 'v2'), type: 'identify', prop: 'site', uid: 'u_1' },
      { ...base('i_00000013', 'v3'), type: 'identify', prop: 'site', uid: 'u_2' },
    ];
    await handler(new Request('http://x/api/splithub', { method: 'POST', body: JSON.stringify({ project: 'demo', events }) }));
    const one = (await (await handler(new Request('http://x/api/splithub/properties/site'))).json()) as { counts: Record<string, unknown> };
    expect(one.counts).toMatchObject({ pageviews: 1, visitors: 1, sessions: 1, users: 2 });
    const raw = (await (await handler(new Request('http://x/api/splithub/properties/site/events'))).json()) as { events: Array<{ type: string }> };
    expect(raw.events.map((e) => e.type).sort()).toEqual(['engage', 'identify', 'identify', 'identify', 'page']);
    expect(await store.summaries()).toEqual([]);
  });

  it('reads users in SQL from the identify rows', () => {
    for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
      const sql = propertyCountsSql({ dialect }).totals.sql;
      expect(sql).toContain('AS users');
      expect(sql).toContain("'identify'");
    }
  });
});
