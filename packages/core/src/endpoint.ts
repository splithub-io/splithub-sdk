import { safeGet, safeSet, type KeyValueStorage } from './platform';
import { fetchRemoteOverridesFrom, resolveOverridesUrl, type RemoteOverrides } from './remote';

// The cloud's address can change after an app or a site has shipped (splithub.io lapsed in
// November 2026 and took every hard-coded `go.splithub.io` with it). So a client that talks
// to the cloud keeps a short list instead of one URL: the address the cloud last announced
// (`endpoint` in the overrides, remembered on the device), the built-in default, and a
// backup on workers.dev, which belongs to no domain that can lapse. A network failure moves
// to the next one; the overrides fetched there announce the current address again.

/** SplitHub Cloud's ingest. */
export const CLOUD_ENDPOINT = 'https://go.sh2.uk/v1/events';

/** Tried when the addresses before them cannot be reached. */
export const CLOUD_FALLBACK_ENDPOINTS: readonly string[] = ['https://splithub-go.adbro.workers.dev/v1/events'];

/** Earlier cloud addresses: a config or a script tag that still names one counts as the cloud. */
const PAST_CLOUD_ENDPOINTS: readonly string[] = ['https://go.splithub.io/v1/events'];

/** Where the announced address is kept (localStorage, or the app's storage). */
export const ENDPOINT_KEY = 'sh_endpoint';

const trim = (url: string): string => url.replace(/\/+$/, '');

/** An `https://…/v1/events` URL, the only shape the cloud may announce. */
export function isEndpointUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 200) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /\/v1\/events\/?$/.test(u.pathname) && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/**
 * `storage.endpoint` in cloud mode may be just a domain: `go.sh2.uk`, `https://go.sh2.uk` and
 * `https://go.sh2.uk/v1/events` are the same address. A URL with a path of its own is kept as written.
 */
export function normalizeCloudEndpoint(value: string): string {
  const v = value.trim();
  const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(url);
    if (u.pathname === '/' || u.pathname === '') return `${u.origin}/v1/events`;
  } catch {
    return v;
  }
  return url;
}

/** True for no endpoint at all (the default) and for any address the cloud has had. */
export function isCloudEndpoint(endpoint: string | undefined): boolean {
  if (endpoint === undefined) return true;
  const e = trim(endpoint);
  return [CLOUD_ENDPOINT, ...CLOUD_FALLBACK_ENDPOINTS, ...PAST_CLOUD_ENDPOINTS].some((c) => c === e);
}

/** The address remembered on this device, if the cloud announced one. */
export function rememberedEndpoint(store: KeyValueStorage | null | undefined): string | null {
  const v = safeGet(store ?? null, ENDPOINT_KEY);
  return isEndpointUrl(v) ? v : null;
}

/** Keeps an announced or a working address for the next page or launch. */
export function rememberEndpoint(store: KeyValueStorage | null | undefined, endpoint: string): void {
  if (!isEndpointUrl(endpoint) || rememberedEndpoint(store) === endpoint) return;
  safeSet(store ?? null, ENDPOINT_KEY, endpoint);
}

/**
 * Cloud addresses in the order to try them: remembered, configured, default, backups.
 * A past address (`go.splithub.io`) a config still names is skipped: it no longer answers.
 */
export function cloudEndpoints(store: KeyValueStorage | null | undefined, configured?: string): string[] {
  const own = configured && !PAST_CLOUD_ENDPOINTS.includes(trim(configured)) ? configured : null;
  const list = [rememberedEndpoint(store), own, CLOUD_ENDPOINT, ...CLOUD_FALLBACK_ENDPOINTS];
  const out: string[] = [];
  for (const e of list) if (e && !out.includes(trim(e))) out.push(trim(e));
  return out;
}

/** The page's localStorage, when there is one. */
export function browserLocalStorage(): KeyValueStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Overrides for a public key. On the cloud it tries each address in turn and remembers the one
 * that answered and the one the answer announces; a custom endpoint is asked once, as written.
 */
export async function fetchCloudOverrides(
  endpoint: string | undefined,
  key: string,
  options: { store?: KeyValueStorage | null; all?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<RemoteOverrides | null> {
  const list = isCloudEndpoint(endpoint) ? cloudEndpoints(options.store, endpoint) : [endpoint as string];
  const { overrides, answered } = await fetchRemoteOverridesFrom(list.map((e) => resolveOverridesUrl(e, key, options.all)), options.fetchImpl);
  if (isCloudEndpoint(endpoint)) {
    if (answered > 0) rememberEndpoint(options.store, list[answered]!);
    if (overrides && isEndpointUrl(overrides.endpoint)) rememberEndpoint(options.store, overrides.endpoint);
  }
  return overrides;
}
