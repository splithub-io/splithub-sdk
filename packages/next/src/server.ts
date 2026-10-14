import { applyRemoteOverrides, assign, explainAssignment, getExperiment, type Assignment, type RemoteOverrides, type SplitHubConfig, type TargetingContext } from '@splithub/core';
import { getRemoteOverrides } from './remote';
import { cookies, headers } from 'next/headers';
import { requestContext, VISITOR_HEADER } from './middleware';

export { getRemoteOverrides } from './remote';

/**
 * Visitor id for the current request (header set by the middleware, else the
 * cookie). Null when the middleware is not installed and no cookie exists.
 */
export async function getVisitorId(config: SplitHubConfig): Promise<string | null> {
  const h = await headers();
  const fromHeader = h.get(VISITOR_HEADER);
  if (fromHeader) return fromHeader;
  const c = await cookies();
  return c.get(config.visitorKey)?.value ?? null;
}

export interface ServerSplitHub {
  visitorId: string | null;
  /** Targeting context built from the request headers (geo, device, language, referrer). */
  context: TargetingContext;
  /** Live overrides applied to this request; pass them to <SplitHubNextProvider remoteOverrides={...}> so hydration agrees. */
  overrides: RemoteOverrides | null;
  /** Config with overrides applied. */
  config: SplitHubConfig;
  assignment(experimentKey: string): Assignment;
  /** Variant key; control when unassigned. No exposure is recorded on the server: render `<Exposure id>` from `@splithub/next/client`. */
  variant(experimentKey: string): string;
  value<T = unknown>(experimentKey: string): T;
}

/**
 * Assignments inside Server Components and Route Handlers:
 *
 * ```tsx
 * const sh = await getSplitHub(config);
 * const title = sh.value<string>('hero-title');
 * ```
 */
export async function getSplitHub(baseConfig: SplitHubConfig): Promise<ServerSplitHub> {
  const [visitorId, fetched] = await Promise.all([getVisitorId(baseConfig), getRemoteOverrides(baseConfig)]);
  const config = applyRemoteOverrides(baseConfig, fetched);
  const h = await headers();
  const context: TargetingContext = requestContext(h, h.get('x-url') ?? h.get('referer') ?? '');
  // The overrides were fetched (and memoized) by this server, so their `ctx` is the server's
  // location, not the visitor's. Hand the browser the visitor's geo from the request headers
  // instead, so the client provider decides geo targeting exactly as this render did.
  const geo = Object.fromEntries(
    (['country', 'region', 'city', 'timezone'] as const).filter((k) => context[k]).map((k) => [k, context[k]])
  ) as NonNullable<RemoteOverrides['ctx']>;
  const overrides: RemoteOverrides | null = fetched ? { ...fetched, ctx: geo } : Object.keys(geo).length ? { version: 0, experiments: {}, ctx: geo } : null;
  const control = (key: string) => getExperiment(config, key)?.variants[0];
  const opts = { context };
  // Assign and, in development, explain a surprising result in the terminal.
  const decide = (key: string) => {
    if (!visitorId) return null;
    const a = assign(config, key, visitorId, opts);
    explainAssignment(getExperiment(config, key), a);
    return a;
  };
  return {
    visitorId,
    context,
    overrides,
    config,
    assignment(key) {
      return decide(key) ?? { experiment: key, variant: null, reason: 'not_running' };
    },
    variant(key) {
      const a = decide(key);
      return (a?.variant ?? control(key))?.key ?? 'control';
    },
    value<T>(key: string): T {
      const a = decide(key);
      return (a?.variant ?? control(key))?.value as T;
    },
  };
}
