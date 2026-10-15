import { createClient, defineConfig, type EventBatch } from '@splithub/core';
import { describe, expect, it, vi } from 'vitest';
import { createSplitHubHandler } from '../handler';
import { createMemoryStore, type StoredEvent } from '../store';

const config = defineConfig({
  project: 'demo',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event', revenue: true } },
  experiments: {
    hero: { kind: 'component', status: 'running', variants: { control: 1, bold: 1 }, goal: 'signup' },
  },
});

function post(handler: ReturnType<typeof createSplitHubHandler>, body: unknown) {
  return handler(new Request('http://x/api/splithub', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
}

describe('createSplitHubHandler', () => {
  it('ingests, dedups and reports results', async () => {
    const store = createMemoryStore();
    const handler = createSplitHubHandler({ config, store });

    // Simulate 400 visitors through the real client so hashing matches production, spread
    // over 7.5 days, past the runtime minimum and the under-a-week note. Each batch is posted as it
    // happens, so ingest sees a fresh timestamp.
    const start = Date.UTC(2026, 0, 5);
    vi.useFakeTimers({ toFake: ['Date'] });
    const batches: EventBatch[] = [];
    try {
      for (let i = 0; i < 400; i++) {
        vi.setSystemTime(start + Math.floor((i * 7.5 * 86_400_000) / 400));
        const sent: EventBatch[] = [];
        const client = createClient(config, { visitorId: `v_${i}`, sessionId: `s_${i}`, transport: { send: (b) => void sent.push(b) } });
        const variant = client.variant('hero');
        // bold converts at 50%, control at 10%
        if (i % (variant === 'bold' ? 2 : 10) === 0) client.track('signup', { revenue: 10 });
        await client.flush();
        for (const b of sent) {
          const res = await post(handler, b);
          expect(res.status).toBe(202);
        }
        batches.push(...sent);
      }
    } finally {
      vi.useRealTimers();
    }
    // replay: nothing new inserted
    const replay = await post(handler, batches[0]);
    expect(((await replay.json()) as { inserted: number }).inserted).toBe(0);

    const status = await handler(new Request('http://x/api/splithub/status'));
    const rows = ((await status.json()) as { experiments: Array<{ exposures: number; visitors: number }> }).experiments;
    expect(rows[0]!.visitors).toBe(400);

    const results = await handler(new Request('http://x/api/splithub/results/hero'));
    const body = (await results.json()) as { variants: Array<{ variant: string; visitors: number; conversions: number; rate: number; revenue?: number }>; days: number; analysis: { available: boolean }; verdict?: unknown };
    // Raw numbers in declared order (control first); no verdict on a self-hosted read.
    expect(body.variants.map((v) => v.variant)).toEqual(['control', 'bold']);
    expect(body.variants.reduce((s, v) => s + v.visitors, 0)).toBe(400);
    const bold = body.variants[1]!;
    expect(bold.rate).toBeCloseTo(bold.conversions / bold.visitors);
    expect(bold.rate).toBeGreaterThan(body.variants[0]!.rate);
    expect(bold.revenue).toBe(bold.conversions * 10);
    expect(body.days).toBeGreaterThan(7);
    expect(body.analysis).toEqual({ available: false, message: 'Verdicts, stars and recommendations come with SplitHub Cloud.', url: 'https://splithub.io/cloud' });
    expect(body.verdict).toBeUndefined();
    const statusBody = (await (await handler(new Request('http://x/api/splithub/status'))).json()) as { experiments: Array<Record<string, unknown>>; analysis: { available: boolean } };
    expect(statusBody.analysis.available).toBe(false);
    expect(Object.keys(statusBody.experiments[0]!).sort()).toEqual(['days', 'description', 'experiment', 'exposures', 'goal', 'kind', 'name', 'status', 'visitors']);
  });

  it('counts a visitor once, in the variant of their earliest exposure', async () => {
    const store = createMemoryStore();
    const ev = (id: string, e: Partial<StoredEvent> & Pick<StoredEvent, 'type' | 'visitorId' | 'ts'>): StoredEvent => ({
      id, experiment: 'hero', variant: null, goal: null, sessionId: 's', url: null, props: null, receivedAt: e.ts, ...e,
    });
    await store.insertEvents([
      // v1 saw control first, then bold, then converted: control only.
      ev('1', { type: 'exposure', variant: 'control', visitorId: 'v1', ts: 100 }),
      ev('2', { type: 'exposure', variant: 'bold', visitorId: 'v1', ts: 200 }),
      ev('3', { type: 'goal', experiment: null, goal: 'signup', visitorId: 'v1', ts: 300, props: { revenue: 5 } }),
      // v2 saw bold only; a goal more than the clock-skew allowance before the exposure does not count.
      ev('4', { type: 'goal', experiment: null, goal: 'signup', visitorId: 'v2', ts: 100 - 60_001 }),
      ev('5', { type: 'exposure', variant: 'bold', visitorId: 'v2', ts: 100 }),
      // v3 saw both at the same ts: the smaller variant key wins.
      ev('6', { type: 'exposure', variant: 'control', visitorId: 'v3', ts: 100 }),
      ev('7', { type: 'exposure', variant: 'bold', visitorId: 'v3', ts: 100 }),
    ]);
    const counts = await store.variantCounts('hero', 'signup');
    expect(counts.find((c) => c.variant === 'control')).toEqual({ variant: 'control', exposures: 1, conversions: 1, revenue: 5, revenueSum: 5, revenueSumSq: 25 });
    expect(counts.find((c) => c.variant === 'bold')).toEqual({ variant: 'bold', exposures: 2, conversions: 0, revenue: 0, revenueSum: 0, revenueSumSq: 0 });
  });

  it('rejects bad input and wrong project', async () => {
    const handler = createSplitHubHandler({ config, store: createMemoryStore() });
    expect((await post(handler, { project: 'other', events: [] })).status).toBe(400);
    expect((await post(handler, { project: 'demo', events: [{ type: 'nope' }] })).status).toBe(400);
    expect((await handler(new Request('http://x/api/splithub/results/missing'))).status).toBe(404);
  });

  it('guards read endpoints with the admin token', async () => {
    const handler = createSplitHubHandler({ config, store: createMemoryStore(), adminToken: 'secret' });
    expect((await handler(new Request('http://x/api/splithub/status'))).status).toBe(401);
    expect((await handler(new Request('http://x/api/splithub/status', { headers: { authorization: 'Bearer secret' } }))).status).toBe(200);
    expect((await handler(new Request('http://x/api/splithub/health'))).status).toBe(200);
  });
});

describe('bot filter', () => {
  it('drops batches sent by crawlers and keeps plain clients', async () => {
    const store = createMemoryStore();
    const handler = createSplitHubHandler({ config, store });
    const batch = { project: 'demo', events: [{ type: 'exposure', id: 'evt_bot_0001', vid: 'v1', sid: 's1', ts: Date.now(), exp: 'hero', var: 'control' }] };
    const send = (ua: string) => handler(new Request('http://x/api/splithub', { method: 'POST', body: JSON.stringify(batch), headers: { 'user-agent': ua } }));
    const bot = await send('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
    expect(bot.status).toBe(202);
    expect(((await bot.json()) as { inserted: number }).inserted).toBe(0);
    expect(store.events.length).toBe(0);
    await send('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36');
    expect(store.events.length).toBe(1);
  });
});
