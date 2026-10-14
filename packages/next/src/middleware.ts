import {
  applyRemoteOverrides,
  CLOUD_ENDPOINT,
  countsForHoldout,
  decideRedirect,
  explainAssignment,
  HOLDOUT_KEY,
  holdoutGroup,
  isDevEnvironment,
  matchPath,
  newId,
  newVisitorId,
  parseCookies,
  parseForceParam,
  parseUserAgent,
  redirectTarget,
  SDK_VERSION,
  type EventBatch,
  type ExposureEvent,
  type SplitHubConfig,
  type TargetingContext,
} from '@splithub/core';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { getRemoteOverrides } from './remote';

export const VISITOR_HEADER = 'x-splithub-vid';
const ONE_YEAR = 60 * 60 * 24 * 365;

export interface MiddlewareOptions {
  /** Return true to skip a path entirely. Defaults to `_next`, `api` and files with an extension. */
  exclude?: (pathname: string) => boolean;
  /** Send exposures for redirect experiments from the edge. Default true. */
  trackRedirects?: boolean;
  /** Apply live overrides from the cloud (cloud mode only). Default true. */
  remote?: boolean;
}

function defaultExclude(pathname: string): boolean {
  return pathname.startsWith('/_next') || pathname.startsWith('/api/') || /\.[a-z0-9]+$/i.test(pathname);
}

/** Same rule as sh.js and pageview goals (from `@splithub/core`). */
export { matchPath };

/**
 * Targeting context from request headers: Cloudflare / Vercel geo, user agent, language,
 * referrer, cookies. `timezone` (for `hour` / `weekday`) comes from Vercel's
 * `x-vercel-ip-timezone` or a `cf-timezone` / `x-timezone` header you set; without one
 * the flow uses UTC.
 */
export function requestContext(headers: Headers, url: string, visitor?: 'new' | 'returning'): TargetingContext {
  const ua = parseUserAgent(headers.get('user-agent'));
  const country = headers.get('cf-ipcountry') ?? headers.get('x-vercel-ip-country') ?? headers.get('x-country') ?? undefined;
  const region = headers.get('x-vercel-ip-country-region') ?? headers.get('cf-region') ?? undefined;
  const city = headers.get('x-vercel-ip-city') ?? headers.get('cf-ipcity') ?? undefined;
  const timezone = headers.get('x-vercel-ip-timezone') ?? headers.get('cf-timezone') ?? headers.get('x-timezone') ?? undefined;
  return {
    country: country ?? undefined,
    region: region ? decodeURIComponent(region) : undefined,
    city: city ? decodeURIComponent(city) : undefined,
    device: ua.device,
    browser: ua.browser,
    os: ua.os,
    language: headers.get('accept-language') ?? undefined,
    referrer: headers.get('referer') ?? undefined,
    url,
    cookies: parseCookies(headers.get('cookie')),
    ...(timezone ? { timezone } : {}),
    ...(visitor ? { visitor } : {}),
  };
}

function ingestTarget(config: SplitHubConfig, origin: string): { url: string; key?: string } {
  if (config.storage.mode === 'self') return { url: new URL(config.storage.endpoint, origin).toString() };
  return { url: config.storage.endpoint ?? CLOUD_ENDPOINT, key: config.storage.key };
}

/**
 * Next.js middleware:
 *  1. ensures the `sh_vid` visitor cookie, so SSR and the client agree on variants;
 *  2. forwards the visitor id to Server Components via the `x-splithub-vid` header;
 *  3. serves redirect experiments with an invisible rewrite (URL unchanged, no flash);
 *  4. records the redirect exposure from the edge, deduplicated with a cookie.
 *
 * ```ts
 * // middleware.ts
 * import { splithubMiddleware } from '@splithub/next';
 * import config from './splithub.config';
 * export default splithubMiddleware(config);
 * export const config = { matcher: ['/((?!_next|api|.*\\..*).*)'] };
 * ```
 */
export function splithubMiddleware(baseConfig: SplitHubConfig, options: MiddlewareOptions = {}) {
  const exclude = options.exclude ?? defaultExclude;
  const trackRedirects = options.trackRedirects ?? true;
  const useRemote = options.remote ?? true;

  return async function middleware(request: NextRequest, event?: NextFetchEvent): Promise<NextResponse> {
    const pathname = request.nextUrl.pathname;
    if (exclude(pathname)) return NextResponse.next();

    const config = useRemote ? applyRemoteOverrides(baseConfig, await getRemoteOverrides(baseConfig)) : baseConfig;

    let visitorId = request.cookies.get(config.visitorKey)?.value ?? null;
    const isNewVisitor = !visitorId;
    if (!visitorId) visitorId = newVisitorId();

    const overrides = parseForceParam(request.nextUrl.search);
    const context = requestContext(request.headers, request.nextUrl.href, isNewVisitor ? 'new' : 'returning');
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(VISITOR_HEADER, visitorId);

    let response: NextResponse | null = null;
    const cookiesToSet: Array<{ name: string; value: string }> = [];

    // The same decision as sh.js; in development, say why a matching test did nothing.
    // A visitor who reaches a running redirect test also joins the holdout comparison (same rule as the SDK).
    let reachedTest = false as boolean;
    const decision = decideRedirect(config, pathname, visitorId, context, overrides, (exp, a) => {
      if (countsForHoldout(a)) reachedTest = true;
      explainAssignment(exp, a);
    });
    // Development never sends to the cloud (the developer is not a visitor); a self-hosted store records it, dev drafts included.
    // Bots never reach here with a variant: assign gives them the control without one.
    const cloudDev = config.storage.mode === 'cloud' && isDevEnvironment();
    const events: ExposureEvent[] = [];
    if (decision) {
      if (decision.to) {
        const target = redirectTarget(decision.to, request.nextUrl.href);
        let url: URL = target;
        if (target.origin === request.nextUrl.origin) {
          // Keep Next's own URL (basePath, locale) and change only what the variant says.
          const next = request.nextUrl.clone();
          next.pathname = target.pathname;
          next.search = target.search;
          url = next;
        }
        response = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
      }

      const exposureCookie = `sh_x_${decision.experiment}`;
      const record = !cloudDev && (decision.reason === 'assigned' || (decision.reason === 'dev' && config.storage.mode === 'self'));
      if (trackRedirects && record && request.cookies.get(exposureCookie)?.value !== decision.variant) {
        cookiesToSet.push({ name: exposureCookie, value: decision.variant });
        events.push({ id: newId('e_'), type: 'exposure', exp: decision.experiment, var: decision.variant, vid: visitorId, sid: 'edge', ts: Date.now(), url: pathname });
      }
    }
    const group = reachedTest ? holdoutGroup(config, visitorId) : null;
    if (group && trackRedirects && !cloudDev && request.cookies.get(`sh_x_${HOLDOUT_KEY}`)?.value !== group) {
      cookiesToSet.push({ name: `sh_x_${HOLDOUT_KEY}`, value: group });
      events.push({ id: newId('e_'), type: 'exposure', exp: HOLDOUT_KEY, var: group, vid: visitorId, sid: 'edge', ts: Date.now(), url: pathname });
    }
    if (events.length) {
      const target = ingestTarget(config, request.nextUrl.origin);
      const batch: EventBatch = { project: config.project, sdk: `next/${SDK_VERSION}`, events };
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (target.key) headers.authorization = `Bearer ${target.key}`;
      // The visitor's user agent, so the ingest's bot filter judges the visitor, not this server.
      // `x-splithub-ua` too, for runtimes that replace a user-agent set on fetch.
      const ua = request.headers.get('user-agent');
      if (ua) {
        headers['user-agent'] = ua;
        headers['x-splithub-ua'] = ua;
      }
      const send = fetch(target.url, { method: 'POST', headers, body: JSON.stringify(batch) }).catch(() => undefined);
      if (event?.waitUntil) event.waitUntil(send);
    }

    response ??= NextResponse.next({ request: { headers: requestHeaders } });

    if (isNewVisitor) {
      response.cookies.set(config.visitorKey, visitorId, { maxAge: ONE_YEAR, path: '/', sameSite: 'lax' });
    }
    for (const c of cookiesToSet) response.cookies.set(c.name, c.value, { maxAge: ONE_YEAR, path: '/', sameSite: 'lax' });
    return response;
  };
}
