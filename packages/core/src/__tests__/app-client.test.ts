import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, SESSION_GAP_MS } from '../client';
import { defineConfig } from '../config';
import { EventQueue, QUEUE_STORAGE_KEY } from '../events';
import { memoryStorage, type KeyValueStorage, type PlatformAdapter } from '../platform';
import { REMOTE_CACHE_KEY, type RemoteOverrides } from '../remote';
import { resetAnalyticsClaims } from '../shared';
import type { EngageEvent, EventBatch, Experiment, PageEvent, SplitHubEvent } from '../types';

// No window, no document: what a React Native or desktop app looks like to core.

const config = defineConfig({
  project: 'p',
  storage: { mode: 'self', endpoint: 'https://example.test/api/splithub' },
  goals: { signup: { type: 'event' } },
  experiments: {
    hero: { kind: 'component', status: 'running', variants: { control: 1, bold: 1 }, goal: 'signup' },
    modern: {
      kind: 'component',
      status: 'running',
      variants: { control: 1, b: 1 },
      flow: { start: 'v', nodes: { v: { type: 'condition', conditions: [{ field: 'app_version', op: 'gte', value: '2.10' }], then: 'b', else: 'c' }, b: { type: 'variant', variant: 'b' }, c: { type: 'variant', variant: 'control' } } },
    },
  },
  properties: { app: { kind: 'app' } },
});

function collect() {
  const batches: Array<{ batch: EventBatch; beacon: boolean }> = [];
  return {
    batches,
    transport: { send: (batch: EventBatch, o: { beacon: boolean }) => void batches.push({ batch, beacon: o.beacon }) },
    events: (): SplitHubEvent[] => batches.flatMap((b) => b.batch.events),
  };
}

function lifecycle() {
  const bg = new Set<() => void>();
  const fg = new Set<() => void>();
  return {
    onBackground: (cb: () => void) => (bg.add(cb), () => void bg.delete(cb)),
    onForeground: (cb: () => void) => (fg.add(cb), () => void fg.delete(cb)),
    background: () => bg.forEach((cb) => cb()),
    foreground: () => fg.forEach((cb) => cb()),
    listeners: () => bg.size + fg.size,
  };
}

function adapter(storage: KeyValueStorage = memoryStorage(), extra: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return { storage, app: { platform: 'ios', id: 'com.acme.shop', version: '2.10.1', device: 'mobile' }, ...extra };
}

afterEach(() => {
  resetAnalyticsClaims();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a client with a platform adapter', () => {
  it('keeps the visitor in the app storage, a session per launch, and sends app info with every batch', async () => {
    const storage = memoryStorage();
    const c = collect();
    const first = createClient(config, { platform: adapter(storage), transport: c.transport, sdk: 'react-native/1.0.0' });
    expect(first.visitorId).toMatch(/\S/);
    expect(first.visitorId).not.toBe('server');
    expect(storage.getItem('sh_vid')).toBe(first.visitorId);
    expect(first.context).toMatchObject({ platform: 'ios', os: 'ios', appVersion: '2.10.1', device: 'mobile', visitor: 'new' });
    first.variant('hero');
    await first.flush();
    expect(c.batches[0]!.batch).toMatchObject({ sdk: 'react-native/1.0.0', app: { platform: 'ios', id: 'com.acme.shop', version: '2.10.1' } });
    expect(c.batches[0]!.beacon).toBe(false);
    first.destroy();

    const second = createClient(config, { platform: adapter(storage), transport: c.transport });
    expect(second.visitorId).toBe(first.visitorId);
    expect(second.sessionId).not.toBe(first.sessionId); // a new launch, a new in-memory session
    expect(second.context.visitor).toBe('returning');
    second.destroy();
  });

  it('targets by app version from the adapter, and the adapter context wins over app info', () => {
    const modern = createClient(config, { platform: adapter(), transport: collect().transport });
    expect(modern.assignment('modern').variant?.key).toBe('b');
    const old = createClient(config, { platform: adapter(memoryStorage(), { context: { appVersion: '2.9.4', language: 'de' } }), transport: collect().transport });
    expect(old.context).toMatchObject({ appVersion: '2.9.4', language: 'de', platform: 'ios' });
    expect(old.assignment('modern').variant?.key).toBe('control');
  });

  it('sends exposures once per session', async () => {
    const c = collect();
    const session = memoryStorage();
    const a = createClient(config, { platform: adapter(memoryStorage(), { session }), transport: c.transport });
    a.variant('hero');
    a.variant('hero');
    const b = createClient(config, { platform: adapter(memoryStorage({ sh_vid: a.visitorId }), { session }), transport: c.transport });
    b.variant('hero');
    await a.flush();
    await b.flush();
    expect(c.events().filter((e) => e.type === 'exposure')).toHaveLength(1);
  });

  it('sends pageviews only from screen(): url, title, and the screen as url of later events', async () => {
    const c = collect();
    const client = createClient(config, { platform: adapter(), property: 'app', transport: c.transport });
    client.pageview(); // no page to read in an app
    client.screen('Home');
    client.screen('/product/[id]');
    client.track('signup');
    client.screen('   ');
    await client.flush();
    const pages = c.events().filter((e): e is PageEvent => e.type === 'page');
    expect(pages.map((p) => [p.url, p.title])).toEqual([
      ['/Home', 'Home'],
      ['/product/[id]', '/product/[id]'],
    ]);
    expect(c.events().find((e) => e.type === 'event')).toMatchObject({ name: 'signup', url: '/product/[id]' });
    client.destroy();
  });

  it('closes engagement and flushes on background; a new session after 30 minutes away', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 1, 12) });
    const life = lifecycle();
    const c = collect();
    const client = createClient(config, { platform: adapter(memoryStorage(), life), property: 'app', transport: c.transport });
    expect(life.listeners()).toBe(2);
    client.screen('Home');
    const sid = client.sessionId;
    await vi.advanceTimersByTimeAsync(1000); // the queue's timer sends the page
    vi.setSystemTime(Date.now() + 7000);
    life.background();
    await vi.advanceTimersByTimeAsync(0);
    const engage = c.events().find((e): e is EngageEvent => e.type === 'engage');
    expect(engage).toMatchObject({ url: '/Home', scroll: 0, sid });
    expect(engage!.ms).toBeGreaterThanOrEqual(7000);
    expect(engage!.ms).toBeLessThan(9000);

    // Five minutes away: the same session.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    life.foreground();
    expect(client.sessionId).toBe(sid);

    life.background();
    vi.setSystemTime(Date.now() + SESSION_GAP_MS + 1000);
    life.foreground();
    expect(client.sessionId).not.toBe(sid);
    await client.flush();
    const pages = c.events().filter((e): e is PageEvent => e.type === 'page');
    expect(pages.at(-1)).toMatchObject({ url: '/Home', sid: client.sessionId }); // the new session opens on the screen on show
    client.destroy();
    expect(life.listeners()).toBe(0);
  });

  it('keeps unsent events across launches and never gives up on a network failure', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    let online = false;
    let calls = 0;
    const sent: SplitHubEvent[] = [];
    const transport = {
      send: (b: EventBatch) => {
        calls++;
        if (!online) throw new TypeError('Network request failed');
        sent.push(...b.events);
      },
    };
    const first = createClient(config, { platform: adapter(storage), transport });
    first.track('signup');
    await first.flush();
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBeGreaterThan(5); // more than the web's 5 attempts, still kept
    expect(JSON.parse(storage.getItem(QUEUE_STORAGE_KEY)!)).toHaveLength(1);
    first.destroy();

    // Next launch, online: the saved event goes out first.
    online = true;
    const second = createClient(config, { platform: adapter(storage), transport });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((e) => e.type)).toEqual(['goal']);
    expect(storage.getItem(QUEUE_STORAGE_KEY)).toBeNull();
    second.destroy();
  });

  it('drops events the ingest refuses', async () => {
    const storage = memoryStorage();
    const transport = { send: () => { throw Object.assign(new Error('forbidden'), { status: 403 }); } };
    const client = createClient(config, { platform: adapter(storage), transport, onError: () => undefined });
    client.track('signup');
    await client.flush();
    expect(storage.getItem(QUEUE_STORAGE_KEY)).toBeNull();
    client.destroy();
  });

  it('identifies once per session and again in a new one', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 1, 12) });
    const life = lifecycle();
    const c = collect();
    const storage = memoryStorage();
    const client = createClient(config, { platform: adapter(storage, life), property: 'app', transport: c.transport });
    client.identify('user-1');
    expect(storage.getItem('sh_uid')).toBe('user-1');
    client.screen('Home');
    life.background();
    vi.setSystemTime(Date.now() + SESSION_GAP_MS);
    life.foreground();
    await client.flush();
    expect(c.events().filter((e) => e.type === 'identify').map((e) => e.sid)).toEqual([expect.any(String), client.sessionId]);
    client.destroy();
  });
});

describe('remote overrides on apps', () => {
  const cloud = defineConfig({ project: 'p', storage: { mode: 'cloud', key: 'pk_app' }, experiments: {} });
  const added: Experiment = { key: 'onboarding', kind: 'component', status: 'running', traffic: 1, goal: null, seed: 'onboarding', description: null, match: null, variants: [{ key: 'control', weight: 0.5 }, { key: 'short', weight: 0.5 }] };
  const fresh: RemoteOverrides = { version: 7, experiments: {}, added: [added] };

  it('first launch waits for the overrides and caches them in the app storage', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fresh), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const storage = memoryStorage();
    const client = createClient(cloud, { platform: adapter(storage), transport: collect().transport });
    expect(client.pending).toBe(true);
    await client.ready;
    expect(client.assignment('onboarding').reason).toBe('assigned'); // made in the dashboard, no release
    // No config file on a device: it asks for the experiments pushed from splithub.config.ts too.
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://go.splithub.io/v1/overrides/pk_app.json?all=1');
    expect(JSON.parse(storage.getItem(`${REMOTE_CACHE_KEY}:pk_app:all`)!).overrides.version).toBe(7);
    client.destroy();
  });

  it('a later launch with no network decides at once from the cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed'); }));
    const storage = memoryStorage({ [`${REMOTE_CACHE_KEY}:pk_app:all`]: JSON.stringify({ fetchedAt: Date.now() - 3_600_000, overrides: fresh }) });
    const client = createClient(cloud, { platform: adapter(storage), transport: collect().transport });
    expect(client.pending).toBe(false);
    expect(client.config.experiments.map((e) => e.key)).toEqual(['onboarding']);
    expect(client.assignment('onboarding').variant).not.toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    expect(JSON.parse(storage.getItem(`${REMOTE_CACHE_KEY}:pk_app:all`)!).overrides.version).toBe(7); // a failed refresh keeps the copy
    client.destroy();
  });
});

describe('EventQueue with storage', () => {
  const ev = (i: number): SplitHubEvent => ({ id: `g_${i}`, type: 'goal', goal: 'signup', vid: 'v', sid: 's', ts: i });

  it('keeps at most 1000 events, the newest, and sends them in slices of 500', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const off = new EventQueue({ project: 'p', sdk: 't', maxBatch: 5000, storage, transport: { send: () => { throw new TypeError('offline'); } }, onError: () => undefined });
    for (let i = 0; i < 1200; i++) off.push(ev(i));
    expect(off.size).toBe(1000);
    expect(JSON.parse(storage.getItem(QUEUE_STORAGE_KEY)!)[0].ts).toBe(200);
    off.destroy();

    const sizes: number[] = [];
    const on = new EventQueue({ project: 'p', sdk: 't', storage, app: { platform: 'android' }, transport: { send: (b) => void sizes.push(b.events.length) } });
    await vi.advanceTimersByTimeAsync(10);
    expect(sizes).toEqual([500, 500]);
    expect(storage.getItem(QUEUE_STORAGE_KEY)).toBeNull();
    on.destroy();
  });

  const refusal = (status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(`status ${status}`), { status, ...extra });

  it('gives up on 429 after maxAttempts even with storage, waiting at least Retry-After', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const at: number[] = [];
    const q = new EventQueue({ project: 'p', sdk: 't', storage, maxAttempts: 3, transport: { send: () => { at.push(Date.now()); throw refusal(429, { retryAfter: 120 }); } }, onError: () => undefined });
    q.push(ev(1));
    await q.flush();
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(130_000);
    expect(at).toHaveLength(3);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(120_000);
    expect(q.size).toBe(0);
    expect(storage.getItem(QUEUE_STORAGE_KEY)).toBeNull();
    q.destroy();
  });

  it('waits an hour between tries when the project is over quota or deleted', async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    const q = new EventQueue({ project: 'p', sdk: 't', storage: memoryStorage(), transport: { send: () => { at.push(Date.now()); throw refusal(429, { retryAfter: 60, code: 'quota_exceeded' }); } }, onError: () => undefined });
    q.push(ev(1));
    await q.flush();
    await vi.advanceTimersByTimeAsync(3_599_000);
    expect(at).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(at).toHaveLength(2);
    q.destroy();
  });

  it('still never spends attempts on network failures and 5xx with storage', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const q = new EventQueue({ project: 'p', sdk: 't', storage: memoryStorage(), maxAttempts: 2, transport: { send: () => { calls++; throw calls % 2 ? new TypeError('offline') : refusal(503); } }, onError: () => undefined });
    q.push(ev(1));
    await q.flush();
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBeGreaterThan(4);
    expect(q.size).toBe(1);
    q.destroy();
  });

  it('reads Retry-After and the 429 code from the response', async () => {
    const { createFetchTransport } = await import('../events');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'over', code: 'quota_exceeded' }), { status: 429, headers: { 'retry-after': '60' } })));
    const error = await Promise.resolve(createFetchTransport({ endpoint: 'https://x.test/v1/events', keepalive: false }).send({ project: 'p', sdk: 't', events: [] }, { beacon: false })).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 429, retryAfter: 60, code: 'quota_exceeded' });
  });

  it('sends saved events once when two queues share a storage (StrictMode) and keeps both queues in it', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage({ [QUEUE_STORAGE_KEY]: JSON.stringify([ev(1), ev(2)]) });
    const sent: SplitHubEvent[] = [];
    const transport = { send: (b: EventBatch) => void sent.push(...b.events) };
    // StrictMode builds the client twice; the first may be thrown away without destroy().
    const a = new EventQueue({ project: 'p', sdk: 't', storage, transport });
    const b = new EventQueue({ project: 'p', sdk: 't', storage, transport });
    await vi.advanceTimersByTimeAsync(10);
    expect(sent.map((e) => e.ts).sort()).toEqual([1, 2]);
    // Each queue's unsent events are in sh_queue, neither overwrites the other.
    const offline = new EventQueue({ project: 'p', sdk: 't', storage, transport: { send: () => { throw new TypeError('offline'); } }, onError: () => undefined });
    a.destroy();
    b.destroy();
    offline.push(ev(3));
    const other = new EventQueue({ project: 'p', sdk: 't', storage, maxBatch: 100, flushInterval: 60_000, transport: { send: () => { throw new TypeError('offline'); } }, onError: () => undefined });
    other.push(ev(4));
    expect(JSON.parse(storage.getItem(QUEUE_STORAGE_KEY)!).map((e: SplitHubEvent) => e.ts).sort()).toEqual([3, 4]);
    offline.destroy();
    other.destroy();
  });

  it('lets a new queue adopt what a destroyed one on the same storage left', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const first = new EventQueue({ project: 'p', sdk: 't', storage, flushInterval: 60_000, transport: { send: () => undefined } });
    first.push(ev(1));
    first.destroy(); // StrictMode cleanup: its timer is gone
    const sent: SplitHubEvent[] = [];
    const second = new EventQueue({ project: 'p', sdk: 't', storage, transport: { send: (b) => void sent.push(...b.events) } });
    await vi.advanceTimersByTimeAsync(10);
    expect(sent.map((e) => e.ts)).toEqual([1]);
    expect(first.size).toBe(0);
    expect(storage.getItem(QUEUE_STORAGE_KEY)).toBeNull();
    second.destroy();
  });

  it('keeps a batch on its way in storage until it arrives', async () => {
    const storage = memoryStorage();
    let release: () => void = () => undefined;
    const q = new EventQueue({ project: 'p', sdk: 't', storage, transport: { send: () => new Promise<void>((r) => (release = r)) } });
    q.push(ev(1));
    const flushing = q.flush();
    expect(JSON.parse(storage.getItem(QUEUE_STORAGE_KEY)!)).toHaveLength(1);
    release();
    await flushing;
    expect(storage.getItem(QUEUE_STORAGE_KEY)).toBeNull();
    q.destroy();
  });
});
