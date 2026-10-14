import { describe, expect, it } from 'vitest';
import { defineConfig, HOLDOUT_KEY } from '@splithub/core';
import { createMemoryStore, rawResults, rawStatusTable, type StoredEvent } from '../index';

const DAY = 86_400_000;
const config = defineConfig({
  project: 'demo',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' }, refund: { type: 'event' }, click: { type: 'event' } },
  holdout: { percent: 10 },
  experiments: {
    hero: {
      kind: 'component',
      status: 'running',
      variants: { control: 1, bold: 1, quiet: 1 },
      goal: 'signup',
      metrics: { secondary: ['click'], guardrails: [{ goal: 'refund', worse: 'higher' }] },
    },
    nogoal: { kind: 'component', status: 'paused', variants: { a: 1, b: 1 } },
  },
});

let n = 0;
const exposure = (exp: string, variant: string, vid: string, ts: number): StoredEvent => ({ id: `e${n++}`, type: 'exposure', experiment: exp, variant, goal: null, visitorId: vid, sessionId: 's', ts, url: null, props: null, receivedAt: ts });
const goal = (g: string, vid: string, ts: number): StoredEvent => ({ id: `g${n++}`, type: 'goal', experiment: null, variant: null, goal: g, visitorId: vid, sessionId: 's', ts, url: null, props: null, receivedAt: ts });

describe('raw results', () => {
  it('counts per variant and per metric goal, in declared order, with no statistics', async () => {
    const store = createMemoryStore();
    const events: StoredEvent[] = [];
    for (let i = 0; i < 100; i++) {
      const variant = i % 2 ? 'bold' : 'control';
      events.push(exposure('hero', variant, `v${i}`, i * (3 * DAY / 100)));
      if (i % 4 < 2) events.push(goal('signup', `v${i}`, i * (3 * DAY / 100) + 10));
      if (i % 10 === 1) events.push(goal('refund', `v${i}`, i * (3 * DAY / 100) + 20));
    }
    await store.insertEvents(events);
    const r = (await rawResults(config, store, 'hero'))!;
    expect(r.variants).toEqual([
      { variant: 'control', visitors: 50, conversions: 25, rate: 0.5 },
      { variant: 'bold', visitors: 50, conversions: 25, rate: 0.5 },
      { variant: 'quiet', visitors: 0, conversions: 0, rate: 0 },
    ]);
    expect(r.metrics?.map((m) => [m.metric, m.role, m.variants[1]!.conversions])).toEqual([
      ['click', 'secondary', 0],
      ['refund', 'guardrail', 10],
    ]);
    expect(r.metrics?.[1]?.worse).toBe('higher');
    expect(r.days).toBeCloseTo(2.97, 1);
    expect(r.analysis.available).toBe(false);
    expect(r).not.toHaveProperty('verdict');
    expect(await rawResults(config, store, 'missing')).toBeNull();
    const none = (await rawResults(config, store, 'nogoal'))!;
    expect(none.goal).toBeNull();
    expect(none.variants.every((v) => v.visitors === 0)).toBe(true);
  });

  it('lists the holdout once it has visitors', async () => {
    const store = createMemoryStore();
    expect((await rawStatusTable(config, store)).map((r) => r.experiment)).toEqual(['hero', 'nogoal']);
    await store.insertEvents([exposure(HOLDOUT_KEY, 'holdout', 'h1', 1000), exposure(HOLDOUT_KEY, 'enrolled', 'h2', 1000 + DAY / 2)]);
    const rows = await rawStatusTable(config, store);
    expect(rows.map((r) => r.experiment)).toEqual(['hero', 'nogoal', HOLDOUT_KEY]);
    expect(rows[2]).toMatchObject({ visitors: 2, days: 1 });
    const holdout = (await rawResults(config, store, HOLDOUT_KEY))!;
    expect(holdout.variants.map((v) => [v.variant, v.visitors])).toEqual([
      ['holdout', 1],
      ['enrolled', 1],
    ]);
  });
});
