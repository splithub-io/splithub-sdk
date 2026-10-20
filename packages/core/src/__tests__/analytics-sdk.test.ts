// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../client';
import { resetAnalyticsClaims } from '../shared';
import { defineConfig } from '../config';
import type { RemoteOverrides } from '../remote';
import type { EngageEvent, EventBatch, IdentifyEvent, PageEvent, SplitHubEvent, TrackEvent } from '../types';

const config = defineConfig({
  project: 'p',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' } },
  experiments: {},
  properties: { site: { goals: ['signup'] } },
});

function collect() {
  const sent: Array<{ batch: EventBatch; beacon: boolean }> = [];
  return {
    sent,
    transport: { send: (batch: EventBatch, o: { beacon: boolean }) => void sent.push({ batch, beacon: o.beacon }) },
    events: (): SplitHubEvent[] => sent.flatMap((s) => s.batch.events),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState({}, '', '/');
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => {
  // Clients a test leaves alive would keep their properties claimed for the next test.
  resetAnalyticsClaims();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('track()', () => {
  it('sends one event row per call with a property (the ingest derives the goal), without warnings, and trims oversized props', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const c = collect();
    const client = createClient(config, { visitorId: 'v1', sessionId: 's1', property: 'site', transport: c.transport });
    client.track('Video Played');
    client.track('signup', { revenue: 9, blob: 'x'.repeat(5000), plan: 'pro' });
    await client.flush();
    const events = c.events();
    expect(events.map((e) => e.type)).toEqual(['event', 'event']);
    expect(events.map((e) => (e as TrackEvent).name)).toEqual(['Video Played', 'signup']);
    expect((events[1] as TrackEvent).props).toEqual({ revenue: 9, plan: 'pro' });
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/declared|goal key/);
    client.destroy();
  });

  it('sends goal rows keyed by the slug without a property, or while the property is paused', async () => {
    const c = collect();
    const client = createClient(config, { visitorId: 'v1', sessionId: 's1', transport: c.transport });
    client.track('Video Played');
    client.track('signup', { revenue: 9 });
    const paused = defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/api/splithub' }, experiments: {}, properties: { site: { status: 'paused' } } });
    const other = createClient(paused, { visitorId: 'v1', sessionId: 's1', property: 'site', transport: c.transport });
    other.track('signup');
    await client.flush();
    await other.flush();
    const events = c.events();
    expect(events.map((e) => e.type)).toEqual(['goal', 'goal', 'goal']);
    expect(events.map((e) => (e as { goal: string }).goal)).toEqual(['video-played', 'signup', 'signup']);
    expect((events[1] as { props?: unknown }).props).toEqual({ revenue: 9 });
    client.destroy();
    other.destroy();
  });

  it('sends the page row alone for a pageview goal with a property, the goal row without one', async () => {
    const withGoal = defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/api/splithub' }, goals: { pricing: { type: 'pageview', path: '/pricing' } }, experiments: {}, properties: { site: {} } });
    history.replaceState({}, '', '/pricing');
    const c = collect();
    const client = createClient(withGoal, { visitorId: 'v1', sessionId: 's1', property: 'site', transport: c.transport, trackNavigation: false });
    client.pageview();
    await client.flush();
    expect(c.events().map((e) => e.type)).toEqual(['page']);
    client.destroy();

    const d = collect();
    const plain = createClient(withGoal, { visitorId: 'v1', sessionId: 's1', transport: d.transport, trackNavigation: false });
    plain.pageview();
    await plain.flush();
    expect(d.events().map((e) => [e.type, (e as { goal?: string }).goal])).toEqual([['goal', 'pricing']]);
    plain.destroy();
  });

  it('uses the key of a declared goal whose event is the name', async () => {
    const c = collect();
    const named = defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/api/splithub' }, goals: { play: { type: 'event', event: 'Video Played' } }, experiments: {} });
    const client = createClient(named, { visitorId: 'v1', sessionId: 's1', transport: c.transport });
    client.track('Video Played');
    await client.flush();
    expect(c.events().filter((e) => e.type === 'goal').map((e) => (e as { goal: string }).goal)).toEqual(['play']);
    client.destroy();
  });
});

describe('navigation', () => {
  it('counts query changes and hash routes as pages', async () => {
    const c = collect();
    const client = createClient(config, { property: 'site', transport: c.transport });
    client.pageview();
    history.pushState({}, '', '/?tab=2');
    await tick();
    location.hash = '#/pricing';
    await tick();
    location.hash = '#/docs?x=1';
    await tick();
    await client.flush();
    const pages = c.events().filter((e): e is PageEvent => e.type === 'page');
    expect(pages.map((p) => p.url)).toEqual(['/', '/?tab=2', '/pricing?tab=2', '/docs?x=1']);
    client.destroy();
    history.replaceState({}, '', '/');
  });

  it('keeps an anchor on a normal path as the same page', async () => {
    history.replaceState({}, '', '/guide');
    const c = collect();
    const client = createClient(config, { property: 'site', transport: c.transport });
    client.pageview();
    location.hash = '#install';
    await tick();
    await client.flush();
    expect(c.events().filter((e) => e.type === 'page')).toHaveLength(1);
    client.destroy();
  });
});

describe('engagement', () => {
  it('sends visible time and scroll for the page left, on route change and on hide', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const c = collect();
    const client = createClient(config, { property: 'site', transport: c.transport });
    client.pageview();
    vi.setSystemTime(1_004_000);
    history.pushState({}, '', '/pricing');
    await tick();
    vi.setSystemTime(1_006_000);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    vi.setSystemTime(1_060_000); // hidden time does not count
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    vi.setSystemTime(1_061_000);
    window.dispatchEvent(new Event('pagehide'));
    await client.flush();

    const events = c.events();
    expect(events.map((e) => e.type)).toEqual(['page', 'engage', 'page', 'engage', 'engage']);
    const engages = events.filter((e): e is EngageEvent => e.type === 'engage');
    expect(engages.map((e) => [e.url, e.ms])).toEqual([['/', 4000], ['/pricing', 2000], ['/pricing', 1000]]);
    expect(engages.every((e) => e.prop === 'site' && e.scroll >= 0 && e.scroll <= 100)).toBe(true);
    // Hiding the page sends at once, by beacon.
    expect(c.sent.some((s) => s.beacon && s.batch.events.some((e) => e.type === 'engage'))).toBe(true);
    client.destroy();
  });

  it('sends no engagement without a property', async () => {
    const c = collect();
    const client = createClient(config, { transport: c.transport });
    client.pageview();
    window.dispatchEvent(new Event('pagehide'));
    await client.flush();
    expect(c.events()).toEqual([]);
    client.destroy();
  });
});

describe('identify', () => {
  it('sends the user once per session and again in the next session', async () => {
    const c = collect();
    const client = createClient(config, { visitorId: 'v1', property: 'site', transport: c.transport });
    client.identify('  user_42 ', { plan: 'pro', seats: 3, nested: { no: true } as unknown as string });
    client.identify('user_42', { plan: 'pro', seats: 3 });
    client.pageview();
    await client.flush();
    const ids = c.events().filter((e): e is IdentifyEvent => e.type === 'identify');
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ uid: 'user_42', traits: { plan: 'pro', seats: 3 }, prop: 'site' });
    expect(localStorage.getItem('sh_uid')).toBe('user_42');
    client.destroy();

    // A new session: the stored id goes out with the first page.
    sessionStorage.clear();
    const next = collect();
    const again = createClient(config, { visitorId: 'v1', property: 'site', transport: next.transport });
    again.pageview();
    await again.flush();
    expect(next.events().map((e) => e.type)).toEqual(['page', 'identify']);
    expect((next.events()[1] as IdentifyEvent).uid).toBe('user_42');

    again.identify(null);
    expect(localStorage.getItem('sh_uid')).toBeNull();
    again.destroy();
  });
});

describe('no automatic events', () => {
  it('sends nothing on link clicks: only what track() is given', async () => {
    const c = collect();
    const client = createClient(config, { property: 'site', transport: c.transport });
    client.pageview();
    const a = document.createElement('a');
    a.href = 'https://elsewhere.example/file.pdf';
    a.addEventListener('click', (e) => e.preventDefault());
    document.body.appendChild(a);
    a.click();
    await client.flush();
    expect(c.events().filter((e) => e.type === 'event')).toEqual([]);
    expect('notFound' in client).toBe(false);
    client.destroy();
  });
});

describe('property id', () => {
  it('trims and lowercases the id', async () => {
    const c = collect();
    const client = createClient(config, { property: ' SITE ', transport: c.transport });
    client.pageview('/x');
    await client.flush();
    expect(c.events().map((e) => (e as PageEvent).prop)).toEqual(['site']);
  });

  it('warns once in development when the property does not exist', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createClient(config, { property: 'sh-typo42', transport: collect().transport });
    createClient(config, { property: 'sh-typo42', transport: collect().transport });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('sh-typo42'))).toHaveLength(1);
  });
});

describe('a property made in the dashboard on a first visit', () => {
  it('keeps the landing page until the late overrides declare the property', async () => {
    let answer!: (body: RemoteOverrides) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (answer = (body) => resolve(new Response(JSON.stringify(body)))))));
    const cloud = defineConfig({ project: 'p', storage: { mode: 'cloud', key: 'pk_live_late' }, experiments: {} });
    const c = collect();
    const client = createClient(cloud, { property: 'sh-abc123', transport: c.transport, remote: { waitMs: 10 } });
    client.pageview();
    client.track('Clicked');
    await client.ready;
    await client.flush();
    expect(c.events()).toEqual([]);

    answer({ version: 1, experiments: {}, addedProperties: [{ key: 'sh-abc123', status: 'running', description: null, goals: [] }] });
    await vi.waitFor(async () => {
      await client.flush();
      expect(c.events().map((e) => e.type)).toEqual(['page', 'event']);
    });
    client.destroy();
  });
});

describe('two clients on one page', () => {
  it('lets only the first collect pageviews of a property; the second still tracks, once', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const self = defineConfig({ project: 'p', storage: { mode: 'self', endpoint: 'https://example.com/api/splithub' }, experiments: {}, properties: { site: {} } });
    const a = collect();
    const b = collect();
    const first = createClient(self, { visitorId: 'v1', sessionId: 's1', property: 'site', transport: a.transport });
    const second = createClient(self, { visitorId: 'v1', sessionId: 's1', property: 'site', transport: b.transport });
    first.pageview();
    second.pageview();
    second.pageview('/other');
    second.track('signup');
    await first.flush();
    await second.flush();
    expect(a.events().map((e) => e.type)).toEqual(['page']);
    expect(b.events().map((e) => e.type)).toEqual(['event']);
    expect(info.mock.calls.filter((c) => String(c[0]).includes('already collects pageviews'))).toHaveLength(1);

    // Once the first is gone, the second takes over.
    first.destroy();
    second.pageview('/after');
    await second.flush();
    expect(b.events().map((e) => e.type)).toEqual(['event', 'page']);
    second.destroy();
  });

  it('keeps clients of different properties or endpoints apart', async () => {
    const two = defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/api/splithub' }, experiments: {}, properties: { site: {}, blog: {} } });
    const a = collect();
    const b = collect();
    const first = createClient(two, { visitorId: 'v1', sessionId: 's1', property: 'site', transport: a.transport });
    const second = createClient(two, { visitorId: 'v1', sessionId: 's1', property: 'blog', transport: b.transport });
    first.pageview();
    second.pageview();
    await first.flush();
    await second.flush();
    expect(a.events().map((e) => e.type)).toEqual(['page']);
    expect(b.events().map((e) => e.type)).toEqual(['page']);
    first.destroy();
    second.destroy();
  });
});
