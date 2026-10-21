// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../client';
import { defineConfig } from '../config';
import { resetAnalyticsClaims } from '../shared';
import { browserContext } from '../targeting';
import type { EventBatch, PageEvent } from '../types';
import { isBrowser } from '../visitor';

const config = defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/api/splithub' }, experiments: {}, properties: { site: {} } });

afterEach(() => {
  resetAnalyticsClaims();
  vi.restoreAllMocks();
});

describe('apps next to the web', () => {
  it('a browser reports platform web', () => {
    expect(browserContext().platform).toBe('web');
    expect(createClient(config, { transport: { send: () => undefined } }).context.platform).toBe('web');
  });

  it('React Native is not a browser even with a document polyfill', () => {
    expect(isBrowser()).toBe(true);
    vi.spyOn(navigator, 'product', 'get').mockReturnValue('ReactNative');
    expect(isBrowser()).toBe(false);
  });

  it('screen() on the web sends a page with that url and the name as title', async () => {
    const batches: EventBatch[] = [];
    const client = createClient(config, { visitorId: 'v', sessionId: 's', property: 'site', transport: { send: (b) => void batches.push(b) } });
    client.screen('Checkout');
    await client.flush();
    const page = batches.flatMap((b) => b.events).find((e): e is PageEvent => e.type === 'page');
    expect(page).toMatchObject({ url: '/Checkout', title: 'Checkout' });
    expect(batches[0]!.app).toBeUndefined();
    client.destroy();
  });

  it('an adapter in a browser bundle still keeps away from the page', async () => {
    const batches: EventBatch[] = [];
    document.cookie = 'sh_vid=; Max-Age=0; Path=/';
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const client = createClient(config, { platform: { storage, app: { platform: 'macos' } }, property: 'site', transport: { send: (b) => void batches.push(b) } });
    expect(document.cookie).not.toMatch(/sh_vid/);
    expect(store.get('sh_vid')).toBe(client.visitorId);
    expect(client.context.platform).toBe('macos');
    client.pageview(); // no automatic pageviews from location
    await client.flush();
    expect(batches).toHaveLength(0);
    client.destroy();
  });
});

describe('remote overrides on the web', () => {
  it('a website without experiments in its config keeps the plain overrides URL and cache key', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: 3, experiments: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    localStorage.clear();
    const cloud = defineConfig({ project: 'p', storage: { mode: 'cloud', key: 'pk_web' }, experiments: {} });
    const client = createClient(cloud, { transport: { send: () => undefined } });
    await client.ready;
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://go.splithub.io/v1/overrides/pk_web.json');
    expect(localStorage.getItem('sh_remote:pk_web')).not.toBeNull();
    expect(localStorage.getItem('sh_remote:pk_web:all')).toBeNull();
    client.destroy();
    vi.unstubAllGlobals();
  });
});
