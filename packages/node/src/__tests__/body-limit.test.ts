// The ingest POST is public: an oversized body must be refused before it is buffered,
// in the fetch handler (Next, Bun, Deno…) and in the Node adapter (Express, Vite, http).
import { defineConfig } from '@splithub/core';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSplitHubHandler, MAX_BODY_BYTES, type FetchHandler } from '../handler';
import { toNodeListener } from '../nodeAdapter';
import { createMemoryStore } from '../store';

const config = defineConfig({ project: 'demo', storage: { mode: 'self', endpoint: '/api/splithub' }, goals: {}, experiments: {} });
const big = '{"project":"demo","events":[]' + ' '.repeat(MAX_BODY_BYTES + 10) + '}';

/** A body stream of `bytes` in 64 KiB chunks; counts how much the reader pulled. */
function stream(bytes: number) {
  const state = { pulled: 0 };
  const chunk = new TextEncoder().encode(' '.repeat(64 * 1024));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= bytes) return controller.close();
      state.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  return { body, state };
}

describe('fetch handler body limit', () => {
  const handler = createSplitHubHandler({ config, store: createMemoryStore() });

  it('refuses a declared oversized body without reading it', async () => {
    const s = stream(10 * MAX_BODY_BYTES);
    const res = await handler(new Request('http://x/api/splithub', { method: 'POST', body: s.body, headers: { 'content-length': String(10 * MAX_BODY_BYTES) }, duplex: 'half' } as RequestInit));
    expect(res.status).toBe(413);
    expect(s.state.pulled).toBe(0);
  });

  it('stops reading an undeclared body at the cap', async () => {
    const s = stream(10 * MAX_BODY_BYTES);
    const res = await handler(new Request('http://x/api/splithub', { method: 'POST', body: s.body, duplex: 'half' } as RequestInit));
    expect(res.status).toBe(413);
    expect(s.state.pulled).toBeLessThan(MAX_BODY_BYTES + 256 * 1024);
  });

  it('still takes an ordinary batch', async () => {
    const res = await handler(new Request('http://x/api/splithub', { method: 'POST', body: JSON.stringify({ project: 'demo', events: [] }) }));
    expect(res.status).toBe(202);
  });
});

describe('Node adapter body limit', () => {
  let server: Server;
  let port = 0;
  let calls = 0;
  const inner: FetchHandler = async (request) => {
    calls++;
    return new Response(JSON.stringify({ bytes: (await request.arrayBuffer()).byteLength }), { status: 202 });
  };

  beforeAll(async () => {
    server = createServer(toNodeListener(inner));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.close();
  });

  const send = (payload: string, chunked: boolean) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/splithub', headers: chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      // The server closes an oversized upload early; that is the point, not a failure.
      req.on('error', (e: NodeJS.ErrnoException) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve({ status: 413, body: 'closed' }) : reject(e)));
      req.end(payload);
    });

  it('answers 413 to a declared or streamed oversized body and never calls the handler', async () => {
    calls = 0;
    expect((await send(big, false)).status).toBe(413);
    expect((await send(big, true)).status).toBe(413);
    expect(calls).toBe(0);
  });

  it('passes an ordinary body through whole', async () => {
    calls = 0;
    const payload = JSON.stringify({ project: 'demo', events: [] });
    const res = await send(payload, false);
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ bytes: Buffer.byteLength(payload) });
    expect(calls).toBe(1);
  });
});
