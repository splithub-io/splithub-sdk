import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_BODY_BYTES, type FetchHandler } from './handler';

/** Thrown while reading a body past the cap; answered 413 before the handler runs. */
class BodyTooLarge extends Error {}

/**
 * Adapt a fetch-style handler to Node's `http` / Express / Vite / Connect.
 *
 *   http.createServer(toNodeListener(handler))
 *   app.use('/api/splithub', toNodeListener(handler))
 *   viteServer.middlewares.use('/api/splithub', toNodeListener(handler))
 */
export function toNodeListener(handler: FetchHandler): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      try {
        const request = await toRequest(req);
        const response = await handler(request);
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
        res.end(body);
      } catch (error) {
        const tooLarge = error instanceof BodyTooLarge;
        res.statusCode = tooLarge ? 413 : 500;
        res.setHeader('content-type', 'application/json');
        // The rest of an oversized body is never read: close the connection instead of draining it.
        if (tooLarge) res.setHeader('connection', 'close');
        res.end(JSON.stringify({ error: tooLarge ? `body larger than ${MAX_BODY_BYTES} bytes` : error instanceof Error ? error.message : 'internal error' }));
        if (tooLarge) req.destroy();
      }
    })();
  };
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? 'localhost';
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  // Connect-style mounts strip the prefix into req.url; prefer originalUrl when present.
  const rawUrl = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '/';
  const url = new URL(rawUrl, `${proto}://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (typeof value === 'string') headers.set(key, value);
  }
  const method = req.method ?? 'GET';
  // A fresh ArrayBuffer: newer DOM typings accept neither Node's Buffer nor a view over a
  // possibly shared buffer as BodyInit.
  let body: ArrayBuffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    // The ingest POST is public: refuse a big body before buffering it, not after.
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) throw new BodyTooLarge();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += b.byteLength;
      if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
      chunks.push(b);
    }
    const copy = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      copy.set(c, at);
      at += c.byteLength;
    }
    body = copy.buffer;
  }
  return new Request(url, { method, headers, body });
}
