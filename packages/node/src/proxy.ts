import { cloudEndpoints, memoryStorage, normalizeCloudEndpoint, rememberEndpoint } from '@splithub/core';

// A first-party endpoint: the site or app sends to a path on its own domain
// (`https://shop.com/sh/v1/events`), and this handler forwards to SplitHub Cloud.
// Point `storage.endpoint` at it. Nothing to set up on our side: the cloud takes
// events from any domain, and the visitor's browser, language and country are
// passed along so reports read as if the visitor had called the cloud directly.

export interface CloudProxyOptions {
  /**
   * Where to forward: a domain or an events URL (`go.sh2.uk`, `https://go-staging.sh2.uk/v1/events`).
   * Unset, the `SPLITHUB_UPSTREAM` environment variable, else SplitHub Cloud, following the address it
   * announces and its backup, so a move of the cloud needs no update here.
   */
  upstream?: string;
  /** The visitor's location when the platform knows it. Default: Cloudflare's and Vercel's request data. */
  geo?: (request: Request) => ProxyGeo | null;
  fetchImpl?: typeof fetch;
}

export interface ProxyGeo {
  country?: string | null;
  region?: string | null;
  city?: string | null;
}

/** The paths the SDKs call, wherever the handler is mounted (`/sh/v1/events`, `/api/splithub/sh.js`). */
const PATH = /\/(v1\/events|v1\/overrides\/pk_[A-Za-z0-9_-]+\.json|v1\/sh\.js|sh\.js)$/;
/** Request headers that describe the hop to this server, not the visitor. */
const HOP = new Set(['host', 'cookie', 'connection', 'content-length', 'keep-alive', 'transfer-encoding', 'upgrade', 'x-forwarded-host', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'cdn-loop']);
/** fetch() has already decoded the body; these would describe the encoded one. */
const STALE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

const decode = (v: string | null): string | null => {
  if (!v) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/** Cloudflare (`request.cf`, `CF-IPCountry`) and Vercel (`x-vercel-ip-*`). */
export function platformGeo(request: Request): ProxyGeo | null {
  const cf = (request as Request & { cf?: { country?: string; region?: string; city?: string } }).cf;
  const h = request.headers;
  const country = cf?.country ?? h.get('cf-ipcountry') ?? h.get('x-vercel-ip-country');
  const region = cf?.region ?? decode(h.get('x-vercel-ip-country-region'));
  const city = cf?.city ?? decode(h.get('x-vercel-ip-city'));
  return country || region || city ? { country, region, city } : null;
}

const env = (name: string): string | undefined => {
  try {
    return typeof process !== 'undefined' ? process.env?.[name] || undefined : undefined;
  } catch {
    return undefined;
  }
};

/** `https://go.sh2.uk/v1/events` → `https://go.sh2.uk`. */
const baseOf = (eventsUrl: string): string => eventsUrl.replace(/\/v1\/events\/?$/, '');

/**
 * A fetch-style handler that forwards the SDK's calls to SplitHub Cloud. Mount it under any path:
 *
 * ```ts
 * // Next.js: app/sh/[...path]/route.ts, then storage.endpoint: 'https://shop.com/sh/v1/events'
 * const proxy = createCloudProxy();
 * export { proxy as GET, proxy as POST, proxy as OPTIONS };
 * // Cloudflare Worker: export default { fetch: createCloudProxy() };
 * // Express / node:http: toNodeListener(createCloudProxy())
 * ```
 */
export function createCloudProxy(options: CloudProxyOptions = {}): (request: Request) => Promise<Response> {
  const fixed = options.upstream ?? env('SPLITHUB_UPSTREAM');
  const announced = memoryStorage();
  const doFetch = options.fetchImpl ?? fetch;
  const geoOf = options.geo ?? platformGeo;

  return async (request) => {
    const url = new URL(request.url);
    const path = PATH.exec(url.pathname)?.[1];
    if (!path) return Response.json({ error: 'not a SplitHub path', code: 'not_found' }, { status: 404 });

    const headers = new Headers();
    request.headers.forEach((value, key) => {
      if (!HOP.has(key.toLowerCase())) headers.set(key, value);
    });
    const ua = request.headers.get('user-agent');
    if (ua) headers.set('x-splithub-ua', ua);
    const geo = geoOf(request);
    if (geo?.country) headers.set('x-splithub-country', geo.country);
    if (geo?.region) headers.set('x-splithub-region', encodeURIComponent(geo.region));
    if (geo?.city) headers.set('x-splithub-city', encodeURIComponent(geo.city));
    const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (ip) headers.set('x-forwarded-for', ip);

    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
    const bases = fixed ? [baseOf(normalizeCloudEndpoint(fixed))] : cloudEndpoints(announced).map(baseOf);

    for (const base of bases) {
      let res: Response;
      try {
        res = await doFetch(`${base}/${path}${url.search}`, { method: request.method, headers, ...(body ? { body } : {}) });
      } catch {
        continue; // no answer: the next address
      }
      if (!fixed && path.startsWith('v1/overrides/') && res.ok) {
        const announcedUrl = ((await res.clone().json().catch(() => null)) as { endpoint?: unknown } | null)?.endpoint;
        if (typeof announcedUrl === 'string') rememberEndpoint(announced, announcedUrl);
      }
      const out = new Headers();
      res.headers.forEach((value, key) => {
        if (!STALE.has(key.toLowerCase())) out.set(key, value);
      });
      return new Response(request.method === 'HEAD' ? null : res.body, { status: res.status, statusText: res.statusText, headers: out });
    }
    return Response.json({ error: 'SplitHub Cloud did not answer', code: 'upstream_unreachable' }, { status: 502 });
  };
}
