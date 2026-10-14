import { applyRemoteOverrides } from '@splithub/core';
import { describe, expect, it } from 'vitest';
import { decideRedirect, matchPath, siteConfig } from '../index';

const base = siteConfig('pk_test');
const config = applyRemoteOverrides(base, {
  version: 3,
  experiments: {},
  added: [
    {
      key: 'home',
      kind: 'redirect',
      status: 'running',
      traffic: 1,
      goal: 'signup',
      seed: 'home',
      description: null,
      match: '/',
      variants: [
        { key: 'control', weight: 0.5, to: '/' },
        { key: 'v2', weight: 0.5, to: '/home-v2' },
      ],
      flow: {
        start: 'c',
        nodes: {
          c: { type: 'condition', conditions: [{ field: 'country', op: 'is', value: 'de' }], then: 'v2', else: 'control' },
          v2: { type: 'variant', variant: 'v2' },
          control: { type: 'variant', variant: 'control' },
        },
      },
    },
    { key: 'paused', kind: 'redirect', status: 'paused', traffic: 1, goal: null, seed: 'p', description: null, match: '/pricing', variants: [{ key: 'control', weight: 0.5, to: '/pricing' }, { key: 'b', weight: 0.5, to: '/pricing-b' }] },
  ],
  goals: [{ key: 'signup', type: 'pageview', path: '/thanks', revenue: false, description: null }],
});

describe('drop-in script decisions', () => {
  it('merges hosted experiments and goals from the overrides JSON', () => {
    expect(config.experiments.map((e) => e.key)).toEqual(['home', 'paused']);
    expect(config.goals.map((g) => g.key)).toEqual(['signup']);
  });

  it('matches paths like the middleware', () => {
    expect(matchPath('/', '/')).toBe(true);
    expect(matchPath('/pricing', '/pricing/')).toBe(true);
    expect(matchPath('/docs/*', '/docs/a/b')).toBe(true);
    expect(matchPath('/docs', '/docs/a')).toBe(false);
    expect(matchPath('/pricing/', '/pricing')).toBe(true);
  });

  it('redirects by targeting, stays on control, ignores paused experiments', () => {
    expect(decideRedirect(config, '/', 'v1', { country: 'DE' })).toEqual({ experiment: 'home', variant: 'v2', to: '/home-v2', reason: 'assigned' });
    expect(decideRedirect(config, '/', 'v1', { country: 'US' })).toEqual({ experiment: 'home', variant: 'control', to: null, reason: 'assigned' });
    expect(decideRedirect(config, '/home-v2', 'v1', { country: 'DE' })).toBeNull(); // destination page is not the match
    expect(decideRedirect(config, '/pricing', 'v1', {})).toBeNull();
    expect(decideRedirect(config, '/', 'v1', { country: 'US' }, { home: 'v2' })).toEqual({ experiment: 'home', variant: 'v2', to: '/home-v2', reason: 'override' });
    expect(decideRedirect(config, '/', 'v1', { country: 'DE', device: 'bot' })).toBeNull();
  });
});

describe('layers and holdout in sh.js', () => {
  it('decides like the SDK: the layer and the holdout come from the overrides', async () => {
    const { assign, holdoutGroup } = await import('@splithub/core');
    const hosted = applyRemoteOverrides(base, {
      version: 1,
      experiments: {},
      holdout: { percent: 20, seed: '__holdout', goal: null },
      layers: { l: { seed: 'l' } },
      added: [
        { key: 'a', kind: 'redirect', status: 'running', traffic: 1, goal: null, seed: 'a', description: null, match: '/', layer: { key: 'l', range: [0, 50] }, variants: [{ key: 'control', weight: 0.5, to: '/' }, { key: 'b', weight: 0.5, to: '/b' }] },
        { key: 'c', kind: 'redirect', status: 'running', traffic: 1, goal: null, seed: 'c', description: null, match: '/', layer: { key: 'l', range: [50, 100] }, variants: [{ key: 'control', weight: 0.5, to: '/' }, { key: 'd', weight: 0.5, to: '/d' }] },
      ],
    });
    for (let i = 0; i < 300; i++) {
      const vid = `v_${i}`;
      const d = decideRedirect(hosted, '/', vid);
      if (holdoutGroup(hosted, vid) === 'holdout') {
        expect(d).toBeNull();
        continue;
      }
      const a = assign(hosted, 'a', vid);
      const c = assign(hosted, 'c', vid);
      const owner = a.reason === 'assigned' ? a : c;
      expect([a.reason, c.reason].sort()).toEqual(['assigned', 'layer']);
      expect(d?.experiment).toBe(owner.experiment);
      expect(d?.variant).toBe(owner.variant?.key);
    }
  });
});
