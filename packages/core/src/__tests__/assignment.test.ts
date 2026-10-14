import { afterEach, describe, expect, it, vi } from 'vitest';
import { assign, isActive, isDevEnvironment, pickVariant } from '../assignment';
import { defineConfig } from '../config';
import { murmur3, hashToUnit } from '../hash';

const config = defineConfig({
  project: 'test',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' } },
  experiments: {
    'hero-cta': { kind: 'component', status: 'running', variants: { control: 50, bold: 50 }, goal: 'signup' },
    'half-traffic': { kind: 'component', status: 'running', traffic: 0.5, variants: { control: 1, b: 1 } },
    paused: { kind: 'component', status: 'paused', variants: { control: 1, b: 1 } },
    skewed: { kind: 'component', status: 'running', variants: { control: 90, b: 10 } },
  },
});

describe('murmur3', () => {
  it('matches reference vectors', () => {
    expect(murmur3('', 0)).toBe(0);
    expect(murmur3('hello', 0)).toBe(0x248bfa47);
    expect(murmur3('hello, world', 0)).toBe(0x149bbb7f);
    expect(murmur3('The quick brown fox jumps over the lazy dog', 0)).toBe(0x2e4ff723);
  });

  it('hashToUnit is in [0, 1)', () => {
    for (let i = 0; i < 1000; i++) {
      const u = hashToUnit(`v_${i}`);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });
});

describe('pickVariant', () => {
  it('is deterministic', () => {
    const exp = config.experiments[0]!;
    for (let i = 0; i < 50; i++) {
      const id = `v_${i}`;
      expect(pickVariant(exp, id)?.key).toBe(pickVariant(exp, id)?.key);
    }
  });

  it('splits roughly by weight', () => {
    const exp = config.experiments.find((e) => e.key === 'skewed')!;
    let b = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) if (pickVariant(exp, `v_${i}`)?.key === 'b') b++;
    expect(b / n).toBeGreaterThan(0.09);
    expect(b / n).toBeLessThan(0.11);
  });

  it('respects traffic share and keeps variant stable when traffic changes', () => {
    const exp = config.experiments.find((e) => e.key === 'half-traffic')!;
    const n = 20000;
    let inside = 0;
    for (let i = 0; i < n; i++) if (pickVariant(exp, `v_${i}`)) inside++;
    expect(inside / n).toBeGreaterThan(0.48);
    expect(inside / n).toBeLessThan(0.52);

    const full = { ...exp, traffic: 1 };
    for (let i = 0; i < 500; i++) {
      const id = `v_${i}`;
      const half = pickVariant(exp, id);
      if (half) expect(pickVariant(full, id)?.key).toBe(half.key);
    }
  });

  it('different experiments assign independently', () => {
    const a = config.experiments[0]!;
    const b = { ...a, key: 'other', seed: 'other' };
    let same = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) if (pickVariant(a, `v_${i}`)?.key === pickVariant(b, `v_${i}`)?.key) same++;
    expect(same / n).toBeGreaterThan(0.45);
    expect(same / n).toBeLessThan(0.55);
  });
});

describe('assign', () => {
  it('returns reasons', () => {
    expect(assign(config, 'nope', 'v_1').reason).toBe('unknown_experiment');
    expect(assign(config, 'paused', 'v_1').reason).toBe('not_running');
    expect(assign(config, 'hero-cta', 'v_1').reason).toBe('assigned');
  });

  it('honours overrides even when paused', () => {
    const a = assign(config, 'paused', 'v_1', { overrides: { paused: 'b' } });
    expect(a.reason).toBe('override');
    expect(a.variant?.key).toBe('b');
  });
});

describe('runDraftsInDev', () => {
  const make = (runDraftsInDev: boolean) =>
    defineConfig({
      project: 'test',
      storage: { mode: 'self', endpoint: '/api/splithub' },
      runDraftsInDev,
      experiments: {
        draft: { kind: 'component', status: 'draft', variants: { control: 1, b: 1 } },
        later: { kind: 'component', status: 'draft', schedule: { startAt: '2999-01-01T00:00:00Z' }, variants: { control: 1, b: 1 } },
        paused: { kind: 'component', status: 'paused', variants: { control: 1, b: 1 } },
      },
    });

  afterEach(() => vi.unstubAllEnvs());

  it('serves drafts in development with reason "dev", schedule included', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const cfg = make(true);
    expect(isDevEnvironment()).toBe(true);
    expect(assign(cfg, 'draft', 'v_1').reason).toBe('dev');
    expect(assign(cfg, 'draft', 'v_1').variant).not.toBeNull();
    expect(assign(cfg, 'later', 'v_1').reason).toBe('dev');
    expect(assign(cfg, 'paused', 'v_1').reason).toBe('not_running');
    expect(isActive(cfg, cfg.experiments[0]!)).toBe(true);
  });

  it('keeps drafts hidden without the option or outside development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(assign(make(false), 'draft', 'v_1').reason).toBe('not_running');
    vi.stubEnv('NODE_ENV', 'production');
    expect(isDevEnvironment()).toBe(false);
    expect(assign(make(true), 'draft', 'v_1').reason).toBe('not_running');
    expect(isActive(make(true), make(true).experiments[0]!)).toBe(false);
  });
});
