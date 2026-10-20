import { createClient, defineConfig, type EventBatch } from '@splithub/core';
import { describe, expect, it } from 'vitest';
import { experimentGoals, goalsFromAnalytics } from '../derive';
import { createSplitHubHandler } from '../handler';
import { createMemoryStore, type StoredEvent } from '../store';

const config = defineConfig({
  project: 'demo',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event', revenue: true }, pricing: { type: 'pageview', path: '/pricing' }, docs: { type: 'pageview', path: '/docs/*' }, unused: { type: 'event' } },
  experiments: {
    hero: { kind: 'component', status: 'running', variants: { control: 1, bold: 1 }, goal: 'signup', metrics: { secondary: ['pricing', 'Video Played'] } },
  },
  properties: { site: {} },
});

const row = (over: Partial<StoredEvent>): StoredEvent => ({ id: 'e_00000001', type: 'event', experiment: 'site', variant: null, goal: null, visitorId: 'v1', sessionId: 's1', ts: 1000, url: '/', props: null, receivedAt: 1000, ...over });

describe('goalsFromAnalytics', () => {
  const goals = experimentGoals(config);

  it('lists only the goals experiments are judged on, primary and metrics', () => {
    expect(goals.map((g) => g.key).sort()).toEqual(['pricing', 'signup', 'video-played']);
  });

  it('turns an event into its goal (props kept) and a page into the pageview goals it matches', () => {
    const out = goalsFromAnalytics(
      [
        row({ id: 'e_00000001', goal: 'signup', props: { revenue: 9 } }),
        row({ id: 'e_00000002', goal: 'Video Played' }),
        row({ id: 'e_00000003', goal: 'unused' }),
        row({ id: 'p_00000001', type: 'page', url: '/pricing?ref=x', props: { title: 'Pricing' } }),
        row({ id: 'p_00000002', type: 'page', url: '/docs/intro' }),
      ],
      goals
    );
    expect(out.map((g) => [g.type, g.goal, g.props, g.ts, g.experiment])).toEqual([
      ['goal', 'signup', { revenue: 9 }, 1000, null],
      ['goal', 'video-played', null, 1000, null],
      ['goal', 'pricing', null, 1000, null],
    ]);
    expect(new Set(out.map((g) => g.id)).size).toBe(3);
  });

  it('derives nothing when the batch already has the goal row of the same action (older SDKs)', () => {
    const out = goalsFromAnalytics(
      [
        row({ id: 'g_00000001', type: 'goal', experiment: null, goal: 'signup', ts: 1400 }),
        row({ id: 'e_00000001', goal: 'signup', ts: 1000 }),
        row({ id: 'e_00000002', goal: 'signup', ts: 5000 }),
        row({ id: 'e_00000003', goal: 'signup', ts: 1000, visitorId: 'v2' }),
      ],
      goals
    );
    expect(out.map((g) => [g.visitorId, g.ts])).toEqual([
      ['v1', 5000],
      ['v2', 1000],
    ]);
  });
});

describe('self-hosted handler with a property', () => {
  const post = (handler: ReturnType<typeof createSplitHubHandler>, body: unknown) =>
    handler(new Request('http://x/api/splithub', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));

  async function run(sdk: (client: ReturnType<typeof createClient>) => void, property: string | undefined) {
    const store = createMemoryStore();
    const handler = createSplitHubHandler({ config, store });
    for (let i = 0; i < 40; i++) {
      const sent: EventBatch[] = [];
      const client = createClient(config, { visitorId: `v_${i}`, sessionId: `s_${i}`, transport: { send: (b) => void sent.push(b) }, ...(property ? { property } : {}) });
      client.variant('hero');
      if (i % 2 === 0) sdk(client);
      await client.flush();
      for (const b of sent) expect((await post(handler, b)).status).toBe(202);
    }
    const res = await handler(new Request('http://x/api/splithub/results/hero'));
    return { store, body: (await res.json()) as { variants: Array<{ visitors: number; conversions: number; revenue?: number }>; metrics?: Array<{ metric: string; variants: Array<{ conversions: number }> }> } };
  }
  const total = (vs: Array<{ conversions: number }>) => vs.reduce((n, v) => n + v.conversions, 0);

  it('counts one event row per track() as the conversion, with revenue, like a goal row', async () => {
    const withProperty = await run((c) => c.track('signup', { revenue: 10 }), 'site');
    const without = await run((c) => c.track('signup', { revenue: 10 }), undefined);
    expect(withProperty.store.events.filter((e) => e.type === 'event')).toHaveLength(20);
    expect(total(withProperty.body.variants)).toBe(20);
    expect(withProperty.body.variants.reduce((n, v) => n + (v.revenue ?? 0), 0)).toBe(200);
    expect(withProperty.body.variants).toEqual(without.body.variants);
  });

  it('counts a page row as the pageview goal of a metric', async () => {
    const { body } = await run((c) => c.pageview('/pricing'), 'site');
    expect(total(body.metrics!.find((m) => m.metric === 'pricing')!.variants)).toBe(20);
  });

  it('counts a batch from an older SDK (goal row and event row) once', async () => {
    const store = createMemoryStore();
    const handler = createSplitHubHandler({ config, store });
    const ts = Date.now();
    await post(handler, {
      project: 'demo',
      sdk: 'core/0.0.9',
      events: [
        { id: 'x_00000001', type: 'exposure', exp: 'hero', var: 'bold', vid: 'v1', sid: 's1', ts },
        { id: 'g_00000001', type: 'goal', goal: 'signup', vid: 'v1', sid: 's1', ts: ts + 10, props: { revenue: 5 } },
        { id: 'v_00000001', type: 'event', prop: 'site', name: 'signup', vid: 'v1', sid: 's1', ts: ts + 10, props: { revenue: 5 } },
      ],
    });
    expect(store.events.filter((e) => e.type === 'goal')).toHaveLength(1);
    const res = (await (await handler(new Request('http://x/api/splithub/results/hero'))).json()) as { variants: Array<{ conversions: number; revenue?: number }> };
    expect(total(res.variants)).toBe(1);
    expect(res.variants.reduce((n, v) => n + (v.revenue ?? 0), 0)).toBe(5);
  });
});
