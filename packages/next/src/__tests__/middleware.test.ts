import { defineConfig } from '@splithub/core';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchPath, splithubMiddleware, VISITOR_HEADER } from '../middleware';
import { clearRemoteMemo } from '../remote';

const config = defineConfig({
  project: 'p',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' } },
  experiments: {
    landing: {
      kind: 'redirect',
      status: 'running',
      match: '/',
      variants: { control: { weight: 1, to: '/' }, v2: { weight: 1, to: '/home-v2' } },
      goal: 'signup',
    },
    paused: {
      kind: 'redirect',
      status: 'paused',
      match: '/pricing',
      variants: { control: { weight: 1, to: '/pricing' }, b: { weight: 1, to: '/pricing-b' } },
    },
  },
});

function fakeEvent() {
  const waits: Promise<unknown>[] = [];
  return { waits, event: { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as never };
}

describe('runDraftsInDev', () => {
  const draftInput = {
    project: 'p',
    storage: { mode: 'self' as const, endpoint: '/api/splithub' },
    runDraftsInDev: true,
    experiments: {
      landing: {
        kind: 'redirect' as const,
        status: 'draft' as const,
        match: '/',
        variants: { control: { weight: 0, to: '/' }, v2: { weight: 1, to: '/home-v2' } },
      },
    },
  };
  const draftConfig = defineConfig(draftInput);
  afterEach(() => vi.unstubAllEnvs());

  it('rewrites to a draft variant in development only', async () => {
    const mw = splithubMiddleware(draftConfig, { trackRedirects: false });
    vi.stubEnv('NODE_ENV', 'development');
    expect((await mw(new NextRequest('http://localhost/'))).headers.get('x-middleware-rewrite')).toContain('/home-v2');
    vi.stubEnv('NODE_ENV', 'production');
    expect((await mw(new NextRequest('http://localhost/'))).headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('records a dev draft only for a self-hosted store', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const { waits, event } = fakeEvent();
    await splithubMiddleware(draftConfig)(new NextRequest('http://localhost/'), event);
    await Promise.all(waits);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const cloud = defineConfig({ ...draftInput, storage: { mode: 'cloud', key: 'pk_live_x' } });
    await splithubMiddleware(cloud, { remote: false })(new NextRequest('http://localhost/'), event);
    await Promise.all(waits);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('matchPath', () => {
  it('exact and prefix', () => {
    expect(matchPath('/', '/')).toBe(true);
    expect(matchPath('/pricing', '/pricing/')).toBe(true);
    expect(matchPath('/pricing', '/pricing/x')).toBe(false);
    expect(matchPath('/blog/*', '/blog/post-1')).toBe(true);
  });
});

describe('splithubMiddleware', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    fetchMock.mockClear();
    vi.unstubAllGlobals();
  });

  it('sets the visitor cookie and forwards the header', async () => {
    const mw = splithubMiddleware(config);
    const res = await mw(new NextRequest('http://localhost/about'));
    const cookie = res.cookies.get('sh_vid');
    expect(cookie?.value).toMatch(/^v_/);
    expect(res.headers.get('x-middleware-request-' + VISITOR_HEADER)).toBe(cookie?.value);
  });

  it('keeps an existing visitor id', async () => {
    const mw = splithubMiddleware(config);
    const req = new NextRequest('http://localhost/about', { headers: { cookie: 'sh_vid=v_fixed' } });
    const res = await mw(req);
    expect(res.cookies.get('sh_vid')).toBeUndefined();
    expect(res.headers.get('x-middleware-request-' + VISITOR_HEADER)).toBe('v_fixed');
  });

  it('rewrites redirect experiments invisibly and records one exposure', async () => {
    const mw = splithubMiddleware(config);
    // find a visitor that lands in v2
    let vid = '';
    for (let i = 0; i < 100; i++) {
      const candidate = `v_${i}`;
      const probe = await mw(new NextRequest('http://localhost/', { headers: { cookie: `sh_vid=${candidate}` } }));
      if (probe.headers.get('x-middleware-rewrite')) {
        vid = candidate;
        break;
      }
    }
    expect(vid).not.toBe('');
    fetchMock.mockClear(); // the probe above already fired one exposure
    const { event, waits } = fakeEvent();
    const res = await mw(new NextRequest('http://localhost/?utm=1', { headers: { cookie: `sh_vid=${vid}` } }), event);
    expect(res.headers.get('x-middleware-rewrite')).toBe('http://localhost/home-v2?utm=1');
    expect(res.cookies.get('sh_x_landing')?.value).toBe('v2');
    expect(waits).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body) as { events: Array<{ exp: string; var: string }> };
    expect(body.events[0]).toMatchObject({ exp: 'landing', var: 'v2' });

    // second request with the exposure cookie: no new event
    const again = await mw(new NextRequest('http://localhost/', { headers: { cookie: `sh_vid=${vid}; sh_x_landing=v2` } }), event);
    expect(again.headers.get('x-middleware-rewrite')).toBe('http://localhost/home-v2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores paused experiments, excluded paths and honours ?sh_force', async () => {
    const mw = splithubMiddleware(config);
    expect((await mw(new NextRequest('http://localhost/pricing'))).headers.get('x-middleware-rewrite')).toBeNull();
    expect((await mw(new NextRequest('http://localhost/_next/static/x.js'))).cookies.get('sh_vid')).toBeUndefined();
    const forced = await mw(new NextRequest('http://localhost/?sh_force=landing:v2', { headers: { cookie: 'sh_vid=v_any' } }));
    expect(forced.headers.get('x-middleware-rewrite')).toContain('/home-v2');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies live overrides from the cloud (paused redirect stops rewriting)', async () => {
    clearRemoteMemo();
    const cloud = defineConfig({
      project: 'p',
      storage: { mode: 'cloud', key: 'pk_live_test', endpoint: 'https://cloud.test/v1/events' },
      experiments: {
        landing: { kind: 'redirect', status: 'running', match: '/', variants: { control: { weight: 0, to: '/' }, v2: { weight: 1, to: '/home-v2' } } },
      },
    });
    const calls: string[] = [];
    const remoteFetch = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ version: 1, experiments: { landing: { status: 'paused' } } }), { status: 200 });
    });
    vi.stubGlobal('fetch', remoteFetch);
    const mw = splithubMiddleware(cloud);
    const res = await mw(new NextRequest('http://localhost/', { headers: { cookie: 'sh_vid=v_1' } }));
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(calls[0]).toBe('https://cloud.test/v1/overrides/pk_live_test.json');
    // memoized: a second request does not refetch
    await mw(new NextRequest('http://localhost/', { headers: { cookie: 'sh_vid=v_2' } }));
    expect(remoteFetch).toHaveBeenCalledTimes(1);
    // opt-out keeps the file config
    const plain = splithubMiddleware(cloud, { remote: false, trackRedirects: false });
    expect((await plain(new NextRequest('http://localhost/', { headers: { cookie: 'sh_vid=v_1' } }))).headers.get('x-middleware-rewrite')).toContain('/home-v2');
  });

  it('serves bots the control without an exposure, forwards the visitor UA', async () => {
    const mw = splithubMiddleware(config);
    const bot = await mw(new NextRequest('http://localhost/?sh_debug=0', { headers: { cookie: 'sh_vid=v_any', 'user-agent': 'Googlebot/2.1' } }));
    expect(bot.headers.get('x-middleware-rewrite')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const { event, waits } = fakeEvent();
    await mw(new NextRequest('http://localhost/', { headers: { cookie: 'sh_vid=v_any', 'user-agent': 'Mozilla/5.0 Chrome/120' } }), event);
    await Promise.all(waits);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1];
    expect(init.headers['user-agent']).toBe('Mozilla/5.0 Chrome/120');
    expect(init.headers['x-splithub-ua']).toBe('Mozilla/5.0 Chrome/120');
  });

  it('merges the variant query and ignores a trailing slash', async () => {
    const withQuery = defineConfig({
      project: 'p',
      storage: { mode: 'self', endpoint: '/api/splithub' },
      experiments: { pricing: { kind: 'redirect', status: 'running', match: '/pricing', variants: { control: { weight: 0, to: '/pricing' }, b: { weight: 1, to: '/pricing-b?plan=b' } } } },
    });
    const res = await splithubMiddleware(withQuery, { trackRedirects: false })(new NextRequest('http://localhost/pricing/?utm_source=x', { headers: { cookie: 'sh_vid=v_1' } }));
    // Next keeps the request's trailing-slash style on its own URL.
    expect(res.headers.get('x-middleware-rewrite')).toMatch(/^http:\/\/localhost\/pricing-b\/?\?plan=b&utm_source=x$/);
  });
});

describe('holdout marker', () => {
  const held = defineConfig({
    project: 'p',
    storage: { mode: 'self', endpoint: '/api/splithub' },
    goals: { signup: { type: 'event' } },
    holdout: { percent: 20 },
    experiments: {
      landing: { kind: 'redirect', status: 'running', match: '/', variants: { control: { weight: 1, to: '/' }, v2: { weight: 1, to: '/home-v2' } }, goal: 'signup' },
    },
  });
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 202 }));
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    fetchMock.mockClear();
    vi.unstubAllGlobals();
  });

  it('sends __holdout with the same group as the SDK, and no exposure for held-out visitors', async () => {
    const { holdoutGroup, HOLDOUT_KEY } = await import('@splithub/core');
    for (const group of ['holdout', 'enrolled'] as const) {
      const vid = Array.from({ length: 300 }, (_, i) => `v_${i}`).find((v) => holdoutGroup(held, v) === group)!;
      const { waits, event } = fakeEvent();
      const res = await splithubMiddleware(held, { remote: false })(new NextRequest('http://localhost/', { headers: { cookie: `sh_vid=${vid}` } }), event);
      await Promise.all(waits);
      const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body)) as { events: Array<{ exp: string; var: string }> };
      const marker = body.events.find((e) => e.exp === HOLDOUT_KEY);
      expect(marker?.var).toBe(group);
      expect(body.events.some((e) => e.exp === 'landing')).toBe(group === 'enrolled');
      if (group === 'holdout') expect(res.headers.get('x-middleware-rewrite')).toBeNull();
      expect(res.cookies.get(`sh_x_${HOLDOUT_KEY}`)?.value).toBe(group);
      // Once the cookie is set, the marker is not sent again.
      fetchMock.mockClear();
      const again = await splithubMiddleware(held, { remote: false })(new NextRequest('http://localhost/', { headers: { cookie: `sh_vid=${vid}; sh_x_${HOLDOUT_KEY}=${group}; sh_x_landing=${res.cookies.get('sh_x_landing')?.value ?? ''}` } }), event);
      await Promise.all(waits);
      expect(again.cookies.get(`sh_x_${HOLDOUT_KEY}`)).toBeUndefined();
      const sent = fetchMock.mock.calls.flatMap((c) => (JSON.parse(String(c[1].body)) as { events: Array<{ exp: string }> }).events);
      expect(sent.some((e) => e.exp === HOLDOUT_KEY)).toBe(false);
    }
  });
});
