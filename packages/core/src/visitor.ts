import { newSessionId, newVisitorId } from './ids';

const ONE_YEAR = 60 * 60 * 24 * 365;

export const isBrowser = (): boolean =>
  typeof window !== 'undefined' && typeof document !== 'undefined';

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
