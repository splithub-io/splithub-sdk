import { newSessionId, newVisitorId } from './ids';
import { referrerOrigin } from './paths';
import { safeGet, safeSet, type KeyValueStorage } from './platform';

const ONE_YEAR = 60 * 60 * 24 * 365;

/** A web page. React Native has a `window` but no page (and `navigator.product` says so). */
export const isBrowser = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined' && !isReactNative();

/** React Native (Hermes or JSC): a `window` and a `navigator`, but no page. */
export const isReactNative = (): boolean => typeof navigator !== 'undefined' && navigator.product === 'ReactNative';

/** An id kept in an app's storage, made on first use. */
export function getOrCreateStoredId(storage: KeyValueStorage | null | undefined, key: string, make: () => string): string {
  const existing = safeGet(storage, key);
  if (existing) return existing;
  const id = make();
  safeSet(storage, key, id);
  return id;
}

function readCookie(name: string): string | null {
  if (!isBrowser()) return null;
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function writeCookie(name: string, value: string): void {
  if (!isBrowser()) return;
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${ONE_YEAR}; Path=/; SameSite=Lax${secure}`;
}

function safeStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    if (!isBrowser()) return null;
    const s = window[kind];
    const probe = '__sh_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/**
 * Visitor id lookup order: cookie → localStorage → new. The value is written
 * to both so that SSR (cookie) and SPA (localStorage) agree.
 */
/** True when a visitor id already exists (cookie or localStorage). */
export function hasVisitorId(key: string): boolean {
  return Boolean(readCookie(key) ?? safeStorage('localStorage')?.getItem(key));
}

export function getOrCreateVisitorId(key: string): string {
  const fromCookie = readCookie(key);
  const ls = safeStorage('localStorage');
  const fromStorage = ls?.getItem(key) ?? null;
  const id = fromCookie ?? fromStorage ?? newVisitorId();
  if (fromCookie !== id) writeCookie(key, id);
  if (fromStorage !== id) ls?.setItem(key, id);
  return id;
}

export function getOrCreateSessionId(key = 'sh_sid'): string {
  const ss = safeStorage('sessionStorage');
  const existing = ss?.getItem(key);
  if (existing) return existing;
  const id = newSessionId();
  ss?.setItem(key, id);
  return id;
}

/** Session-scoped exposure dedup so a reload does not re-send exposures. */
export function sessionExposureSet(key = 'sh_exposed'): Set<string> {
  const ss = safeStorage('sessionStorage');
  try {
    const raw = ss?.getItem(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function persistExposureSet(set: Set<string>, key = 'sh_exposed'): void {
  safeStorage('sessionStorage')?.setItem(key, JSON.stringify([...set]));
}

/** Reads a value from browser storage; null when absent or storage is blocked. */
export function readStored(kind: 'localStorage' | 'sessionStorage', key: string): string | null {
  try {
    return safeStorage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Writes (or, with null, removes) a value in browser storage; silent when storage is blocked. */
export function writeStored(kind: 'localStorage' | 'sessionStorage', key: string, value: string | null): void {
  try {
    const s = safeStorage(kind);
    if (value === null) s?.removeItem(key);
    else s?.setItem(key, value);
  } catch {
    // storage blocked
  }
}

/**
 * The referrer the visit (this tab's session) began with, as `referrerOrigin` reads it, kept in
 * sessionStorage so a later page of the same visit still knows it. `undefined` when the first page
 * we saw was reached from the same site (the SDK is not on the landing page) or storage is blocked
 * and this page came from the site itself.
 */
export function sessionReferrer(key = 'sh_ref'): string | undefined {
  if (!isBrowser()) return undefined;
  const stored = readStored('sessionStorage', key);
  if (stored !== null) return stored;
  const ref = referrerOrigin(document.referrer, location.host);
  if (ref !== undefined) writeStored('sessionStorage', key, ref);
  return ref;
}
