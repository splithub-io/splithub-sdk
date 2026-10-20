// One page may run two SplitHub clients: sh.js and the SDK, or two providers. Both may name
// the same analytics property, and both would send every pageview, time on page and identify.
// The first client to collect a property for an endpoint owns it; the other skips page
// collection (its track() calls still go out, one row each). The registry sits on a global
// symbol so separate bundles (sh.js and the app's SDK) see the same one.

const REGISTRY = Symbol.for('splithub.analytics');

type Registry = Map<string, object>;

function registry(): Registry | null {
  if (typeof window === 'undefined') return null;
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (g[REGISTRY] ??= new Map());
}

/** True when `owner` collects `key` (endpoint + property) on this page: the first to ask, or the one that already does. */
export function claimAnalytics(key: string, owner: object): boolean {
  const r = registry();
  if (!r) return true;
  const held = r.get(key);
  if (held && held !== owner) return false;
  r.set(key, owner);
  return true;
}

/** Lets another client collect `key` (the owner was destroyed). */
export function releaseAnalytics(key: string, owner: object): void {
  const r = registry();
  if (r?.get(key) === owner) r.delete(key);
}

/** Forget every claim (tests). */
export function resetAnalyticsClaims(): void {
  registry()?.clear();
}
