import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FetchHandler } from './handler';

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
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'internal error' }));
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
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const all = Buffer.concat(chunks);
    const copy = new Uint8Array(all.byteLength);
    copy.set(all);
    body = copy.buffer;
  }
  return new Request(url, { method, headers, body });
}
