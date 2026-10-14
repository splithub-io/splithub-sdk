import { createClient, defineConfig, type EventBatch } from '@splithub/core';
import { createSplitHubHandler, type StoredEvent } from '@splithub/node';
import { describe, expect, it } from 'vitest';
import { d1Schema, d1Store } from '../index';
import { sqliteD1 } from '../testing';

const config = defineConfig({
  project: 'demo',
  storage: { mode: 'cloud', key: 'pk_test' },
  goals: { signup: { type: 'event', revenue: true } },
  experiments: { hero: { kind: 'component', status: 'running', variants: { control: 1, bold: 1 }, goal: 'signup' } },
});

describe('d1Store', () => {
  it('partitions by project and matches the shared store semantics', async () => {
    const db = sqliteD1();
    await db.exec(d1Schema());
    const store = d1Store(db, { project: 'proj_a' });
    const other = d1Store(db, { project: 'proj_b' });
    const handler = createSplitHubHandler({ config, store });

    const batches: EventBatch[] = [];
    for (let i = 0; i < 300; i++) {
      const client = createClient(config, { visitorId: `v_${i}`, sessionId: `s_${i}`, transport: { send: (b) => void batches.push(b) } });
      const v = client.variant('hero');
      if (i % (v === 'bold' ? 4 : 10) === 0) client.track('signup', { revenue: 5 });
      await client.flush();
    }
    for (const b of batches) {
      const res = await handler(new Request('http://x/v1/events', { method: 'POST', body: JSON.stringify(b) }));
      expect(res.status).toBe(202);
    }
    const again = await handler(new Request('http://x/v1/events', { method: 'POST', body: JSON.stringify(batches[0]) }));
    expect(((await again.json()) as { inserted: number }).inserted).toBe(0);

    const counts = await store.variantCounts('hero', 'signup');
    expect(counts.reduce((s, c) => s + c.exposures, 0)).toBe(300);
    const bold = counts.find((c) => c.variant === 'bold')!;
    expect(bold.revenue).toBe(bold.conversions * 5);
    expect(await other.variantCounts('hero', 'signup')).toEqual([]);
    expect((await other.summaries()).length).toBe(0);

    const res = await handler(new Request('http://x/v1/results/hero'));
    // Self-hosted reads are the raw numbers per variant, straight from this store.
    const body = (await res.json()) as { variants: Array<{ variant: string; visitors: number; conversions: number; rate: number }> };
    expect(body.variants.map((v) => v.variant)).toEqual(['control', 'bold']);
    expect(body.variants[1]).toMatchObject({ visitors: bold.exposures, conversions: bold.conversions });
    expect(body.variants[1]!.rate).toBeGreaterThan(body.variants[0]!.rate * 1.5);
  });

  it('counts a visitor once, in the variant of their earliest exposure', async () => {
    const db = sqliteD1();
    await db.exec(d1Schema());
    const store = d1Store(db, { project: 'proj_a' });
    const ev = (id: string, e: Partial<StoredEvent> & Pick<StoredEvent, 'type' | 'visitorId' | 'ts'>): StoredEvent => ({
      id, experiment: 'hero', variant: null, goal: null, sessionId: 's', url: null, props: null, receivedAt: e.ts, ...e,
    });
    await store.insertEvents([
      // v1 saw control first, then bold, then converted: control only.
      ev('1', { type: 'exposure', variant: 'control', visitorId: 'v1', ts: 100 }),
      ev('2', { type: 'exposure', variant: 'bold', visitorId: 'v1', ts: 200 }),
      ev('3', { type: 'goal', experiment: null, goal: 'signup', visitorId: 'v1', ts: 300, props: { revenue: 5 } }),
      // v2 saw bold only; the goal before the exposure does not count.
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
});
