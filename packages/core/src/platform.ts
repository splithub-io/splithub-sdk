import type { AppInfo, TargetingContext } from './types';

/**
 * Synchronous key-value storage, so assignment stays synchronous. React Native preloads
 * AsyncStorage into memory or uses MMKV; native SDKs use UserDefaults / SharedPreferences.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * What an app gives the client instead of a browser page. With it the client is a persistent
 * client: no cookies, no `location` / `history` / `document`, no sendBeacon, and pageviews come
 * only from `screen()` calls.
 */
export interface PlatformAdapter {
  /** Persistent: visitor id, user id, the overrides cache and the offline queue. */
  storage: KeyValueStorage;
  /** Per launch: session id, exposures already sent. Defaults to an in-memory map. */
  session?: KeyValueStorage;
  /** Attached to every batch. */
  app?: AppInfo;
  /** Platform, appVersion, language, timezone, device, os. `platform` / `appVersion` default to `app`'s. */
  context?: TargetingContext;
  /** The app went to the background: the client flushes the queue and closes the screen's engagement. Returns an unsubscribe function. */
  onBackground?(cb: () => void): () => void;
  /** The app came back: after 30 minutes away a new session starts. Returns an unsubscribe function. */
  onForeground?(cb: () => void): () => void;
}

/** A storage that lives as long as the process: the default `session` of an adapter, and handy in tests. */
export function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

/** Reads without throwing: a storage that fails counts as empty. */
export function safeGet(storage: KeyValueStorage | null | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Writes (null removes) without throwing. */
export function safeSet(storage: KeyValueStorage | null | undefined, key: string, value: string | null): void {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {
    // storage full or unavailable
  }
}
