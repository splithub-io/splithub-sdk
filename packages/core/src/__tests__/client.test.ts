import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../client';
import { defineConfig } from '../config';
import type { EventBatch } from '../types';

const config = defineConfig({
  project: 'p',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' }, pricing: { type: 'pageview', path: '/pricing' } },
  experiments: {
    hero: { kind: 'component', status: 'running', variants: { control: 1, bold: 1 }, goal: 'signup' },
    title: {
      kind: 'value',
      status: 'running',
      variants: { control: { weight: 1, value: 'Plain' }, loud: { weight: 1, value: 'LOUD' } },
    },
    off: { kind: 'value', status: 'paused', variants: { control: { weight: 1, value: 'c' }, b: { weight: 1, value: 'b' } } },
  },
});

function memoryTransport() {
  const batches: EventBatch[] = [];
  return { batches, send: (b: EventBatch) => void batches.push(b) };
}

describe('createClient', () => {
  it('records one exposure per experiment and sends goals', async () => {
    const t = memoryTransport();
    const client = createClient(config, { visitorId: 'v_1', sessionId: 's_1', transport: t });
    const v1 = client.variant('hero');
    const v2 = client.variant('hero');
    expect(v1).toBe(v2);
    client.track('signup', { plan: 'pro' });
    client.pageview('/pricing');
    await client.flush();
    const events = t.batches.flatMap((b) => b.events);
    expect(events.filter((e) => e.type === 'exposure')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'goal').map((e) => (e as { goal: string }).goal)).toEqual(['signup', 'pricing']);
  });

  it('returns control value when paused, without exposure', async () => {
    const t = memoryTransport();
    const client = createClient(config, { visitorId: 'v_1', transport: t });
    expect(client.value('off')).toBe('c');
    await client.flush();
    expect(t.batches).toHaveLength(0);
  });

  it('overrides skip exposure', async () => {
    const t = memoryTransport();
    const client = createClient(config, { visitorId: 'v_1', transport: t, overrides: { title: 'loud' } });
    expect(client.value('title')).toBe('LOUD');
    await client.flush();
    expect(t.batches).toHaveLength(0);
  });
});

describe('cloud: nothing the cloud would refuse is sent', () => {
  const cloudConfig = (status: 'draft' | 'running') =>
    defineConfig({
      project: 'p',
      storage: { mode: 'cloud', key: 'pk_live_x' },
      runDraftsInDev: true,
      goals: { signup: { type: 'event' } },
      experiments: { hero: { kind: 'value', status, variants: { control: { weight: 0, value: 'a' }, b: { weight: 1, value: 'b' } }, goal: 'signup' } },
    });
  afterEach(() => vi.unstubAllEnvs());

  it('serves a draft in development but sends neither its exposure nor goals while nothing runs', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const t = memoryTransport();
    const client = createClient(cloudConfig('draft'), { visitorId: 'v_1', sessionId: 's_1', transport: t, remote: { disabled: true } });
    expect(client.value('hero')).toBe('b');
    client.track('signup');
    await client.flush();
    expect(t.batches.flatMap((b) => b.events)).toHaveLength(0);
  });

  it('never sends from development, even for a running test', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const t = memoryTransport();
    const client = createClient(cloudConfig('running'), { visitorId: 'v_1', sessionId: 's_1', transport: t, remote: { disabled: true } });
    expect(client.value('hero')).toBe('b');
    client.track('signup');
    await client.flush();
    expect(t.batches.flatMap((b) => b.events)).toHaveLength(0);
  });

  it('sends exposures and goals once a test runs', async () => {
    const t = memoryTransport();
    const client = createClient(cloudConfig('running'), { visitorId: 'v_1', sessionId: 's_1', transport: t, remote: { disabled: true } });
    client.value('hero');
    client.track('signup');
    await client.flush();
    expect(t.batches.flatMap((b) => b.events).map((e) => e.type)).toEqual(['exposure', 'goal']);
  });
});
