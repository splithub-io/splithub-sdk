import { isCrawler } from '@splithub/core';
import type { SplitHubConfig } from '@splithub/core';
import { ANALYSIS_UNAVAILABLE, rawResults, rawStatusTable } from './raw';
import type { Store } from './store';
import { validateBatch } from './validate';

export interface HandlerOptions {
  config: SplitHubConfig;
  store: Store;
  /**
   * Protects the read endpoints (`/status`, `/results/:id`). When unset, they
   * are open, which is fine for local development only.
   */
  adminToken?: string;
  /** Allowed origins for CORS. Defaults to same-origin only (no CORS headers). */
  cors?: string[] | '*';
}

// Crawlers, link previews and headless audits render pages too; their exposures
// would dilute every variant. Only a positive match counts: an empty UA or a
// plain HTTP client is let through. The Next middleware forwards the visitor's
// UA as `x-splithub-ua`, so that header wins over its own fetch's user-agent.
export const isBotUserAgent = (ua: string | null | undefined): boolean => isCrawler(ua);
const visitorUserAgent = (request: Request): string | null =>
  request.headers.get('x-splithub-ua') ?? request.headers.get('user-agent');

export type FetchHandler = (request: Request) => Promise<Response>;

/**
 * One handler for ingest and results, mountable at any path:
 *
 *   POST {base}                → ingest an event batch
 *   GET  {base}/status         → all experiments with exposures, visitors and days
 *   GET  {base}/results/:id    → visitors, conversions, rate (and revenue) per variant
 *
 * Reads are raw counts; verdicts and recommendations are SplitHub Cloud's.
 *   GET  {base}/health         → { ok: true }
 *
 * Works in Next.js route handlers, Remix, Hono, Bun, Deno and Node (via `toNodeListener`).
 */
export function createSplitHubHandler(options: HandlerOptions): FetchHandler {
  const { config, store } = options;

  const corsHeaders = (request: Request): Record<string, string> => {
    if (!options.cors) return {};
    const origin = request.headers.get('origin') ?? '';
    const allowed = options.cors === '*' ? '*' : options.cors.includes(origin) ? origin : '';
    if (!allowed) return {};
    return {
      'access-control-allow-origin': allowed,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '86400',
    };
  };

  const json = (request: Request, body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...corsHeaders(request) } });

  const authorized = (request: Request): boolean => {
    if (!options.adminToken) return true;
    const header = request.headers.get('authorization') ?? '';
    return header === `Bearer ${options.adminToken}`;
  };

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const tail = path.split('/').slice(-2);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });

    if (request.method === 'POST') {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json(request, { error: 'invalid JSON' }, 400);
      }
      const result = validateBatch(body, config.project);
      if (!result.ok) return json(request, { error: result.error }, 400);
      if (isBotUserAgent(visitorUserAgent(request))) return json(request, { ok: true, received: result.events.length, inserted: 0 }, 202);
      const inserted = await store.insertEvents(result.events);
      return json(request, { ok: true, received: result.events.length, inserted }, 202);
    }

    if (request.method === 'GET') {
      if (tail[1] === 'health') return json(request, { ok: true, project: config.project });
      if (!authorized(request)) return json(request, { error: 'unauthorized' }, 401);
      if (tail[1] === 'status') return json(request, { project: config.project, experiments: await rawStatusTable(config, store), analysis: ANALYSIS_UNAVAILABLE });
      if (tail[0] === 'results' && tail[1]) {
        const r = await rawResults(config, store, tail[1]);
        return r ? json(request, r) : json(request, { error: `unknown experiment "${tail[1]}"` }, 404);
      }
    }

    return json(request, { error: 'not found' }, 404);
  };
}
