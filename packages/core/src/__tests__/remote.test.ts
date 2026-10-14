import { describe, expect, it } from 'vitest';
import { createClient } from '../client';
import { defineConfig } from '../config';
import { applyRemoteOverrides, isRemoteOverrides, resolveOverridesUrl } from '../remote';

const config = defineConfig({
  project: 'p',
  storage: { mode: 'cloud', key: 'pk_live_abc' },
  experiments: {
    hero: { kind: 'component', status: 'running', variants: { control: 1, bold: 1 } },
    title: { kind: 'value', status: 'running', variants: { control: { weight: 1, value: 'A' }, b: { weight: 1, value: 'B' } } },
  },
});

describe('applyRemoteOverrides', () => {
  it('returns the same config when there is nothing to apply', () => {
    expect(applyRemoteOverrides(config, null)).toBe(config);
    expect(applyRemoteOverrides(config, { version: 1, experiments: {} })).toBe(config);
  });

  it('patches status, traffic, weights and values without mutating', () => {
    const out = applyRemoteOverrides(config, {
      version: 3,
      experiments: {
        hero: { status: 'paused', traffic: 0.5, weights: { control: 90, bold: 10 } },
        title: { values: { b: 'B2' } },
        unknown: { status: 'finished' },
      },
    });
    const hero = out.experiments.find((e) => e.key === 'hero')!;
    expect(hero.status).toBe('paused');
    expect(hero.traffic).toBe(0.5);
    expect(hero.variants.map((v) => v.weight)).toEqual([0.9, 0.1]);
    expect(out.experiments.find((e) => e.key === 'title')!.variants[1]!.value).toBe('B2');
    expect(config.experiments[0]!.status).toBe('running');
    expect(config.experiments[0]!.variants[0]!.weight).toBe(0.5);
  });

  it('adds dashboard-created experiments that the config file does not know', () => {
    const out = applyRemoteOverrides(config, {
      version: 2,
      experiments: { landing: { traffic: 0.5 } },
      added: [
        { key: 'landing', kind: 'redirect', status: 'running', traffic: 1, goal: null, seed: 'landing', description: null, match: '/', variants: [{ key: 'control', weight: 0.5, to: '/' }, { key: 'v2', weight: 0.5, to: '/v2' }] },
        { key: 'hero', kind: 'component', status: 'paused', traffic: 1, goal: null, seed: 'hero', description: null, match: null, variants: [{ key: 'control', weight: 1 }, { key: 'x', weight: 0 }] }, // ignored: exists locally
      ],
    });
    expect(out.experiments.map((e) => e.key)).toEqual(['hero', 'title', 'landing']);
    const landing = out.experiments[2]!;
    expect(landing.origin).toBe('dashboard');
    expect(landing.traffic).toBe(0.5);
    expect(config.experiments.find((e) => e.key === 'hero')!.status).toBe('running');
  });

  it('ignores invalid traffic and unknown variant keys', () => {
    const out = applyRemoteOverrides(config, { version: 1, experiments: { hero: { traffic: 7, weights: { nope: 100 } } } });
    const hero = out.experiments[0]!;
    expect(hero.traffic).toBe(1);
    expect(hero.variants.map((v) => v.weight)).toEqual([0.5, 0.5]);
  });
});

describe('client with remote overrides', () => {
  it('uses overrides passed explicitly (SSR path)', () => {
    const client = createClient(config, {
      visitorId: 'v_1',
      transport: { send: () => undefined },
      remote: { overrides: { version: 1, experiments: { hero: { status: 'paused' } } } },
    });
    expect(client.assignment('hero').reason).toBe('not_running');
    expect(client.config.experiments[0]!.status).toBe('paused');
  });
});

describe('helpers', () => {
  it('builds the overrides url from the events endpoint', () => {
    expect(resolveOverridesUrl('https://go.splithub.io/v1/events', 'pk_live_abc')).toBe('https://go.splithub.io/v1/overrides/pk_live_abc.json');
    expect(resolveOverridesUrl('https://staging.example/v1/events/', 'pk')).toBe('https://staging.example/v1/overrides/pk.json');
  });
  it('validates the shape', () => {
    expect(isRemoteOverrides({ version: 1, experiments: {} })).toBe(true);
    expect(isRemoteOverrides({ experiments: {} })).toBe(false);
    expect(isRemoteOverrides(null)).toBe(false);
  });
});
