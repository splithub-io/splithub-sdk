// @splithub/browser — run SplitHub on a site without the React SDK.
//
// Served by SplitHub Cloud as a drop-in script:
//   <script src="https://go.splithub.io/sh.js" data-key="pk_live_..."></script>
//
// What it does on every page:
//   1. reads the hosted config + live overrides (cached, refreshed every 60 s);
//   2. for redirect experiments matching the current path: assigns the visitor
//      (same hash as the SDK, targeting flow included) and, when the variant
//      points elsewhere, navigates there before the page paints;
//   3. records the exposure, fires pageview goals, binds click goals, exposes window.splithub.track()
//      (an event, any name; it converts experiments whose goal it is);
//   4. analytics, with data-property="<property id>": a pageview per page and per
//      client-side navigation (the core client follows history and hash routes), time on page
//      and scroll depth, and window.splithub.identify().
//
// Holding the page (flicker-free redirects). The script hides the page while it
// decides only when a redirect can happen here:
//   - the cached overrides (written on any earlier page view of the site) list a
//     running redirect experiment whose `match` covers this path; or
//   - the page opts in: <meta name="splithub-experiment" content="home">,
//     <meta name="splithub-redirects">, or data-redirects on the script tag.
// A first visit without the cache and without an opt-in is never hidden: it paints
// at once, and if a redirect applies it navigates after the overrides arrive (a
// flash). Put the opt-in on pages with a redirect test to avoid that flash.
// Crawlers are never held or redirected.
//
// Component / value experiments need the SDK in the app: this script cannot
// change your markup.

import {
  applyRemoteOverrides,
  createClient,
  CLOUD_ENDPOINT,
  countsForHoldout,
  decideRedirect,
  fetchRemoteOverrides,
  isActive,
  isBot,
  matchPath,
  parseForceParam,
  readRemoteCache,
  redirectTarget,
  resolveOverridesUrl,
  writeRemoteCache,
  type RedirectDecision,
  type RemoteOverrides,
  type SplitHubClient,
  type SplitHubConfig,
  debugLog,
  debugMode,
} from '@splithub/core';

export { decideRedirect, matchPath };
export type { RedirectDecision };

export interface BootOptions {
  /** Public project key (pk_...). */
  key: string;
  /** Events endpoint; defaults to SplitHub Cloud. */
  endpoint?: string;
  /** How long to hold the page hidden while deciding a redirect (ms). Default 1500. */
  holdMs?: number;
  /** Skip hiding the page (accept a flash of the original page). */
  noHold?: boolean;
  /** This page has a redirect test: hold it even on a first visit (no cached overrides yet). */
  redirects?: boolean;
  /** Analytics property id for pageviews and events (`data-property="sh-x1h78w"`). Without it the script sends no analytics. */
  property?: string | false;
}

/**
 * Minimal cloud config for a site that keeps everything in the dashboard. Built
 * by hand rather than with defineConfig, so the validator stays out of sh.js.
 */
export function siteConfig(key: string, endpoint?: string): SplitHubConfig {
  return { project: 'site', storage: { mode: 'cloud', key, ...(endpoint ? { endpoint } : {}) }, visitorKey: 'sh_vid', runDraftsInDev: false, goals: [], experiments: [], __splithub: 2 };
}

export interface SplitHubWindow {
  client: SplitHubClient;
  /** An event, any name: `splithub.track('Video Played', { id: 3 })`. */
  track: SplitHubClient['track'];
  /** Ties the visitor to your user id: `splithub.identify('user_42', { plan: 'pro' })`. */
  identify: SplitHubClient['identify'];
  variant: SplitHubClient['variant'];
  value: SplitHubClient['value'];
  /** Resolved once the redirect decision is made. */
  ready: Promise<RedirectDecision | null>;
}

declare global {
  interface Window {
    splithub?: SplitHubWindow;
    /** Calls queued before the script loaded: `(splithubq = splithubq || []).push(['track', 'signup'])`. */
    splithubq?: Array<[string, ...unknown[]]>;
  }
}

function hold(ms: number): () => void {
  const root = document.documentElement;
  const prev = root.style.visibility;
  root.style.visibility = 'hidden';
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    root.style.visibility = prev;
  };
  setTimeout(release, ms);
  return release;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch(() => {
      clearTimeout(t);
      resolve(fallback);
    });
  });
}

/** Start the runtime. Safe to call once per page; returns the redirect decision. */
export async function boot(options: BootOptions): Promise<RedirectDecision | null> {
  if (typeof window === 'undefined' || !options.key) return null;
  if (window.splithub) return window.splithub.ready;

  // window.splithub exists synchronously: inline scripts can call track() /
  // await ready before the config has arrived. Calls are queued until then.
  let resolveReady!: (d: RedirectDecision | null) => void;
  const ready = new Promise<RedirectDecision | null>((r) => (resolveReady = r));
  const queued: Array<() => void> = [];
  let client: SplitHubClient | null = null;
  const later = <T,>(fn: (c: SplitHubClient) => T, fallback: T): T => {
    if (client) return fn(client);
    queued.push(() => void fn(client!));
    return fallback;
  };
  const api: SplitHubWindow = {
    get client() {
      if (!client) throw new Error('[splithub] not ready yet: await window.splithub.ready');
      return client;
    },
    track: (name, props) => later((c) => c.track(name, props), undefined),
    identify: (uid, traits) => later((c) => c.identify(uid, traits), undefined),
    variant: (key) => later((c) => c.variant(key), 'control'),
    value: (key) => later((c) => c.value(key), undefined as never),
    ready,
  };
  window.splithub = api;
  const q = window.splithubq ?? [];
  const drain = (call: [string, ...unknown[]]) => {
    const [method, ...args] = call;
    if (method === 'track') api.track(String(args[0]), args[1] as Record<string, unknown> | undefined);
    if (method === 'identify') api.identify(args[0] === null ? null : String(args[0]), args[1] as Record<string, unknown> | undefined);
  };
  for (const call of q) drain(call);
  window.splithubq = { push: drain } as unknown as Array<[string, ...unknown[]]>;

  const base = siteConfig(options.key, options.endpoint);
  const url = resolveOverridesUrl(options.endpoint ?? CLOUD_ENDPOINT, options.key);
  const pathname = location.pathname;
  const cached = readRemoteCache(options.key);
  const cachedConfig = cached ? applyRemoteOverrides(base, cached.overrides) : base;
  const optIn = Boolean(options.redirects) || Boolean(document.querySelector('meta[name="splithub-experiment"],meta[name="splithub-redirects"]'));
  const bot = isBot(navigator.userAgent);
  const mayRedirect = !bot && (optIn || cachedConfig.experiments.some((e) => e.kind === 'redirect' && isActive(cachedConfig, e) && !!e.match && matchPath(e.match, pathname)));
  const release = mayRedirect && !options.noHold ? hold(options.holdMs ?? 1500) : () => undefined;

  let overrides: RemoteOverrides | null = cached?.overrides ?? null;
  const stale = !cached || Date.now() - cached.fetchedAt > 60_000;
  // Overrides that come after the redirect decision still count for analytics: a property made
  // in the dashboard is only in them, and the landing page must not be lost (the client waits up to 5 s).
  let arriving: Promise<RemoteOverrides | null> | undefined;
  if (mayRedirect || stale) {
    let settled = false;
    const fetching = fetchRemoteOverrides(url).then((fresh) => {
      settled = true;
      if (fresh) writeRemoteCache(options.key, fresh);
      return fresh;
    });
    const fresh = await withTimeout(fetching, mayRedirect ? (options.holdMs ?? 1500) - 100 : 5000, null);
    if (fresh) overrides = fresh;
    else if (!settled) arriving = fetching;
  }

  client = createClient(base, {
    remote: { overrides: overrides ?? { version: 0, experiments: {} }, ...(arriving ? { arriving } : {}) },
    ...(options.property !== undefined ? { property: options.property } : {}),
  });
  // A visitor who reaches a running redirect test joins the holdout comparison even when held out
  // (no decision then); exposure() sends the `__holdout` marker by the same rule as the SDK and the middleware.
  let reached = null as string | null;
  const decision = decideRedirect(client.config, pathname, client.visitorId, client.context, parseForceParam(location.search), (exp, a) => {
    if (!reached && countsForHoldout(a)) reached = exp.key;
  });
  if (decision) client.exposure(decision.experiment);
  else if (reached) client.exposure(reached);
  if (decision) debugLog('redirect', `${decision.experiment} / ${decision.variant} on ${pathname}${decision.to ? ` → ${decision.to}` : ' (stays here)'}`, decision as unknown as Record<string, unknown>);
  if (decision?.to && debugMode() === 'hold') {
    debugLog('redirect', `hold: not navigating to ${decision.to} (sh_debug=hold)`);
  } else if (decision?.to) {
    await withTimeout(client.flush(), 800, undefined);
    resolveReady(decision);
    location.replace(redirectTarget(decision.to, location.href).toString());
    return decision;
  }
  release();
  client.pageview();
  client.autoGoals();
  for (const fn of queued) fn();
  queued.length = 0;
  resolveReady(decision);
  return decision;
}

