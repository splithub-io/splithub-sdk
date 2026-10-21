import type { KeyValueStorage } from './platform';
import type { Experiment, ExperimentStatus, Goal, Holdout, Property, PropertyStatus, SplitHubConfig, TargetingContext } from './types';

/**
 * Remote overrides let the dashboard, the CLI or an agent pause an experiment,
 * change traffic/weights or swap `value` payloads without a deploy. The
 * config file stays the source of truth for the next deploy; overrides are a
 * live patch on top of it.
 */
export interface ExperimentOverride {
  status?: ExperimentStatus;
  traffic?: number;
  /** Relative weights by variant key; unknown keys are ignored. */
  weights?: Record<string, number>;
  /** `value` payloads by variant key (value experiments only). */
  values?: Record<string, unknown>;
  seed?: string;
}

export interface RemoteOverrides {
  version: number;
  experiments: Record<string, ExperimentOverride>;
  /** Experiments created in the dashboard that are not in the config file yet (hosted config). */
  added?: Experiment[];
  /** Goals declared in the dashboard (hosted config). */
  goals?: Goal[];
  /** Analytics property status set from the dashboard or the CLI, by key. */
  properties?: Record<string, { status?: PropertyStatus }>;
  /** Analytics properties created in the dashboard that are not in the config file. */
  addedProperties?: Property[];
  /**
   * Holdout and layer seeds of the hosted config (sites on sh.js have no config file).
   * A config file's own `holdout` / `layers` win over these.
   */
  holdout?: Holdout | null;
  layers?: Record<string, { seed: string }>;
  /** What the cloud knows about this request: country, region, city. Per visitor. */
  ctx?: Pick<TargetingContext, 'country' | 'region' | 'city' | 'timezone'>;
}

export const EMPTY_OVERRIDES: RemoteOverrides = { version: 0, experiments: {} };

function applyToExperiment(experiment: Experiment, o: ExperimentOverride): Experiment {
  let variants = experiment.variants;
  if (o.weights) {
    const raw = variants.map((v) => ({ ...v, weight: Math.max(0, o.weights![v.key] ?? v.weight) }));
    const total = raw.reduce((s, v) => s + v.weight, 0);
    if (total > 0) variants = raw.map((v) => ({ ...v, weight: v.weight / total }));
  }
  if (o.values && experiment.kind === 'value') {
    variants = variants.map((v) => (v.key in o.values! ? { ...v, value: o.values![v.key] } : v));
  }
  return {
    ...experiment,
    status: o.status ?? experiment.status,
    traffic: o.traffic !== undefined && o.traffic >= 0 && o.traffic <= 1 ? o.traffic : experiment.traffic,
    seed: o.seed ?? experiment.seed,
    variants,
  };
}

/** Pure merge: returns a new config, never mutates the input. */
export function applyRemoteOverrides(config: SplitHubConfig, overrides: RemoteOverrides | null | undefined): SplitHubConfig {
  if (!overrides) return config;
  const patches = overrides.experiments ?? {};
  const known = new Set(config.experiments.map((e) => e.key));
  const added = (overrides.added ?? []).filter((e) => e && typeof e.key === 'string' && !known.has(e.key) && Array.isArray(e.variants) && e.variants.length >= 2);
  const knownGoals = new Set(config.goals.map((g) => g.key));
  const addedGoals = (overrides.goals ?? []).filter((g) => g && typeof g.key === 'string' && !knownGoals.has(g.key));
  const holdout = !config.holdout && validHoldout(overrides.holdout) ? overrides.holdout : null;
  const layers = overrides.layers && typeof overrides.layers === 'object' ? { ...overrides.layers, ...(config.layers ?? {}) } : null;
  const propertyPatches = overrides.properties ?? {};
  const knownProps = new Set((config.properties ?? []).map((p) => p.key));
  const addedProps = (overrides.addedProperties ?? []).filter((p) => p && typeof p.key === 'string' && !knownProps.has(p.key));
  const propsChanged = Object.keys(propertyPatches).length > 0 || addedProps.length > 0;
  if (Object.keys(patches).length === 0 && added.length === 0 && addedGoals.length === 0 && !holdout && !layers && !propsChanged) return config;
  const properties = propsChanged
    ? [...(config.properties ?? []), ...addedProps.map((p) => ({ ...p, goals: Array.isArray(p.goals) ? p.goals : [], origin: 'dashboard' as const }))].map((p) => {
        const status = propertyPatches[p.key]?.status;
        return status === 'running' || status === 'paused' ? { ...p, status } : p;
      })
    : config.properties;
  const merged = [...config.experiments, ...added.map((e) => ({ ...e, origin: 'dashboard' as const }))];
  return {
    ...config,
    ...(holdout ? { holdout } : {}),
    ...(layers ? { layers } : {}),
    goals: addedGoals.length ? [...config.goals, ...addedGoals] : config.goals,
    ...(properties ? { properties } : {}),
    experiments: merged.map((e) => {
      const o = patches[e.key];
      return o ? applyToExperiment(e, o) : e;
    }),
  };
}

function validHoldout(h: Holdout | null | undefined): h is Holdout {
  return Boolean(h) && typeof h!.percent === 'number' && h!.percent > 0 && h!.percent <= 50 && typeof h!.seed === 'string';
}

export function isRemoteOverrides(value: unknown): value is RemoteOverrides {
  return Boolean(value) && typeof value === 'object' && typeof (value as RemoteOverrides).version === 'number' && typeof (value as RemoteOverrides).experiments === 'object';
}

/**
 * `https://go.splithub.io/v1/events` → `https://go.splithub.io/v1/overrides/<pk>.json`.
 * `all` (apps: clients with a platform adapter) also asks for every experiment pushed from
 * `splithub.config.ts`: an app has no config file to learn them from. Websites never ask for it.
 */
export function resolveOverridesUrl(eventsEndpoint: string, publicKey: string, all = false): string {
  const base = eventsEndpoint.replace(/\/events\/?$/, '');
  return `${base}/overrides/${encodeURIComponent(publicKey)}.json${all ? '?all=1' : ''}`;
}

// ---------------------------------------------------------------------------
// Cache: overrides are applied synchronously from cache on page load or app launch
// (no flicker) and refreshed in the background for the next one. Apps pass their
// adapter's storage; experiments made in the dashboard (`added`) then reach an app
// without a release, and a launch with no network still has the last copy.
// ---------------------------------------------------------------------------

interface CacheEntry {
  fetchedAt: number;
  overrides: RemoteOverrides;
}

export const REMOTE_CACHE_KEY = 'sh_remote';
export const REMOTE_TTL_MS = 60_000;

function storage(custom?: KeyValueStorage | null): KeyValueStorage | null {
  if (custom) return custom;
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The cache key of one public key; `all` answers (apps) live apart, so sh.js and web clients never read them. */
export const remoteCacheKey = (publicKey: string, all = false): string => `${REMOTE_CACHE_KEY}:${publicKey}${all ? ':all' : ''}`;

export function readRemoteCache(publicKey: string, store?: KeyValueStorage | null, all = false): CacheEntry | null {
  try {
    const raw = storage(store)?.getItem(remoteCacheKey(publicKey, all));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    return isRemoteOverrides(parsed.overrides) && typeof parsed.fetchedAt === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeRemoteCache(publicKey: string, overrides: RemoteOverrides, store?: KeyValueStorage | null, all = false): void {
  try {
    storage(store)?.setItem(remoteCacheKey(publicKey, all), JSON.stringify({ fetchedAt: Date.now(), overrides } satisfies CacheEntry));
  } catch {
    // storage unavailable
  }
}

export async function fetchRemoteOverrides(url: string, fetchImpl: typeof fetch = fetch): Promise<RemoteOverrides | null> {
  try {
    const res = await fetchImpl(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return isRemoteOverrides(body) ? body : null;
  } catch {
    return null;
  }
}
