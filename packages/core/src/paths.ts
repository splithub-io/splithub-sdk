// One path rule for pageview goals, redirect experiments in sh.js and the Next.js middleware,
// so a test that matches in one place matches in all of them.

/** `/pricing/` → `/pricing`; the root stays `/`. */
export function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') || '/' : path;
}

/**
 * `pattern` is an exact path (a trailing slash on either side is ignored) or a
 * prefix ending with `*` (`/blog/*` matches `/blog/a/b`).
 */
export function matchPath(pattern: string, pathname: string): boolean {
  if (pattern.endsWith('*')) return pathname.startsWith(pattern.slice(0, -1));
  return normalizePath(pattern) === normalizePath(pathname);
}

/**
 * Where a redirect variant sends the visitor: `to` resolved against the current
 * URL, with the current query merged in (the variant's own parameters win, so
 * `?utm_source` survives) and the current hash kept unless `to` has one.
 */
export function redirectTarget(to: string, currentHref: string): URL {
  const current = new URL(currentHref);
  const target = new URL(to, current);
  const own = new Set(target.searchParams.keys());
  current.searchParams.forEach((value, key) => {
    if (!own.has(key)) target.searchParams.append(key, value);
  });
  if (!target.hash) target.hash = current.hash;
  return target;
}

/**
 * Where a visit came from, as an exposure carries it: the referrer's origin only (never its path
 * or query), `''` for a visit with no referrer (direct), and `undefined` when it says nothing
 * about the source: a link from the same site, or a value that is not a URL.
 */
export function referrerOrigin(referrer: string | null | undefined, siteHost: string | null | undefined): string | undefined {
  if (!referrer) return '';
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const site = (siteHost ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
  if (!host || host === site) return undefined;
  // `android-app://com.google.android.gm` has no web origin; protocol + host keeps the app's name.
  return `${url.protocol}//${url.host}`.slice(0, 300);
}
