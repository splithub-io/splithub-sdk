import { describe, expect, it } from 'vitest';
import { applyRemoteOverrides } from '../remote';
import { assign, countsForHoldout, holdoutGroup, inLayer, layerBucket } from '../assignment';
import { createClient } from '../client';
import { defineConfig, HOLDOUT_KEY, holdoutExperiment, measuredGoals } from '../config';
import type { EventBatch, ExposureEvent, SplitHubConfigInput } from '../types';

const base = {
  project: 'p',
  storage: { mode: 'self' as const, endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' as const }, refund: { type: 'event' as const }, click: { type: 'event' as const } },
};

const layered = defineConfig({
  ...base,
  layers: { checkout: {} },
  experiments: {
    a: { kind: 'component', status: 'running', variants: { control: 1, b: 1 }, layer: { key: 'checkout', range: [0, 50] } },
    b: { kind: 'component', status: 'running', variants: { control: 1, b: 1 }, layer: { key: 'checkout', range: [50, 100] } },
    free: { kind: 'component', status: 'running', variants: { control: 1, b: 1 } },
  },
});

describe('metrics config', () => {
  it('normalizes secondary goals and guardrails', () => {
    const c = defineConfig({
      ...base,
      experiments: { x: { kind: 'component', status: 'running', variants: { control: 1, b: 1 }, goal: 'signup', metrics: { secondary: ['click'], guardrails: [{ goal: 'refund', worse: 'higher' }] } } },
    });
    expect(c.experiments[0]!.metrics).toEqual({ secondary: ['click'], guardrails: [{ goal: 'refund', worse: 'higher' }] });
    expect(measuredGoals(c)).toEqual({ goals: { x: 'signup' }, metrics: { x: ['click', 'refund'] } });
  });

  it('rejects unknown, repeated and orphan metric goals', () => {
    const exp = (metrics: object, goal = 'signup') => ({ ...base, experiments: { x: { kind: 'component', status: 'running', variants: { control: 1, b: 1 }, goal: goal || undefined, metrics } } }) as SplitHubConfigInput;
    expect(() => defineConfig(exp({ guardrails: ['nope'] }))).toThrow(/not declared/);
    expect(() => defineConfig(exp({ secondary: ['signup'] }))).toThrow(/twice/);
    expect(() => defineConfig(exp({ secondary: ['click'] }, ''))).toThrow(/primary "goal"/);
  });
});

describe('layers', () => {
  it('buckets a visitor deterministically and evenly', () => {
    expect(layerBucket(layered, 'checkout', 'v_1')).toBe(layerBucket(layered, 'checkout', 'v_1'));
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < 20000; i++) counts[Math.floor(layerBucket(layered, 'checkout', `v_${i}`) / 10)]!++;
    for (const n of counts) expect(Math.abs(n - 2000)).toBeLessThan(200);
  });

  it('never puts one visitor in two experiments of a layer', () => {
    let a = 0;
    let b = 0;
    for (let i = 0; i < 2000; i++) {
      const ra = assign(layered, 'a', `v_${i}`);
      const rb = assign(layered, 'b', `v_${i}`);
      expect(ra.reason === 'assigned' && rb.reason === 'assigned').toBe(false);
      expect([ra.reason, rb.reason].sort()).toEqual(['assigned', 'layer']);
      if (ra.reason === 'assigned') a++;
      else b++;
      // Experiments outside the layer are untouched.
      expect(assign(layered, 'free', `v_${i}`).reason).toBe('assigned');
    }
    expect(Math.abs(a - b)).toBeLessThan(200);
  });

  it('adding an experiment in a free range moves nobody', () => {
    const before = defineConfig({
      ...base,
      layers: { l: {} },
      experiments: { a: { kind: 'component', status: 'running', variants: { control: 1, b: 1 }, layer: { key: 'l', range: [0, 30] } } },
    });
    const after = defineConfig({
      ...base,
      layers: { l: {} },
      experiments: {
        a: { kind: 'component', status: 'running', variants: { control: 1, b: 1 }, layer: { key: 'l', range: [0, 30] } },
        c: { kind: 'component', status: 'running', variants: { control: 1, b: 1 }, layer: { key: 'l', range: [30, 60] } },
      },
    });
    for (let i = 0; i < 500; i++) expect(assign(after, 'a', `v_${i}`)).toEqual(assign(before, 'a', `v_${i}`));
  });

  it('a layer seed reshuffles buckets', () => {
    const seeded = { ...layered, layers: { checkout: { seed: 'other' } } };
    const moved = Array.from({ length: 200 }, (_, i) => `v_${i}`).filter((v) => layerBucket(seeded, 'checkout', v) !== layerBucket(layered, 'checkout', v));
    expect(moved.length).toBeGreaterThan(150);
    expect(inLayer(layered, { layer: undefined }, 'v_1')).toBe(true);
  });

  it('validates layers and overlapping ranges', () => {
    const cfg = (layers: SplitHubConfigInput['layers'], ranges: Array<[number, number]>, statuses: string[] = []) =>
      ({
        ...base,
        layers,
        experiments: Object.fromEntries(ranges.map((range, i) => [`e${i}`, { kind: 'component', status: statuses[i] ?? 'running', variants: { control: 1, b: 1 }, layer: { key: 'l', range } }])),
      }) as SplitHubConfigInput;
    expect(() => defineConfig(cfg({ l: {} }, [[0, 50], [40, 100]]))).toThrow(/overlap in layer "l"/);
    expect(() => defineConfig(cfg({ l: {} }, [[0, 50], [50, 100]]))).not.toThrow();
    // A finished experiment's range can be reused.
    expect(() => defineConfig(cfg({ l: {} }, [[0, 50], [0, 50]], ['finished', 'running']))).not.toThrow();
    expect(() => defineConfig(cfg(undefined, [[0, 50]]))).toThrow(/not declared in "layers"/);
    expect(() => defineConfig(cfg({ l: {} }, [[50, 50]]))).toThrow(/start < end/);
    expect(() => defineConfig(cfg({ l: {} }, [[0, 101]]))).toThrow(/layer.range/);
  });

  it('checks the layer before the targeting flow', () => {
    const c = defineConfig({
      ...base,
      layers: { l: {} },
      experiments: {
        a: {
          kind: 'component',
          status: 'running',
          variants: { control: 1, b: 1 },
          layer: { key: 'l', range: [0, 10] },
          flow: { start: 'v', nodes: { v: { type: 'variant', variant: 'b' } } },
        },
      },
    });
    const outside = Array.from({ length: 50 }, (_, i) => `v_${i}`).find((v) => layerBucket(c, 'l', v) >= 10)!;
    const inside = Array.from({ length: 200 }, (_, i) => `v_${i}`).find((v) => layerBucket(c, 'l', v) < 10)!;
    expect(assign(c, 'a', outside).reason).toBe('layer');
    expect(assign(c, 'a', inside).variant?.key).toBe('b');
  });
});

describe('holdout', () => {
  const held = defineConfig({
    ...base,
    holdout: { percent: 10 },
    experiments: {
      a: { kind: 'component', status: 'running', variants: { control: 1, b: 1 }, goal: 'signup' },
      off: { kind: 'component', status: 'paused', variants: { control: 1, b: 1 } },
    },
  });

  it('holds out the configured share, the same visitors in every experiment', () => {
    let n = 0;
    for (let i = 0; i < 20000; i++) {
      const g = holdoutGroup(held, `v_${i}`);
      if (g === 'holdout') {
        n++;
        expect(assign(held, 'a', `v_${i}`).reason).toBe('holdout');
      }
    }
    expect(Math.abs(n - 2000)).toBeLessThan(200);
    expect(holdoutGroup(defineConfig({ ...base, experiments: {} }), 'v_1')).toBeNull();
  });

  it('lets overrides through and leaves stopped tests alone', () => {
    const v = Array.from({ length: 200 }, (_, i) => `v_${i}`).find((x) => holdoutGroup(held, x) === 'holdout')!;
    expect(assign(held, 'a', v, { overrides: { a: 'b' } }).reason).toBe('override');
    expect(assign(held, 'off', v).reason).toBe('not_running');
    expect(countsForHoldout({ reason: 'not_running' })).toBe(false);
  });

  it('validates the percent and describes itself as an experiment', () => {
    expect(() => defineConfig({ ...base, experiments: {}, holdout: { percent: 60 } })).toThrow(/between 0 and 50/);
    expect(() => defineConfig({ ...base, experiments: {}, holdout: { percent: 5, goal: 'nope' } })).toThrow(/not declared/);
    const h = holdoutExperiment(held)!;
    expect(h.key).toBe(HOLDOUT_KEY);
    expect(h.variants.map((x) => [x.key, x.weight])).toEqual([
      ['holdout', 0.1],
      ['enrolled', 0.9],
    ]);
    expect(h.goal).toBe('signup');
    expect(h.metrics?.secondary).toEqual(['refund', 'click']);
    expect(measuredGoals(held).goals[HOLDOUT_KEY]).toBe('signup');
  });

  it('sends one __holdout exposure per visitor, held out or enrolled', async () => {
    for (const group of ['holdout', 'enrolled'] as const) {
      const vid = Array.from({ length: 300 }, (_, i) => `v_${i}`).find((x) => holdoutGroup(held, x) === group)!;
      const batches: EventBatch[] = [];
      const client = createClient(held, { visitorId: vid, sessionId: 's', transport: { send: (b) => void batches.push(b) } });
      client.variant('a');
      client.variant('a');
      client.variant('off');
      await client.flush();
      const events = batches.flatMap((b) => b.events) as ExposureEvent[];
      const markers = events.filter((e) => e.exp === HOLDOUT_KEY);
      expect(markers.map((e) => e.var)).toEqual([group]);
      expect(events.filter((e) => e.exp === 'a').length).toBe(group === 'holdout' ? 0 : 1);
    }
  });

  it('sends no marker without a holdout', async () => {
    const plain = defineConfig({ ...base, experiments: { a: { kind: 'component', status: 'running', variants: { control: 1, b: 1 } } } });
    const batches: EventBatch[] = [];
    const client = createClient(plain, { visitorId: 'v_1', sessionId: 's', transport: { send: (b) => void batches.push(b) } });
    client.variant('a');
    await client.flush();
    expect(batches.flatMap((b) => b.events).map((e) => (e as ExposureEvent).exp)).toEqual(['a']);
  });

  it('hosted configs get holdout and layer seeds from the overrides; a config file wins', () => {
    const plain = defineConfig({ ...base, experiments: {} });
    const merged = applyRemoteOverrides(plain, { version: 1, experiments: {}, holdout: { percent: 5, seed: 's', goal: null }, layers: { l: { seed: 'x' } } });
    expect(merged.holdout).toEqual({ percent: 5, seed: 's', goal: null });
    expect(merged.layers).toEqual({ l: { seed: 'x' } });
    expect(applyRemoteOverrides(held, { version: 1, experiments: {}, holdout: { percent: 5, seed: 's', goal: null } }).holdout?.percent).toBe(10);
  });
});
