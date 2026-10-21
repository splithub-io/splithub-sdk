import { isCrawler } from '@splithub/core';
import type { SplitHubConfig } from '@splithub/core';
import { ANALYSIS_UNAVAILABLE, rawResults, rawStatusTable } from './raw';
import { rawPropertyRange, rawPropertyReport } from './analytics';
import { ANALYTICS_TYPES, type Store } from './store';
import { validateBatch } from './validate';
import { experimentGoals, goalsFromAnalytics } from './derive';
import { withAppDimensions } from './app';

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
 *   GET  {base}/properties     → analytics properties with raw counts (`?days=30`, or `?from=&to=` UTC days)
 *   GET  {base}/properties/:key            → one property's raw counts
 *   GET  {base}/properties/:key/events     → its latest raw pageviews and events (`?before=&limit=`)
 *
 * Reads are raw counts; verdicts and recommendations are SplitHub Cloud's.
 *   GET  {base}/health         → { ok: true }
 *
 * Works in Next.js route handlers, Remix, Hono, Bun, Deno and Node (via `toNodeListener`).
 */
export function createSplitHubHandler(options: HandlerOptions): FetchHandler {
  const { config, store } = options;
  // The goals analytics rows convert: what an `event` or `page` row stands in for (see ./derive).
  const derivable = experimentGoals(config);

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
      // Invalid events were dropped one by one; the rest of the batch is kept.
      const dropped = result.dropped ? { dropped: result.dropped, errors: result.errors } : {};
      const received = result.events.length + result.dropped;
      if (isBotUserAgent(visitorUserAgent(request))) return json(request, { ok: true, received, inserted: 0, ...dropped }, 202);
      // Analytics rows of a property that is not declared (or paused) are dropped, as in the cloud.
      const running = new Set((config.properties ?? []).filter((p) => p.status === 'running').map((p) => p.key));
      // Goals come from the event and page rows before that, as in the cloud: experiments count them even when the property is paused.
      const stamped = withAppDimensions(result.events, result.app);
      const derived = goalsFromAnalytics(stamped, derivable).map(({ derived: _, ...goal }) => goal);
      const events = [...stamped.filter((e) => !ANALYTICS_TYPES.has(e.type) || (e.experiment !== null && running.has(e.experiment))), ...derived];
      const inserted = events.length ? await store.insertEvents(events) : 0;
      return json(request, { ok: true, received, inserted, ...dropped }, 202);
    }

    if (request.method === 'GET') {
      if (tail[1] === 'health') return json(request, { ok: true, project: config.project });
      if (!authorized(request)) return json(request, { error: 'unauthorized' }, 401);
      if (tail[1] === 'status') return json(request, { project: config.project, experiments: await rawStatusTable(config, store), analysis: ANALYSIS_UNAVAILABLE });
      const segments = path.split('/');
      const at = segments.lastIndexOf('properties');
      if (at >= 0 && segments.length - at <= 3) {
        const [key, sub] = [segments[at + 1], segments[at + 2]];
        const span = { days: Number(url.searchParams.get('days') ?? 30) || 30, from: url.searchParams.get('from'), to: url.searchParams.get('to') };
        const bad = rawPropertyRange(span);
        if (typeof bad === 'string') return json(request, { error: bad, code: 'invalid_range', hint: 'Send from and to as days like 2026-10-01 (UTC), from on or before to.' }, 400);
        if (!key) {
          const list = await Promise.all((config.properties ?? []).map((p) => rawPropertyReport(config, store, p.key, span)));
          return json(request, { properties: list.filter(Boolean) });
        }
        if (sub === 'events') {
          // Pageviews, events, engagement and identify rows, newest first.
          if (!store.propertyEvents) return json(request, { error: 'this store keeps no raw property events', code: 'not_implemented' }, 501);
          const before = Number(url.searchParams.get('before')) || Date.now() + 1;
          const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
          return json(request, { property: key, events: await store.propertyEvents(key, { before, limit }) });
        }
        if (sub === undefined) {
          const r = await rawPropertyReport(config, store, key, span);
          return r ? json(request, r) : json(request, { error: `unknown property "${key}"` }, 404);
        }
      }
      if (tail[0] === 'results' && tail[1]) {
        const r = await rawResults(config, store, tail[1]);
        return r ? json(request, r) : json(request, { error: `unknown experiment "${tail[1]}"` }, 404);
      }
    }

    return json(request, { error: 'not found' }, 404);
  };
}
