import { assign, countsForHoldout, holdoutGroup, isDevEnvironment, parseForceParam } from './assignment';
import { debugLog, isDebug } from './debug';
import { devNote, explainAssignment } from './dev';
import { getExperiment, HOLDOUT_KEY, isSplitHubConfig } from './config';
import { EventQueue, createFetchTransport, type Transport } from './events';
import { newId } from './ids';
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
import { browserContext } from './targeting';
import type { Assignment, Experiment, SplitHubConfig, TargetingContext, Variant } from './types';
import {
  getOrCreateSessionId,
  getOrCreateVisitorId,
  hasVisitorId,
  isBrowser,
  persistExposureSet,
  sessionExposureSet,
} from './visitor';

// The drop-in script's build defines this as true, so `typeof` folds and the development
// notes (strings included) drop out of sh.js. It has to be written inline at each use:
// a constant imported from another module is inlined too late to remove the dead branch.
declare const __SPLITHUB_LITE__: true | undefined;

export const SDK_VERSION = '0.1.0';
/** First visit without cached overrides: the longest the client waits for them. The fetch usually takes ~150 ms. */
export const REMOTE_WAIT_MS = 400;
const DEV_NOTE = 'Development sends nothing to the cloud, so your own visits never reach the results. Deployed builds send as usual.';
export const CLOUD_ENDPOINT = 'https://go.splithub.io/v1/events';

export interface ClientOptions {
  /** Provide on the server (from the cookie) so SSR and client agree. */
  visitorId?: string;
  sessionId?: string;
  /** Custom transport, e.g. a no-op for tests or SSR. */
  transport?: Transport;
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
  };
  /**
   * Visitor context for targeting (country, device, UTM ...). In the browser it
   * is collected automatically and merged with the cloud's geo (`ctx` in the
   * overrides JSON); on the server pass what you know from the request.
   */
  context?: TargetingContext;
  onError?: (error: unknown) => void;
}

export interface SplitHubClient {
  readonly config: SplitHubConfig;
  readonly visitorId: string;
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
  track(goal: string, props?: Record<string, unknown>): void;
  /** Automatic pageview goals for the current URL. */
  pageview(path?: string): void;
  /** Bind click goals (`type: 'click'`, CSS selector) to the document. Returns an unbind function. No-op outside the browser. */
  autoGoals(root?: Document | HTMLElement): () => void;
  flush(): Promise<void>;
  destroy(): void;
}

function resolveEndpoint(config: SplitHubConfig): { endpoint: string; key?: string } {
  if (config.storage.mode === 'self') return { endpoint: config.storage.endpoint };
  return { endpoint: config.storage.endpoint ?? CLOUD_ENDPOINT, key: config.storage.key };
}

export function createClient(config: SplitHubConfig, options: ClientOptions = {}): SplitHubClient {
  if (!isSplitHubConfig(config)) {
    throw new Error('[splithub] pass the object returned by defineConfig() from splithub.config.ts');
  }

  const browser = isBrowser();

  // Remote overrides: apply the cached copy synchronously, refresh in the background.
  // A first visit has no cache: wait briefly for the fresh copy instead, so a test
  // paused or started in the dashboard is right from the first page.
  const base = config;
  const publicKey = config.storage.mode === 'cloud' ? config.storage.key : undefined;
  let effective = config;
  let geo: RemoteOverrides['ctx'] | undefined;
  let waitFor: Promise<RemoteOverrides | null> | null = null;
  if (options.remote?.overrides) {
    effective = applyRemoteOverrides(config, options.remote.overrides);
    geo = options.remote.overrides.ctx;
  } else if (browser && publicKey && !options.remote?.disabled) {
    const cached = readRemoteCache(publicKey);
    if (cached) {
      effective = applyRemoteOverrides(config, cached.overrides);
      geo = cached.overrides.ctx;
      debugLog('remote', `overrides v${cached.overrides.version} from cache (${Math.round((Date.now() - cached.fetchedAt) / 1000)} s old)`, { experiments: cached.overrides.experiments });
    }
    const stale = !cached || Date.now() - cached.fetchedAt > (options.remote?.ttlMs ?? REMOTE_TTL_MS);
    if (stale) {
      const url = options.remote?.url ?? resolveOverridesUrl(config.storage.endpoint ?? CLOUD_ENDPOINT, publicKey);
      const fetched = fetchRemoteOverrides(url).then((fresh) => {
        if (fresh) writeRemoteCache(publicKey, fresh);
        return fresh;
      });
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

  const hadVisitor = browser && !options.visitorId ? hasVisitorId(config.visitorKey) : undefined;
  const visitorId = options.visitorId ?? (browser ? getOrCreateVisitorId(config.visitorKey) : 'server');
  // On the server without the visitor's id, any variant would be a guess the browser then
  // contradicts; the control is the stable answer until the id is passed in.
  const noVisitor = !browser && !options.visitorId;
  const sessionId = options.sessionId ?? (browser ? getOrCreateSessionId() : 'server');
  // In the browser the device's own time zone beats the one guessed from the IP.
  const contextFor = (g: RemoteOverrides['ctx'] | undefined): TargetingContext => {
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
  const disabled = options.disabled ?? (!browser && !options.transport);
  // The cloud refuses a project with nothing running (429) and drops exposures of drafts.
  // Sending them anyway only fills the console with errors, so they stay local (and visible in debug mode).
  const cloud = config.storage.mode === 'cloud';
  const cloudIdle = (): boolean => cloud && !config.experiments.some((e) => e.status === 'running');
  // Tests are running in the config from the start, so `next dev` / `vite` would count the
  // developer as a visitor. Development never sends to the cloud; `vite preview` or a deploy does.
  const devLocal = cloud && isDevEnvironment();
  const held = new Set<string>();
  const hold = (key: string, kind: 'exposure' | 'goal', message: string): void => {
    if (held.has(key)) return;
    held.add(key);
    debugLog(kind, message);
  };

  const transport = options.transport ?? createFetchTransport({
    ...resolveEndpoint(config),
    keyInQuery: options.keyInQuery ?? (config.storage.mode === 'cloud' && !config.storage.endpoint),
  });
  const queue = new EventQueue({
    project: config.project,
    sdk: `core/${SDK_VERSION}`,
    transport,
    onError: options.onError,
  });
  const exposed = browser ? sessionExposureSet() : new Set<string>();

  const currentUrl = (): string | undefined =>
    browser ? location.pathname + location.search : undefined;

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
    if (browser) persistExposureSet(exposed);
    const event = { id: newId('e_'), type: 'exposure' as const, exp: HOLDOUT_KEY, var: group, vid: visitorId, sid: sessionId, ts, url: currentUrl() };
    debugLog('exposure', `${HOLDOUT_KEY} / ${group} recorded`, event);
    queue.push(event);
  };

  // While pending, exposures and goals wait here with the time they happened, so a
  // goal on the first page still counts (the cloud needs exposure time <= goal time).
  let pending = waitFor !== null;
  const waiting: Array<{ exp: string; ts: number } | { goal: string; props?: Record<string, unknown>; ts: number }> = [];
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
    if (browser) persistExposureSet(exposed);
    const event = { id: newId('e_'), type: 'exposure' as const, exp: experimentKey, var: a.variant.key, vid: visitorId, sid: sessionId, ts, url: currentUrl() };
    debugLog('exposure', `${experimentKey} / ${a.variant.key} recorded`, event);
    queue.push(event);
  };

  const sendGoal = (goal: string, props: Record<string, unknown> | undefined, ts: number): void => {
    // The overrides' geo may only now say this is a crawler.
    if (isBot()) return;
    if (!config.goals.some((g) => g.key === goal)) {
      warn(`goal "${goal}" is not declared in splithub.config.ts; sending anyway.`);
    }
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

  const ready: Promise<void> = waitFor
    ? waitFor.then((fresh) => {
        if (fresh) {
          config = applyRemoteOverrides(base, fresh);
          context = contextFor(fresh.ctx);
          debugLog('remote', `first visit: overrides v${fresh.version} arrived, experiments decided`, { experiments: fresh.experiments });
        } else {
          debugLog('remote', 'first visit: overrides did not arrive in time; experiments follow splithub.config.ts');
        }
        pending = false;
        // Exposures first: a goal only converts a visitor already in the test.
        for (const w of waiting) if ('exp' in w) sendExposure(w.exp, w.ts);
        for (const w of waiting) if ('goal' in w) sendGoal(w.goal, w.props, w.ts);
        waiting.length = 0;
        for (const listener of [...listeners]) listener();
        listeners.clear();
      })
    : Promise.resolve();

  const decided = new Set<string>();
  const client: SplitHubClient = {
    get config() {
      return config;
    },
    visitorId,
    sessionId,
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
        if (!waiting.some((w) => 'exp' in w && w.exp === experimentKey)) waiting.push({ exp: experimentKey, ts: Date.now() });
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

    track(goal, props) {
      if (disabled || isBot()) return;
      if (pending) waiting.push({ goal, ...(props ? { props } : {}), ts: Date.now() });
      else sendGoal(goal, props, Date.now());
    },

    pageview(path) {
      const current = path ?? (browser ? location.pathname : undefined);
      if (!current) return;
      // Pageview goals may be declared in the dashboard: match them once the overrides are in.
      if (pending) {
        const ts = Date.now();
        void ready.then(() => {
          if (disabled) return;
          for (const goal of config.goals) if (goal.type === 'pageview' && goal.path && matchPath(goal.path, current)) sendGoal(goal.key, undefined, ts);
        });
        return;
      }
      for (const goal of config.goals) {
        if (goal.type === 'pageview' && goal.path && matchPath(goal.path, current)) {
          debugLog('pageview', `${current} matches goal ${goal.key}`);
          client.track(goal.key);
        }
      }
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
    // Unbinds the page listeners; pending events are kept and a later event binds again,
    // so a provider may destroy on unmount even under StrictMode's double mount.
    destroy: () => queue.destroy(),
  };

  if (browser && isDebug()) {
    (window as unknown as { __splithub?: SplitHubClient }).__splithub = client;
    debugLog('info', `client ready · ${config.experiments.length} experiments · visitor ${visitorId} · ${config.storage.mode} mode`, { context });
  }
  return client;
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
