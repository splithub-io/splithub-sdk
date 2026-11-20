import { CLOUD_ENDPOINT, CLOUD_FALLBACK_ENDPOINTS } from '@splithub/core';
import { describe, expect, it, vi } from 'vitest';
import { createCloudProxy } from '../proxy';

const CLOUD = CLOUD_ENDPOINT.replace('/v1/events', '');
const BACKUP = CLOUD_FALLBACK_ENDPOINTS[0]!.replace('/v1/events', '');

describe('createCloudProxy', () => {
  it('forwards an event batch from any mount path with the visitor in headers', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"ok":true}', { status: 202, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } }));
    const proxy = createCloudProxy({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const req = new Request('https://shop.example/sh/v1/events?key=pk_live_1', {
      method: 'POST',
      body: '{"events":[]}',
      headers: { 'user-agent': 'Mozilla/5.0 Safari', origin: 'https://shop.example', cookie: 'session=secret', 'x-vercel-ip-country': 'DE', 'x-vercel-ip-city': 'M%C3%BCnchen', 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
    });
    const res = await proxy(req);
    expect(res.status).toBe(202);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${CLOUD}/v1/events?key=pk_live_1`);
    const h = init!.headers as Headers;
    expect(h.get('x-splithub-ua')).toBe('Mozilla/5.0 Safari');
    expect(h.get('origin')).toBe('https://shop.example');
    expect(h.get('cookie')).toBeNull();
    expect(h.get('x-splithub-country')).toBe('DE');
    expect(decodeURIComponent(h.get('x-splithub-city')!)).toBe('München');
    expect(h.get('x-forwarded-for')).toBe('1.2.3.4');
    expect(new TextDecoder().decode(init!.body as ArrayBuffer)).toBe('{"events":[]}');
  });

  it('refuses paths the SDK never calls', async () => {
    const fetchImpl = vi.fn();
    const res = await createCloudProxy({ fetchImpl: fetchImpl as unknown as typeof fetch })(new Request('https://shop.example/sh/v1/admin'));
    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('moves to the backup when the cloud gives no answer, then follows the announced address', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.startsWith(CLOUD)) throw new TypeError('ENOTFOUND');
      if (url.includes('/v1/overrides/')) return Response.json({ version: 1, experiments: {}, endpoint: 'https://go.moved.example/v1/events' });
      return new Response(null, { status: 202 });
    });
    const proxy = createCloudProxy({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const o = await proxy(new Request('https://shop.example/sh/v1/overrides/pk_live_1.json'));
    expect(((await o.json()) as { version: number }).version).toBe(1);
    await proxy(new Request('https://shop.example/sh/v1/events', { method: 'POST', body: '{}' }));
    expect(calls).toEqual([`${CLOUD}/v1/overrides/pk_live_1.json`, `${BACKUP}/v1/overrides/pk_live_1.json`, 'https://go.moved.example/v1/events']);
  });

  it('sends to a fixed upstream as written', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('offline'); });
    const res = await createCloudProxy({ upstream: 'go-staging.sh2.uk', fetchImpl: fetchImpl as unknown as typeof fetch })(new Request('https://shop.example/sh.js'));
    expect(res.status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://go-staging.sh2.uk/sh.js');
  });
});
