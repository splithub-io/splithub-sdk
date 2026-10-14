import { describe, expect, it } from 'vitest';
import { assign } from '../assignment';
import { defineConfig } from '../config';
import { contextValue, evaluateCondition, parseUserAgent, runFlow, validateFlow } from '../targeting';
import type { Flow, TargetingContext } from '../types';

const flow: Flow = {
  start: 'geo',
  nodes: {
    geo: { type: 'condition', conditions: [{ field: 'country', op: 'in', value: 'DE, AT, CH' }], match: 'all', then: 'mobile', else: 'skip' },
    mobile: { type: 'condition', conditions: [{ field: 'device', op: 'is', value: 'mobile' }], then: 'split', else: 'control' },
    split: { type: 'split', outputs: [{ weight: 50, to: 'control' }, { weight: 50, to: 'bold' }] },
    control: { type: 'variant', variant: 'control' },
    bold: { type: 'variant', variant: 'bold' },
    skip: { type: 'skip' },
  },
};

const config = defineConfig({
  project: 'demo',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  experiments: {
    hero: { kind: 'component', status: 'running', variants: { control: 1, bold: 1 }, flow },
    plain: { kind: 'component', status: 'running', variants: { control: 1, bold: 1 } },
  },
});
const hero = config.experiments[0]!;

describe('conditions', () => {
  it('reads context fields case-insensitively', () => {
    const ctx: TargetingContext = { country: 'DE', url: 'https://x.test/pricing?utm_source=Google&ref=a+b', cookies: { plan: 'Pro' }, language: 'de-DE,de;q=0.9', now: Date.UTC(2026, 9, 12, 15) };
    expect(contextValue('country', undefined, ctx)).toBe('de');
    expect(contextValue('path', undefined, ctx)).toBe('/pricing');
    expect(contextValue('utm_source', undefined, ctx)).toBe('google');
    expect(contextValue('query', 'ref', ctx)).toBe('a b');
    expect(contextValue('cookie', 'plan', ctx)).toBe('pro');
    expect(contextValue('language', undefined, ctx)).toBe('de');
    expect(contextValue('hour', undefined, ctx)).toBe('15');
    expect(contextValue('weekday', undefined, ctx)).toBe('mon');
    expect(contextValue('device', undefined, ctx)).toBeUndefined();
  });

  it('applies every operator', () => {
    const ctx: TargetingContext = { referrer: 'https://news.ycombinator.com/item?id=1', country: 'US' };
    expect(evaluateCondition({ field: 'country', op: 'is', value: 'us' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'country', op: 'is_not', value: 'us' }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'referrer', op: 'contains', value: 'ycombinator' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'referrer', op: 'not_contains', value: 'google' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'referrer', op: 'starts_with', value: 'https://news' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'country', op: 'in', value: 'ca,us' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'country', op: 'not_in', value: 'ca,us' }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'referrer', op: 'matches', value: '^https://news\\.' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'referrer', op: 'matches', value: '(' }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'device', op: 'exists' }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'device', op: 'not_exists' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'device', op: 'is_not', value: 'mobile' }, ctx)).toBe(true); // unknown ≠ mobile
  });
});

describe('flow', () => {
  it('walks conditions and splits deterministically', () => {
    expect(runFlow(hero, flow, 'v1', { country: 'FR' })).toMatchObject({ variant: null, reason: 'skip', path: ['geo', 'skip'] });
    expect(runFlow(hero, flow, 'v1', { country: 'DE', device: 'desktop' })).toMatchObject({ variant: { key: 'control' }, path: ['geo', 'mobile', 'control'] });
    const counts = { control: 0, bold: 0 };
    for (let i = 0; i < 2000; i++) {
      const r = runFlow(hero, flow, `v${i}`, { country: 'de', device: 'mobile' });
      counts[r.variant!.key as 'control' | 'bold']++;
      expect(runFlow(hero, flow, `v${i}`, { country: 'at', device: 'mobile' }).variant!.key).toBe(r.variant!.key); // stable per visitor
    }
    expect(counts.control).toBeGreaterThan(850);
    expect(counts.bold).toBeGreaterThan(850);
  });

  it('is used by assign() with a context, and ignored without a flow', () => {
    expect(assign(config, 'hero', 'v9', { context: { country: 'JP' } })).toMatchObject({ variant: null, reason: 'targeting' });
    expect(assign(config, 'hero', 'v9', { context: { country: 'CH', device: 'tablet' } })).toMatchObject({ variant: { key: 'control' }, reason: 'assigned' });
    expect(assign(config, 'hero', 'v9')).toMatchObject({ variant: null, reason: 'targeting' }); // no context → no country → skip
    expect(assign(config, 'plain', 'v9').reason).toBe('assigned');
    expect(assign(config, 'hero', 'v9', { overrides: { hero: 'bold' }, context: { country: 'JP' } })).toMatchObject({ variant: { key: 'bold' }, reason: 'override' });
  });

  it('guards against bad graphs', () => {
    const keys = ['control', 'bold'];
    expect(validateFlow(flow, keys)).toBeNull();
    expect(validateFlow({ start: 'x', nodes: {} }, keys)).toMatch(/no nodes/);
    expect(validateFlow({ start: 'x', nodes: { a: { type: 'skip' } } }, keys)).toMatch(/start node/);
    expect(validateFlow({ start: 'a', nodes: { a: { type: 'variant', variant: 'nope' } } }, keys)).toMatch(/unknown variant/);
    expect(validateFlow({ start: 'a', nodes: { a: { type: 'condition', conditions: [{ field: 'country', op: 'is', value: 'x' }], then: 'zz' } } }, keys)).toMatch(/unknown node/);
    expect(validateFlow({ start: 'a', nodes: { a: { type: 'condition', conditions: [{ field: 'query', op: 'is', value: 'x' }], then: 'a' } } }, keys)).toMatch(/needs a name/);
    expect(validateFlow({ start: 'a', nodes: { a: { type: 'split', outputs: [{ weight: 0, to: 'a' }] } } }, keys)).toMatch(/weight > 0/);
    // cycles terminate
    const loop: Flow = { start: 'a', nodes: { a: { type: 'condition', conditions: [], then: 'a' } } };
    expect(runFlow(hero, loop, 'v', {})).toMatchObject({ variant: null, reason: 'dead_end' });
    expect(() => defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/x' }, experiments: { e: { kind: 'component', status: 'draft', variants: { control: 1, b: 1 }, flow: { start: 'q', nodes: {} } } } })).toThrow(/flow/);
  });
});

describe('user agent', () => {
  it('classifies common agents', () => {
    expect(parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toEqual({ device: 'mobile', browser: 'safari', os: 'ios' });
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')).toEqual({ device: 'desktop', browser: 'chrome', os: 'windows' });
    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120.0 Safari/537.36')).toEqual({ device: 'tablet', browser: 'chrome', os: 'android' });
    expect(parseUserAgent('Googlebot/2.1 (+http://www.google.com/bot.html)').device).toBe('bot');
  });
});

describe('click goals', () => {
  it('normalizes the selector and binds nothing outside a browser', async () => {
    const { createClient } = await import('../client');
    const cfg = defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/x' }, goals: { buy: { type: 'click', selector: '#buy' }, thanks: { type: 'pageview', path: '/thanks' } }, experiments: {} });
    expect(cfg.goals.find((g) => g.key === 'buy')).toMatchObject({ type: 'click', selector: '#buy', path: null });
    expect(cfg.goals.find((g) => g.key === 'thanks')).toMatchObject({ type: 'pageview', selector: null });
    const client = createClient(cfg, { visitorId: 'v', transport: { send: async () => undefined } });
    expect(typeof client.autoGoals()).toBe('function');
  });
});


describe('limits', () => {
  it('respects the run window and validates caps', () => {
    const cfg = defineConfig({
      project: 'p',
      storage: { mode: 'self', endpoint: '/x' },
      experiments: { win: { kind: 'component', status: 'running', variants: { control: 1, b: 1 }, schedule: { startAt: '2026-10-20T00:00:00Z', endAt: '2026-10-30T00:00:00Z' }, maxExposures: 5000, traffic: 0.5 } },
    });
    expect(cfg.experiments[0]).toMatchObject({ maxExposures: 5000, traffic: 0.5, schedule: { startAt: '2026-10-20T00:00:00Z', endAt: '2026-10-30T00:00:00Z' } });
    expect(assign(cfg, 'win', 'v1', { context: { now: Date.UTC(2026, 9, 10) } }).reason).toBe('not_running');
    expect(assign(cfg, 'win', 'v1', { context: { now: Date.UTC(2026, 10, 5) } }).reason).toBe('not_running');
    const inside = assign(cfg, 'win', 'v1', { context: { now: Date.UTC(2026, 9, 25) } });
    expect(['assigned', 'outside_traffic']).toContain(inside.reason);
    expect(() => defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/x' }, experiments: { e: { kind: 'component', status: 'draft', variants: { control: 1, b: 1 }, maxExposures: 0 } } })).toThrow(/maxExposures/);
    expect(() => defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/x' }, experiments: { e: { kind: 'component', status: 'draft', variants: { control: 1, b: 1 }, schedule: { startAt: 'soon' } } } })).toThrow(/schedule/);
    const withMin = (minDays: number) => defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/x' }, experiments: { e: { kind: 'component', status: 'draft', variants: { control: 1, b: 1 }, minDays } } });
    expect(withMin(0).experiments[0]!.minDays).toBe(0);
    expect(withMin(30).experiments[0]!.minDays).toBe(30);
    for (const bad of [-1, 31, 1.5, Number.NaN]) expect(() => withMin(bad)).toThrow(/minDays/);
    const withGood = (goodSample: number) => defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/x' }, experiments: { e: { kind: 'component', status: 'draft', variants: { control: 1, b: 1 }, goodSample } } });
    expect(withGood(100).experiments[0]!.goodSample).toBe(100);
    expect(withGood(10_000_000).experiments[0]!.goodSample).toBe(10_000_000);
    expect(withMin(1).experiments[0]!.goodSample).toBeUndefined();
    for (const bad of [99, 10_000_001, 250.5, Number.NaN]) expect(() => withGood(bad)).toThrow(/goodSample/);
  });
});
