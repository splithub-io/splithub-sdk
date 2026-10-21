import { assign, countsForHoldout, holdoutGroup, isDevEnvironment, parseForceParam } from './assignment';
import { debugLog, isDebug } from './debug';
import { devNote, explainAssignment } from './dev';
import { goalKeyFor, EVENT_NAME_PATTERN, getExperiment, HOLDOUT_KEY, isSplitHubConfig, pickProperty } from './config';
import { EventQueue, createFetchTransport, type Transport } from './events';
import { murmur3 } from './hash';
import { newId, newSessionId, newVisitorId } from './ids';
import { memoryStorage, safeGet, safeSet, type KeyValueStorage, type PlatformAdapter } from './platform';
import {
  applyRemoteOverrides,
  fetchRemoteOverrides,
  readRemoteCache,
  REMOTE_TTL_MS,
  resolveOverridesUrl,
  writeRemoteCache,
  type RemoteOverrides,
} from './remote';
import { matchPath } from './paths';
import { claimAnalytics, releaseAnalytics } from './shared';
import { browserContext } from './targeting';
import type { Assignment, Experiment, SplitHubConfig, TargetingContext, Variant } from './types';
import {
  getOrCreateSessionId,
  getOrCreateStoredId,
  getOrCreateVisitorId,
  hasVisitorId,
  isBrowser,
  persistExposureSet,
  readStored,
  sessionExposureSet,
  sessionReferrer,
  writeStored,
} from './visitor';

// The drop-in script's build defines this as true, so `typeof` folds and the development
// notes (strings included) drop out of sh.js. It has to be written inline at each use:
// a constant imported from another module is inlined too late to remove the dead branch.
declare const __SPLITHUB_LITE__: true | undefined;

export const SDK_VERSION = '0.1.0';
/**
 * First visit (or first app launch) without cached overrides: the longest the client waits for
 * them. The fetch usually takes ~150 ms. Apps wait the same: later launches read the cache.
 */
export const REMOTE_WAIT_MS = 400;
const DEV_NOTE = 'Development sends nothing to the cloud, so your own visits never reach the results. Deployed builds send as usual.';
export const CLOUD_ENDPOINT = 'https://go.splithub.io/v1/events';
/** How long analytics events wait for overrides that may declare their property (a property made in the dashboard). */
export const PROPERTY_WAIT_MS = 5000;
/** Goal and event props larger than this (as JSON) are trimmed: the ingest refuses them. */
export const MAX_PROPS_BYTES = 4096;
const MAX_ENGAGE_MS = 3_600_000;
/** The app's user id (identify), kept across sessions; re-sent once per session. */
const UID_KEY = 'sh_uid';
const UID_SENT_KEY = 'sh_uid_sent';
const SESSION_KEY = 'sh_sid';
const EXPOSED_KEY = 'sh_exposed';
/** An app away this long starts a new session when it comes back. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

export interface ClientOptions {
  /** Provide on the server (from the cookie) so SSR and client agree. */
  visitorId?: string;
  sessionId?: string;
  /** Custom transport, e.g. a no-op for tests or SSR. */
  transport?: Transport;
  /**
   * Apps (React Native, desktop): storage, app info and lifecycle instead of a browser page.
   * The client then keeps the visitor in `storage`, persists unsent events (`sh_queue`), sends
   * no pageviews of its own (call `screen()`), and starts a new session after 30 minutes in the background.
   */
  platform?: PlatformAdapter;
  /** `sdk` of every batch. Default `core/<version>`; wrappers name themselves (`react-native/1.0.0`). */
  sdk?: string;
  /**
   * Send the cloud key as `?key=` so page-hide batches can use `navigator.sendBeacon`.
   * On by default for SplitHub Cloud (the key is public); off for a custom endpoint,
   * which may not read the key from the query.
   */
  keyInQuery?: boolean;
  /** Force variants, merged with `?sh_force=` in the browser. */
  overrides?: Record<string, string>;
  /** Disable all network activity (SSR, tests, `status: draft` previews). */
  disabled?: boolean;
  /**
   * Remote overrides (cloud mode): pause, traffic, weights and values changed
   * from the dashboard/CLI without a deploy. Cached in localStorage and
   * applied synchronously on later page loads. A first visit has no cache, so
   * the client waits up to `waitMs` for them, serving control meanwhile, then
   * decides once; a decided variant never changes mid-page.
   */
  remote?: {
    /** Apply these overrides now (SSR: pass what the server fetched). */
    overrides?: RemoteOverrides | null;
    /** Skip fetching. Default: fetch in cloud mode in the browser. */
    disabled?: boolean;
    url?: string;
    ttlMs?: number;
    /** First visit (nothing cached): how long to wait for the overrides before deciding from the file. Default 400 ms; 0 decides at once. */
    waitMs?: number;
    /**
     * Overrides still on their way (the drop-in script stops waiting for experiments before they arrive).
     * Analytics events for a property they may declare wait for them, up to 5 s.
     */
    arriving?: Promise<RemoteOverrides | null>;
  };
  /**
   * Visitor context for targeting (country, device, UTM ...). In the browser it
   * is collected automatically and merged with the cloud's geo (`ctx` in the
   * overrides JSON); on the server pass what you know from the request.
   */
  context?: TargetingContext;
  /**
   * Analytics property that receives pageviews and events: its id (`sh-x1h78w`), from
   * `properties` in the config or from the dashboard. Without it no analytics events are sent.
   */
  property?: string | false;
  /**
   * Single-page apps: after the first pageview(), report every client-side navigation
   * (history.pushState / replaceState / back) as a pageview too. Default true in the browser.
   */
  trackNavigation?: boolean;
  /**
   * Hash routers (`/#/pricing`): report the route after `#` as the page. Default: only when the
   * path is `/` and the hash starts with `#/`; `false` never, `true` on any path.
   */
  trackHash?: boolean;
  onError?: (error: unknown) => void;
}

export interface SplitHubClient {
  readonly config: SplitHubConfig;
  readonly visitorId: string;
  /** May change during the client's life (an app back after 30 minutes away): read it each time, do not keep a copy. */
  readonly sessionId: string;
  /** Targeting context used for assignments. */
  readonly context: TargetingContext;
  /**
   * True on a first visit in cloud mode while the dashboard's overrides are on
   * their way (at most `remote.waitMs`). Every experiment serves control and
   * events wait; then the client decides once and notifies subscribers.
   */
  readonly pending: boolean;
  /** Resolves once experiments are decided (at once unless `pending`). */
  readonly ready: Promise<void>;
  /** Called once when a pending client decides. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Assignment without side effects. */
  assignment(experimentKey: string): Assignment;
  /** Variant key (control when not in experiment). Records an exposure. */
  variant(experimentKey: string): string;
  /** Payload of a `value` experiment (control value when not in experiment). Records an exposure. */
  value<T = unknown>(experimentKey: string): T;
  /** Record an exposure explicitly (the React components call this on mount). */
  exposure(experimentKey: string): void;
  /**
   * An event, any name (`track('signup')`, `track('Video Played', { id })`): one row that reaches the
   * analytics property and converts the experiments whose goal it is (the goal keyed by its slug).
   * Without a property it goes out as a goal row.
   */
  track(name: string, props?: Record<string, unknown>): void;
  /**
   * A page view: a `page` event for the analytics property, which also converts the pageview goals
   * of the URL. Without a property, the goal rows of the URL go out instead.
   */
  pageview(path?: string): void;
  /**
   * A screen of an app (or a virtual page on the web): a `page` event with url `/${name}` (or
   * `name` itself when it starts with `/`) and the name as title. `props` are accepted for
   * later; page rows carry none on the wire yet.
   */
  screen(name: string, props?: Record<string, unknown>): void;
  /**
   * Ties this visitor to your user id (1..128 characters) with optional flat traits
   * (`{ plan: 'pro' }`). Remembered in the browser and re-sent once per session; `null` forgets it.
   */
  identify(uid: string | null, traits?: Record<string, unknown>): void;
  /** Bind click goals (`type: 'click'`, CSS selector) to the document. Returns an unbind function. No-op outside the browser. */
  autoGoals(root?: Document | HTMLElement): () => void;
  flush(): Promise<void>;
  destroy(): void;
  /**
   * Binds the app lifecycle (background / foreground) again after `destroy()`, as a provider does when
   * StrictMode mounts it a second time. Idempotent; a no-op on the web, where the next event binds.
   */
  resume(): void;
}

function resolveEndpoint(config: SplitHubConfig): { endpoint: string; key?: string } {
  if (config.storage.mode === 'self') return { endpoint: config.storage.endpoint };
  return { endpoint: config.storage.endpoint ?? CLOUD_ENDPOINT, key: config.storage.key };
}

export function createClient(config: SplitHubConfig, options: ClientOptions = {}): SplitHubClient {
  if (!isSplitHubConfig(config)) {
    throw new Error('[splithub] pass the object returned by defineConfig() from splithub.config.ts');
  }

  // sh.js (LITE) never runs in an app: every `typeof __SPLITHUB_LITE__ === 'undefined' && adapter` below drops the app code from it.
  const adapter: PlatformAdapter | null = typeof __SPLITHUB_LITE__ === 'undefined' ? options.platform ?? null : null;
  const app = typeof __SPLITHUB_LITE__ === 'undefined' && adapter !== null;
  const browser = !app && isBrowser();
  // Remembers the visitor between pages or launches: a browser page or an app. The rest is a server.
  const persistent = browser || app;
  const sessionStore: KeyValueStorage | null = typeof __SPLITHUB_LITE__ === 'undefined' && adapter ? adapter.session ?? memoryStorage() : null;
  const kv = (kind: 'local' | 'session'): KeyValueStorage | null => (typeof __SPLITHUB_LITE__ === 'undefined' && adapter ? (kind === 'local' ? adapter.storage : sessionStore) : browser ? browserStorage(kind) : null);

  // Remote overrides: apply the cached copy synchronously, refresh in the background.
  // A first visit has no cache: wait briefly for the fresh copy instead, so a test
  // paused or started in the dashboard is right from the first page.
  const base = config;
  const publicKey = config.storage.mode === 'cloud' ? config.storage.key : undefined;
  let effective = config;
  let geo: RemoteOverrides['ctx'] | undefined;
  let waitFor: Promise<RemoteOverrides | null> | null = null;
  // The fresh overrides however late they come: they may declare the analytics property.
  let arriving: Promise<RemoteOverrides | null> | null = options.remote?.arriving ?? null;
  if (options.remote?.overrides) {
    effective = applyRemoteOverrides(config, options.remote.overrides);
    geo = options.remote.overrides.ctx;
  } else if (persistent && publicKey && !options.remote?.disabled) {
    // Apps have no file declaring the pushed experiments: they ask for those too (`all`), cached apart.
    // Websites keep the plain answer, the one sh.js and every other web client shares.
    const all = app;
    const cached = readRemoteCache(publicKey, adapter?.storage, all);
    if (cached) {
      effective = applyRemoteOverrides(config, cached.overrides);
      geo = cached.overrides.ctx;
      debugLog('remote', `overrides v${cached.overrides.version} from cache (${Math.round((Date.now() - cached.fetchedAt) / 1000)} s old)`, { experiments: cached.overrides.experiments });
    }
    const stale = !cached || Date.now() - cached.fetchedAt > (options.remote?.ttlMs ?? REMOTE_TTL_MS);
    if (stale) {
      const url = options.remote?.url ?? resolveOverridesUrl(config.storage.endpoint ?? CLOUD_ENDPOINT, publicKey, all);
      const fetched = fetchRemoteOverrides(url).then((fresh) => {
        if (fresh) writeRemoteCache(publicKey, fresh, adapter?.storage, all);
        return fresh;
      });
      arriving = fetched;
      // `overrides: null` from the server (Next.js) means the HTML already follows the
      // file: waiting would make the first client render disagree with it.
      const waitMs = options.remote?.waitMs ?? REMOTE_WAIT_MS;
      if (!cached && waitMs > 0 && options.remote?.overrides === undefined) waitFor = withTimeout(fetched, waitMs);
      else {
        void fetched.then((fresh) => {
          if (fresh) debugLog('remote', `fresh overrides v${fresh.version} fetched; applied on the next page load`, { experiments: fresh.experiments });
        });
      }
    }
  }
  config = effective;

  const hadVisitor = persistent && !options.visitorId ? (typeof __SPLITHUB_LITE__ === 'undefined' && adapter ? safeGet(adapter.storage, config.visitorKey) !== null : hasVisitorId(config.visitorKey)) : undefined;
  const visitorId = options.visitorId ?? (typeof __SPLITHUB_LITE__ === 'undefined' && adapter ? getOrCreateStoredId(adapter.storage, config.visitorKey, newVisitorId) : browser ? getOrCreateVisitorId(config.visitorKey) : 'server');
  // On the server without the visitor's id, any variant would be a guess the browser then
  // contradicts; the control is the stable answer until the id is passed in.
  const noVisitor = !persistent && !options.visitorId;
  // On the server each visitor gets a session id of their own, so the cloud never merges
  // the visits of different visitors that share one server.
  let sessionId = options.sessionId ?? (typeof __SPLITHUB_LITE__ === 'undefined' && adapter ? getOrCreateStoredId(sessionStore, SESSION_KEY, newSessionId) : browser ? getOrCreateSessionId() : options.visitorId ? `srv_${murmur3(options.visitorId).toString(36)}` : 'server');
  // In the browser the device's own time zone beats the one guessed from the IP.
  const contextFor = (g: RemoteOverrides['ctx'] | undefined): TargetingContext => {
    if (typeof __SPLITHUB_LITE__ === 'undefined' && adapter) return { ...stripUndefined(g ?? {}), ...appContext(adapter), ...(hadVisitor === undefined ? {} : { visitor: hadVisitor ? 'returning' : 'new' }), ...(options.context ?? {}) };
    if (!browser) return { ...(g ?? {}), ...(options.context ?? {}) };
    const forPage = g?.timezone ? { ...g, timezone: undefined } : g;
    return browserContext({ ...stripUndefined(forPage ?? {}), ...(hadVisitor === undefined ? {} : { visitor: hadVisitor ? 'returning' : 'new' }), ...(options.context ?? {}) });
  };
  let context = contextFor(geo);
  // Crawlers and headless browsers get the control (see assign) and send nothing.
  const isBot = (): boolean => context.device === 'bot';
  const overrides = {
    ...(browser ? parseForceParam(location.search) : {}),
    ...(options.overrides ?? {}),
  };
  for (const [key, forced] of Object.entries(overrides)) {
    const experiment = config.experiments.find((e) => e.key === key);
    if (experiment && !experiment.variants.some((v) => v.key === forced)) {
      warn(`sh_force asks for variant "${forced}" of "${key}", which has ${experiment.variants.map((v) => `"${v.key}"`).join(', ')}; showing the control, not counted.`);
    }
  }
  const disabled = options.disabled ?? (!persistent && !options.transport);
  // The cloud refuses a project with nothing running (429) and drops exposures of drafts.
  // Sending them anyway only fills the console with errors, so they stay local (and visible in debug mode).
  const cloud = config.storage.mode === 'cloud';
  const cloudIdle = (): boolean => cloud && !config.experiments.some((e) => e.status === 'running') && !(config.properties ?? []).some((p) => p.status === 'running');
  // The analytics property events go to, resolved against the live config (the dashboard may add or pause one).
  // Property ids are lowercase; a pasted id with spaces or capitals still works.
  const wanted = typeof options.property === 'string' ? options.property.trim().toLowerCase() || null : null;
  // Analytics follow the freshest overrides, even ones that arrive after the experiments were decided:
  // events are not variants, so a property made in the dashboard counts from the first page.
  let propConfig = config;
  const known = (): boolean => wanted !== null && pickProperty(propConfig, wanted) !== null;
  const property = (): string | null => {
    if (!wanted) return null;
    const p = pickProperty(propConfig, wanted);
    return p && p.status === 'running' ? p.key : null;
  };
  // Tests are running in the config from the start, so `next dev` / `vite` would count the
  // developer as a visitor. Development never sends to the cloud; `vite preview` or a deploy does.
  const devLocal = cloud && isDevEnvironment();
  const held = new Set<string>();
  const hold = (key: string, kind: 'exposure' | 'goal' | 'pageview', message: string): void => {
    if (held.has(key)) return;
    held.add(key);
    debugLog(kind, message);
  };

  const transport = options.transport ?? createFetchTransport({
    ...resolveEndpoint(config),
    keyInQuery: options.keyInQuery ?? (config.storage.mode === 'cloud' && !config.storage.endpoint),
    keepalive: !app,
  });
  const queue = new EventQueue({
    project: config.project,
    sdk: options.sdk ?? `core/${SDK_VERSION}`,
    transport,
    onError: options.onError,
    ...(typeof __SPLITHUB_LITE__ === 'undefined' && adapter ? { storage: adapter.storage, ...(adapter.app ? { app: adapter.app } : {}) } : {}),
  });
  const exposed = browser ? sessionExposureSet() : typeof __SPLITHUB_LITE__ === 'undefined' && adapter ? storedSet(sessionStore, EXPOSED_KEY) : new Set<string>();
  const saveExposed = (): void => {
    if (browser) persistExposureSet(exposed);
    else if (typeof __SPLITHUB_LITE__ === 'undefined' && adapter) safeSet(sessionStore, EXPOSED_KEY, JSON.stringify([...exposed]));
  };

  // Apps: the screen on show, set by screen(); it is the `url` of goals and events.
  let screenUrl: string | null = null;
  let screenTitle = '';
  const currentUrl = (): string | undefined =>
    browser ? location.pathname + location.search : screenUrl ?? undefined;
  // Read once, on the first page this client sees: a redirect variant or a later route change
  // would otherwise report the site itself as the referrer.
  const entryRef = browser ? sessionReferrer() : undefined;
  const refField = entryRef === undefined ? {} : { ref: entryRef };

  // Holdout marker: one `__holdout` exposure per visitor (holdout or enrolled) the first time they reach a running test.
  const markHoldout = (ts: number): void => {
    const group = holdoutGroup(config, visitorId);
    if (!group || noVisitor) return;
    const dedupKey = `${HOLDOUT_KEY}:${group}`;
    if (exposed.has(dedupKey)) return;
    if (devLocal) {
      hold(`x:${HOLDOUT_KEY}`, 'exposure', `${HOLDOUT_KEY} / ${group} not sent: development never sends to the cloud`);
      return;
    }
    exposed.add(dedupKey);
    saveExposed();
    const event = { id: newId('e_'), type: 'exposure' as const, exp: HOLDOUT_KEY, var: group, vid: visitorId, sid: sessionId, ts, url: currentUrl(), ...refField };
    debugLog('exposure', `${HOLDOUT_KEY} / ${group} recorded`, event);
    queue.push(event);
  };

  // While pending, exposures wait here with the time they happened (events wait on `ready`), so a
  // goal on the first page still counts (the cloud needs exposure time <= goal time).
  let pending = waitFor !== null;
  const waiting: Array<{ exp: string; ts: number }> = [];
  const listeners = new Set<() => void>();

  const sendExposure = (experimentKey: string, ts: number): void => {
    const a = client.assignment(experimentKey);
    if (config.holdout && countsForHoldout(a)) markHoldout(ts);
    if (!a.variant || a.reason === 'override') return;
    if (typeof __SPLITHUB_LITE__ === 'undefined' && devLocal) {
      devNote('dev-events', DEV_NOTE);
      hold(`x:${experimentKey}`, 'exposure', `${experimentKey} / ${a.variant.key} not sent: development never sends to the cloud`);
      return;
    }
    const dedupKey = `${experimentKey}:${a.variant.key}`;
    if (exposed.has(dedupKey)) return;
    exposed.add(dedupKey);
    saveExposed();
    const event = { id: newId('e_'), type: 'exposure' as const, exp: experimentKey, var: a.variant.key, vid: visitorId, sid: sessionId, ts, url: currentUrl(), ...refField };
    debugLog('exposure', `${experimentKey} / ${a.variant.key} recorded`, event);
    queue.push(event);
  };

  const sendGoal = (name: string, props: Record<string, unknown> | undefined, ts: number): void => {
    // The overrides' geo may only now say this is a crawler.
    if (isBot()) return;
    // Resolved now, not when tracked: the overrides may have brought goals from the dashboard.
    // A name without a usable key goes out as an event only (an invalid key would cost the whole batch).
    const goal = goalKeyFor(config.goals, name);
    if (!goal) return;
    if (typeof __SPLITHUB_LITE__ === 'undefined' && devLocal) {
      devNote('dev-events', DEV_NOTE);
      hold(`g:${goal}`, 'goal', `${goal} not sent: development never sends to the cloud`);
      return;
    }
    if (cloudIdle()) {
      hold(`g:${goal}`, 'goal', `${goal} not sent: no experiment is running in this project yet`);
      return;
    }
    const event = { id: newId('g_'), type: 'goal' as const, goal, vid: visitorId, sid: sessionId, ts, url: currentUrl(), ...(props ? { props } : {}) };
    debugLog('goal', `${goal}${props ? ' ' + JSON.stringify(props) : ''}`, event);
    queue.push(event);
  };

  // Analytics wait while overrides that may declare the property are on their way; without
  // that, a first visit to a property made in the dashboard would lose its landing page.
  let propertyFetch: Promise<void> | null = null;
  const propertyWaiting: Array<() => void> = [];
  const warnUnknownProperty = (): void => {
    if (wanted && !known() && (isDevEnvironment() || isDebug())) {
      warn(`property "${wanted}" is not in splithub.config.ts or the dashboard, so no pageviews or events are sent. Check the id (it looks like sh-x1h78w).`);
    }
  };
  const withProperty = (send: () => void): void => {
    if (!wanted) return;
    if (!known() && propertyFetch) {
      propertyWaiting.push(send);
      return;
    }
    send();
  };

  // Hash routers keep the route after `#/`; that route is the page.
  const hashRoute = (): string | null => {
    if (!browser || options.trackHash === false) return null;
    const hash = location.hash;
    const route = hash.startsWith('#/') ? hash.slice(1) : hash.startsWith('#!/') ? hash.slice(2) : null;
    if (route === null || (options.trackHash !== true && location.pathname !== '/')) return null;
    return route.includes('?') || !location.search ? route : route + location.search;
  };
  const pageUrl = (): string => hashRoute() ?? location.pathname + location.search;
  const pagePath = (): string => hashRoute()?.split('?')[0] ?? location.pathname;

  // Engagement: visible time and deepest scroll of the current page, sent as `engage` when the
  // visitor moves on (route change) or leaves (page hidden, by beacon).
  let engage: { prop: string; url: string; ms: number; since: number | null; scroll: number } | null = null;
  // Apps: in the foreground. Engagement on an app is time on screen.
  let appVisible = true;
  const pageVisible = (): boolean => (app ? appVisible : typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const scrollDepth = (): number => {
    if (!browser) return 0;
    const doc = document.documentElement;
    const height = Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0);
    const seen = (window.scrollY || doc.scrollTop || 0) + window.innerHeight;
    if (!height || seen >= height) return 100;
    return Math.max(0, Math.min(100, Math.round((seen / height) * 100)));
  };
  /** Queues the engaged time so far; `final` ends the page. True when something was queued. */
  const emitEngage = (final: boolean): boolean => {
    const e = engage;
    if (!e) return false;
    const now = Date.now();
    const ms = Math.min(MAX_ENGAGE_MS, Math.round(e.ms + (e.since !== null ? now - e.since : 0)));
    e.ms = 0;
    e.since = !final && pageVisible() ? now : null;
    if (final) engage = null;
    if (ms <= 0 || isBot()) return false;
    const event = { id: newId('n_'), type: 'engage' as const, prop: e.prop, vid: visitorId, sid: sessionId, ts: now, url: e.url, ms, scroll: e.scroll };
    debugLog('pageview', `${e.prop}: ${e.url} engaged ${Math.round(ms / 1000)} s, scrolled ${e.scroll}%`, event);
    queue.push(event);
    return true;
  };

  // Identify: the app's user id, sent once per session for each id and traits.
  let sentIdentity: string | null = safeGet(kv('session'), UID_SENT_KEY);
  const sendIdentify = (uid: string, traits: Record<string, string | number | boolean> | undefined, ts: number): void => {
    if (!wanted || isBot() || noVisitor) return;
    const mark = `${uid}\n${traits ? JSON.stringify(traits) : ''}`;
    withProperty(() => {
      const prop = property();
      // Another client on the page shares the session mark: the same identity goes out once.
      if (!prop || isBot() || sentIdentity === mark || safeGet(kv('session'), UID_SENT_KEY) === mark) return;
      if (typeof __SPLITHUB_LITE__ === 'undefined' && devLocal) {
        hold(`i:${prop}`, 'pageview', `${prop}: identify not sent: development never sends to the cloud`);
        return;
      }
      sentIdentity = mark;
      safeSet(kv('session'), UID_SENT_KEY, mark);
      const event = { id: newId('i_'), type: 'identify' as const, prop, vid: visitorId, sid: sessionId, ts, uid, ...(traits ? { traits } : {}) };
      debugLog('info', `${prop}: identify ${uid}`, event);
      queue.push(event);
    });
  };
  // A returning user's id goes out once in each new session, with its first page.
  const resendIdentity = (ts: number): void => {
    const uid = safeGet(kv('local'), UID_KEY);
    if (uid && !(sentIdentity ?? '').startsWith(`${uid}\n`)) sendIdentify(uid, undefined, ts);
  };

  // Pageview goals of a path, as goal rows: only when no `page` row carries them (the ingest
  // turns a page row into the conversions of the pageview goals it matches).
  const sendPageGoals = (path: string, ts: number): void => {
    if (isBot()) return;
    for (const goal of config.goals) {
      if (goal.type === 'pageview' && goal.path && matchPath(goal.path, path)) {
        debugLog('pageview', `${path} matches goal ${goal.key}`);
        sendGoal(goal.key, undefined, ts);
      }
    }
  };

  // Another client on this page (sh.js, a second provider) may already collect this property:
  // then this one sends no pageviews, time on page or identify of its own.
  const endpointKey = resolveEndpoint(config).endpoint;
  const owner = {};
  const claimed = new Set<string>();
  const collects = (prop: string): boolean => {
    if (claimAnalytics(`${endpointKey}|${prop}`, owner)) {
      claimed.add(prop);
      return true;
    }
    if (typeof __SPLITHUB_LITE__ === 'undefined') devNote(`shared:${prop}`, `Another SplitHub script on this page already collects pageviews for "${prop}", so this one leaves them to it. Keep one install per property: the SDK or sh.js.`);
    hold(`s:${prop}`, 'pageview', `${prop}: pageviews left to the other SplitHub script on this page`);
    return false;
  };

  // Analytics: pageviews and events for the property. The provider and a route hook may report
  // the same page twice in a row (StrictMode mounts twice); one view per URL per second is kept.
  let lastPage: { url: string; ts: number } | null = null;
  const sendPage = (path: string, ts: number, screen?: string): void => {
    if (isBot()) return;
    if (!wanted || noVisitor) {
      sendPageGoals(path, ts);
      return;
    }
    // Read the page now: by the time the property is known the visitor may be elsewhere.
    const url = browser && path === pagePath() ? pageUrl() : path;
    const title = screen !== undefined ? screen.slice(0, 200) : browser && typeof document !== 'undefined' ? document.title.slice(0, 200) : '';
    const ref = browser && typeof document !== 'undefined' ? document.referrer.slice(0, 512) : '';
    withProperty(() => {
      const prop = property();
      if (isBot()) return;
      if (!prop) {
        sendPageGoals(path, ts);
        return;
      }
      if (lastPage && lastPage.url === url && ts - lastPage.ts < 1000) return;
      lastPage = { url, ts };
      if (typeof __SPLITHUB_LITE__ === 'undefined' && devLocal) {
        devNote('dev-events', DEV_NOTE);
        hold(`p:${prop}`, 'pageview', `${prop}: pageviews not sent: development never sends to the cloud`);
        return;
      }
      if (!collects(prop)) return;
      emitEngage(true);
      const event = { id: newId('p_'), type: 'page' as const, prop, vid: visitorId, sid: sessionId, ts, url, ...(title ? { title } : {}), ...(ref ? { ref } : {}) };
      debugLog('pageview', `${prop}: ${url}`, event);
      queue.push(event);
      if (persistent) engage = { prop, url, ms: 0, since: pageVisible() ? ts : null, scroll: scrollDepth() };
      resendIdentity(ts);
    });
  };
  // track(): one row. With a running property the `event` row, which the ingest also turns into the
  // conversion of the experiments whose goal it is; without one, the goal row.
  const sendTracked = (name: string, props: Record<string, unknown> | undefined, ts: number): void => {
    if (isBot()) return;
    if (!wanted || noVisitor) {
      sendGoal(name, props, ts);
      return;
    }
    if (!EVENT_NAME_PATTERN.test(name)) {
      warn(`event name "${name}" is invalid: letters, digits, spaces and "_ . : / -", up to 64 characters.`);
      sendGoal(name, props, ts);
      return;
    }
    const url = currentUrl();
    withProperty(() => {
      const prop = property();
      if (isBot()) return;
      if (!prop) {
        sendGoal(name, props, ts);
        return;
      }
      if (typeof __SPLITHUB_LITE__ === 'undefined' && devLocal) {
        hold(`v:${prop}:${name}`, 'goal', `${prop}: event ${name} not sent: development never sends to the cloud`);
        return;
      }
      const event = { id: newId('v_'), type: 'event' as const, prop, name, vid: visitorId, sid: sessionId, ts, url, ...(props ? { props } : {}) };
      debugLog('goal', `${prop}: event ${name}${props ? ' ' + JSON.stringify(props) : ''}`, event);
      queue.push(event);
    });
  };

  const emit = (name: string, props: Record<string, unknown> | undefined): void => {
    if (disabled || isBot()) return;
    bindApp();
    const ts = Date.now();
    props = fitProps(props, `event "${name}"`);
    // After the ready handler has sent the waiting exposures: a goal only converts a visitor already in the experiment.
    if (pending) void ready.then(() => sendTracked(name, props, ts));
    else sendTracked(name, props, ts);
  };

  // Client-side navigations as pageviews, bound on the first pageview() and released by destroy().
  // A new path, query or hash route is a new page.
  let unwatch: (() => void) | null = null;
  const watch = (): void => {
    if (unwatch || !browser || options.trackNavigation === false) return;
    let last = pageUrl();
    unwatch = onNavigation(() => {
      const now = pageUrl();
      if (now === last) return;
      last = now;
      client.pageview();
    });
  };

  // Page listeners of a property: engagement (scroll, hide) and the automatic link events.
  let unbindPage: (() => void) | null = null;
  const bindPage = (): void => {
    if (unbindPage || !browser || !wanted || disabled) return;
    const onScroll = (): void => {
      if (engage) engage.scroll = Math.max(engage.scroll, scrollDepth());
    };
    const leave = (): void => {
      if (emitEngage(false)) void queue.flush(true);
      if (engage) engage.since = null;
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') leave();
      else if (engage && engage.since === null) engage.since = Date.now();
    };
    const onShow = (): void => {
      if (engage && engage.since === null && pageVisible()) engage.since = Date.now();
    };
    addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    addEventListener('pagehide', leave);
    addEventListener('pageshow', onShow);
    unbindPage = () => {
      removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onVisibility);
      removeEventListener('pagehide', leave);
      removeEventListener('pageshow', onShow);
    };
  };

  // Apps: background closes the screen's engagement and sends the queue; coming back after
  // 30 minutes starts a new session, which opens with the screen on show.
  let unbindApp: (() => void) | null = null;
  let backgroundAt: number | null = null;
  const rotateSession = (now: number): void => {
    if (!(typeof __SPLITHUB_LITE__ === 'undefined')) return;
    sessionId = newSessionId();
    safeSet(sessionStore, SESSION_KEY, sessionId);
    sentIdentity = null;
    safeSet(sessionStore, UID_SENT_KEY, null);
    lastPage = null;
    debugLog('info', `new session ${sessionId} after the app was away`);
    if (screenUrl && !pending) sendPage(screenUrl, now, screenTitle);
  };
  const bindApp = (): void => {
    if (!(typeof __SPLITHUB_LITE__ === 'undefined') || !adapter || unbindApp || disabled) return;
    const offBackground = adapter.onBackground?.(() => {
      if (backgroundAt !== null) return;
      backgroundAt = Date.now();
      appVisible = false;
      emitEngage(false);
      void queue.flush(false);
    });
    const offForeground = adapter.onForeground?.(() => {
      const now = Date.now();
      const away = backgroundAt === null ? 0 : now - backgroundAt;
      backgroundAt = null;
      appVisible = true;
      if (away >= SESSION_GAP_MS && !options.sessionId) rotateSession(now);
      if (engage && engage.since === null) engage.since = now;
    });
    unbindApp = () => {
      offBackground?.();
      offForeground?.();
    };
  };

  const ready: Promise<void> = waitFor
    ? waitFor.then((fresh) => {
        if (fresh) {
          config = applyRemoteOverrides(base, fresh);
          propConfig = config;
          context = contextFor(fresh.ctx);
          debugLog('remote', `first visit: overrides v${fresh.version} arrived, experiments decided`, { experiments: fresh.experiments });
        } else {
          debugLog('remote', 'first visit: overrides did not arrive in time; experiments follow splithub.config.ts');
        }
        pending = false;
        // Exposures first: a goal only converts a visitor already in the test.
        for (const w of waiting) sendExposure(w.exp, w.ts);
        waiting.length = 0;
        for (const listener of [...listeners]) listener();
        listeners.clear();
      })
    : Promise.resolve();

  if (wanted && !known()) {
    if (arriving) {
      propertyFetch = withTimeout(arriving, PROPERTY_WAIT_MS).then((fresh) => {
        if (fresh) propConfig = applyRemoteOverrides(base, fresh);
        propertyFetch = null;
        warnUnknownProperty();
        for (const send of propertyWaiting.splice(0)) send();
      });
    } else warnUnknownProperty();
  }

  const decided = new Set<string>();
  const client: SplitHubClient = {
    get config() {
      return config;
    },
    visitorId,
    get sessionId() {
      return sessionId;
    },
    get context() {
      return context;
    },
    get pending() {
      return pending;
    },
    ready,
    subscribe(listener) {
      if (!pending) return () => undefined;
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    assignment(experimentKey) {
      if (pending) return { experiment: experimentKey, variant: null, reason: 'pending' };
      let a = assign(config, experimentKey, visitorId, { overrides, context });
      if (noVisitor && a.variant && a.reason !== 'override') a = { experiment: experimentKey, variant: null, reason: 'no_visitor' };
      if (typeof __SPLITHUB_LITE__ === 'undefined') explainAssignment(getExperiment(config, experimentKey), a);
      if (isDebug() && !decided.has(experimentKey)) {
        decided.add(experimentKey);
        const exp = getExperiment(config, experimentKey);
        debugLog('assign', `${experimentKey} → ${a.variant?.key ?? 'control (no variant)'} · ${a.reason}`, { kind: exp?.kind, status: exp?.status, traffic: exp?.traffic, flow: Boolean(exp?.flow), ...(a.variant?.value !== undefined && a.variant?.value !== null ? { value: a.variant.value } : {}), ...(a.variant?.to ? { to: a.variant.to } : {}) });
      }
      return a;
    },

    exposure(experimentKey) {
      if (disabled) return;
      if (pending) {
        if (!waiting.some((w) => w.exp === experimentKey)) waiting.push({ exp: experimentKey, ts: Date.now() });
        return;
      }
      sendExposure(experimentKey, Date.now());
    },

    variant(experimentKey) {
      const experiment = getExperiment(config, experimentKey);
      if (!experiment) {
        warnUnknown(experimentKey);
        return 'control';
      }
      const a = client.assignment(experimentKey);
      client.exposure(experimentKey);
      return (a.variant ?? experiment.variants[0]!).key;
    },

    value<T>(experimentKey: string): T {
      const experiment = getExperiment(config, experimentKey);
      if (!experiment) {
        warnUnknown(experimentKey);
        return undefined as T;
      }
      const a = client.assignment(experimentKey);
      client.exposure(experimentKey);
      return (a.variant ?? experiment.variants[0]!).value as T;
    },

    track(name, props) {
      emit(name, props);
    },

    pageview(path) {
      const current = path ?? (browser ? pagePath() : undefined);
      if (!current) return;
      if (path === undefined) watch();
      bindPage();
      if (disabled) return;
      // Pageview goals may be declared in the dashboard: match them once the overrides are in.
      if (pending) {
        const ts = Date.now();
        void ready.then(() => sendPage(current, ts));
        return;
      }
      sendPage(current, Date.now());
    },

    screen(name) {
      // sh.js does not expose screen(): its pageviews follow the page.
      if (!(typeof __SPLITHUB_LITE__ === 'undefined')) return;
      const label = typeof name === 'string' ? name.trim() : '';
      if (!label) {
        warn('screen() needs the name of the screen.');
        return;
      }
      const url = label.startsWith('/') ? label : `/${label}`;
      if (app) {
        screenUrl = url;
        screenTitle = label;
      }
      bindApp();
      if (disabled) return;
      const ts = Date.now();
      if (pending) {
        void ready.then(() => sendPage(url, ts, label));
        return;
      }
      sendPage(url, ts, label);
    },

    identify(uid, traits) {
      if (uid === null) {
        safeSet(kv('local'), UID_KEY, null);
        safeSet(kv('session'), UID_SENT_KEY, null);
        sentIdentity = null;
        return;
      }
      const id = typeof uid === 'string' ? uid.trim() : '';
      if (!id || id.length > 128) {
        warn('identify() needs a user id of 1 to 128 characters.');
        return;
      }
      safeSet(kv('local'), UID_KEY, id);
      if (disabled || isBot()) return;
      sendIdentify(id, cleanTraits(traits), Date.now());
    },

    autoGoals(root) {
      if (!browser) return () => undefined;
      const clickGoals = config.goals.filter((g) => g.type === 'click' && g.selector);
      if (clickGoals.length === 0) return () => undefined;
      const target: Document | HTMLElement = root ?? document;
      const onClick = (ev: Event) => {
        const el = ev.target as Element | null;
        if (!el || typeof el.closest !== 'function') return;
        for (const g of clickGoals) {
          try {
            if (el.closest(g.selector!)) client.track(g.key);
          } catch {
            // invalid selector: ignore
          }
        }
      };
      target.addEventListener('click', onClick, true);
      return () => target.removeEventListener('click', onClick, true);
    },

    flush: () => queue.flush(false),
    resume: () => bindApp(),
    // Unbinds the page listeners; pending events are kept and a later event binds again,
    // so a provider may destroy on unmount even under StrictMode's double mount.
    destroy: () => {
      queue.destroy();
      unwatch?.();
      unwatch = null;
      unbindPage?.();
      unbindPage = null;
      unbindApp?.();
      unbindApp = null;
      for (const prop of claimed) releaseAnalytics(`${endpointKey}|${prop}`, owner);
      claimed.clear();
    },
  };

  bindApp();
  if (browser && isDebug()) {
    (window as unknown as { __splithub?: SplitHubClient }).__splithub = client;
    debugLog('info', `client ready · ${config.experiments.length} experiments · visitor ${visitorId} · ${config.storage.mode} mode`, { context });
  }
  return client;
}

// One wrap of history for every client on the page; each client listens while it lives.
const navListeners = new Set<() => void>();
let historyWrapped = false;
function onNavigation(listener: () => void): () => void {
  if (!historyWrapped && typeof history !== 'undefined') {
    historyWrapped = true;
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
        const out = original.apply(this, args);
        // After the router has rendered the new page, so its title is current.
        setTimeout(() => navListeners.forEach((l) => l()), 0);
        return out;
      };
    }
    addEventListener('popstate', () => navListeners.forEach((l) => l()));
    addEventListener('hashchange', () => navListeners.forEach((l) => l()));
  }
  navListeners.add(listener);
  return () => void navListeners.delete(listener);
}

/** Browser storage as a KeyValueStorage, silent when blocked. */
function browserStorage(kind: 'local' | 'session'): KeyValueStorage {
  const area = kind === 'local' ? 'localStorage' : 'sessionStorage';
  return {
    getItem: (k) => readStored(area, k),
    setItem: (k, v) => writeStored(area, k, v),
    removeItem: (k) => writeStored(area, k, null),
  };
}

function storedSet(storage: KeyValueStorage | null, key: string): Set<string> {
  try {
    const raw = safeGet(storage, key);
    const list = raw ? (JSON.parse(raw) as unknown) : null;
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** An app's targeting context: what the adapter says, with platform, version and OS filled from `app`. */
function appContext(adapter: PlatformAdapter): TargetingContext {
  const info = adapter.app;
  return {
    ...(info ? { platform: info.platform, os: info.platform } : {}),
    ...(info?.version ? { appVersion: info.version } : {}),
    ...(info?.device ? { device: info.device } : {}),
    ...stripUndefined(adapter.context ?? {}),
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function withTimeout<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      }
    );
  });
}

/** Props as the ingest takes them: at most 4 KB of JSON. Larger ones keep `revenue` and the plain values that fit, with a warning. */
function fitProps(props: Record<string, unknown> | undefined, what: string): Record<string, unknown> | undefined {
  if (!props || typeof props !== 'object') return undefined;
  let json: string;
  try {
    json = JSON.stringify(props);
  } catch {
    warn(`${what}: props cannot be sent as JSON, so they were left out.`);
    return undefined;
  }
  if (json.length <= MAX_PROPS_BYTES) return props;
  const out: Record<string, unknown> = {};
  let size = 2;
  const entries = Object.entries(props).sort(([a], [b]) => (a === 'revenue' ? -1 : b === 'revenue' ? 1 : 0));
  for (const [key, value] of entries) {
    if (value !== null && typeof value === 'object') continue;
    const part = JSON.stringify({ [key]: value }).length - 1;
    if (size + part > MAX_PROPS_BYTES) continue;
    out[key] = value;
    size += part;
  }
  const kept = Object.keys(out);
  warn(`${what}: props are larger than 4 KB, so ${kept.length ? `only ${kept.join(', ')} went out` : 'none went out'}.`);
  return kept.length ? out : undefined;
}

/** Flat traits (text, numbers, true/false) up to 4 KB; anything else is left out. */
function cleanTraits(traits: Record<string, unknown> | undefined): Record<string, string | number | boolean> | undefined {
  if (!traits || typeof traits !== 'object') return undefined;
  const out: Record<string, string | number | boolean> = {};
  let size = 2;
  let skipped = false;
  for (const [key, value] of Object.entries(traits)) {
    const plain = typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
    if (!plain || key.length > 64) {
      if (value !== undefined) skipped = true;
      continue;
    }
    const v = typeof value === 'string' ? value.slice(0, 256) : value;
    const part = JSON.stringify({ [key]: v }).length - 1;
    if (size + part > MAX_PROPS_BYTES) {
      skipped = true;
      continue;
    }
    out[key] = v;
    size += part;
  }
  if (skipped) warn('identify(): traits keep text, numbers and true/false up to 4 KB; the rest was left out.');
  return Object.keys(out).length ? out : undefined;
}

const warned = new Set<string>();
function warn(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  if (typeof console !== 'undefined') console.warn(`[splithub] ${message}`);
}
function warnUnknown(key: string): void {
  warn(`experiment "${key}" is not in splithub.config.ts; rendering control.`);
}

export type { Experiment, Variant };
