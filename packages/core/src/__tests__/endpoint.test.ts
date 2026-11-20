import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_ENDPOINT,
  CLOUD_FALLBACK_ENDPOINTS,
  cloudEndpoints,
  ENDPOINT_KEY,
  fetchCloudOverrides,
  isCloudEndpoint,
  normalizeCloudEndpoint,
  rememberedEndpoint,
} from '../endpoint';
import { createFetchTransport } from '../events';
import { memoryStorage } from '../platform';
import { defineConfig } from '../config';

const BACKUP = CLOUD_FALLBACK_ENDPOINTS[0]!;
const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('cloud endpoint', () => {
  it('reads a bare domain or an origin as the events URL', () => {
    expect(normalizeCloudEndpoint('go.sh2.uk')).toBe('https://go.sh2.uk/v1/events');
    expect(normalizeCloudEndpoint('https://events.example.com/')).toBe('https://events.example.com/v1/events');
    expect(normalizeCloudEndpoint('https://example.com/proxy/v1/events')).toBe('https://example.com/proxy/v1/events');
    const config = defineConfig({ project: 'p', storage: { mode: 'cloud', key: 'pk_x', endpoint: 'go-staging.sh2.uk' }, experiments: {} });
    expect(config.storage).toMatchObject({ endpoint: 'https://go-staging.sh2.uk/v1/events' });
  });

  it('knows the default, the backup and the lapsed address as the cloud', () => {
    expect(isCloudEndpoint(undefined)).toBe(true);
    expect(isCloudEndpoint(CLOUD_ENDPOINT)).toBe(true);
    expect(isCloudEndpoint('https://go.splithub.io/v1/events')).toBe(true);
    expect(isCloudEndpoint('https://example.com/v1/events')).toBe(false);
  });

  it('tries the announced address first, skips the lapsed one, ends with the backup', () => {
    const store = memoryStorage({ [ENDPOINT_KEY]: 'https://go.new.example/v1/events' });
    expect(cloudEndpoints(store, 'https://go.splithub.io/v1/events')).toEqual(['https://go.new.example/v1/events', CLOUD_ENDPOINT, BACKUP]);
    expect(cloudEndpoints(memoryStorage({ [ENDPOINT_KEY]: 'http://insecure/v1/events' }))).toEqual([CLOUD_ENDPOINT, BACKUP]);
  });

  it('moves events to the next address on a network failure and remembers it', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url === CLOUD_ENDPOINT) throw new TypeError('getaddrinfo ENOTFOUND');
      return ok();
    }));
    const switched = vi.fn();
    const t = createFetchTransport({ endpoint: CLOUD_ENDPOINT, key: 'pk_x', fallbacks: [BACKUP], onEndpoint: switched, keepalive: false });
    await t.send({ project: 'p', sdk: 't', events: [] }, { beacon: false });
    await t.send({ project: 'p', sdk: 't', events: [] }, { beacon: false });
    expect(calls).toEqual([CLOUD_ENDPOINT, BACKUP, BACKUP]);
    expect(switched).toHaveBeenCalledOnce();
    expect(switched).toHaveBeenCalledWith(BACKUP);
  });

  it('keeps the address on an error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const t = createFetchTransport({ endpoint: CLOUD_ENDPOINT, fallbacks: [BACKUP], keepalive: false });
    await expect(t.send({ project: 'p', sdk: 't', events: [] }, { beacon: false })).rejects.toMatchObject({ status: 500 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('learns the announced address from the overrides fetched through the backup', async () => {
    const store = memoryStorage();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith(CLOUD_ENDPOINT.replace('/events', ''))) throw new TypeError('offline');
      return ok({ version: 1, experiments: {}, endpoint: 'https://go.moved.example/v1/events' });
    }) as unknown as typeof fetch;
    const overrides = await fetchCloudOverrides(undefined, 'pk_x', { store, fetchImpl });
    expect(overrides?.version).toBe(1);
    expect(rememberedEndpoint(store)).toBe('https://go.moved.example/v1/events');
    expect(cloudEndpoints(store)[0]).toBe('https://go.moved.example/v1/events');
  });

  it('asks a custom endpoint once and remembers nothing', async () => {
    const store = memoryStorage();
    const fetchImpl = vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    expect(await fetchCloudOverrides('https://mine.example/v1/events', 'pk_x', { store, fetchImpl })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(rememberedEndpoint(store)).toBeNull();
  });
});
