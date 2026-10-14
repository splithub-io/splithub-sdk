// Debug mode: `?sh_debug=1` on any page (remembered for the session) makes the
// SDK, the Next.js client and the drop-in script explain what they do: every
// assignment with its reason, every exposure and goal with the payload, the
// remote overrides they applied. Messages go to the console and to a
// `splithub:debug` window event, which the React devtools panel listens to.
//
//   ?sh_debug=1        log + panel
//   ?sh_debug=hold     the same, and redirect experiments log the target instead of navigating
//   ?sh_debug=0        off

const KEY = 'sh_debug';

export type DebugKind = 'assign' | 'exposure' | 'goal' | 'pageview' | 'remote' | 'redirect' | 'info';

export interface DebugEntry {
  kind: DebugKind;
  message: string;
  data?: Record<string, unknown>;
  at: number;
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** 'on' | 'hold' | null, reading the URL first (and remembering it), then the session. */
export function debugMode(): 'on' | 'hold' | null {
  if (typeof location === 'undefined') return null;
  const m = /[?&]sh_debug=([^&#]*)/.exec(location.search);
  const s = storage();
  if (m) {
    const v = decodeURIComponent(m[1] ?? '');
    const mode = v === '0' || v === 'off' || v === 'false' ? null : v === 'hold' ? 'hold' : 'on';
    try {
      if (mode) s?.setItem(KEY, mode);
      else s?.removeItem(KEY);
    } catch {
      // storage blocked
    }
    return mode;
  }
  const saved = s?.getItem(KEY);
  return saved === 'hold' ? 'hold' : saved ? 'on' : null;
}

export const isDebug = (): boolean => debugMode() !== null;

const STYLE: Record<DebugKind, string> = {
  assign: 'color:#34d399',
  exposure: 'color:#60a5fa',
  goal: 'color:#fbbf24',
  pageview: 'color:#a78bfa',
  remote: 'color:#f472b6',
  redirect: 'color:#fb923c',
  info: 'color:#a1a1aa',
};

export function debugLog(kind: DebugKind, message: string, data?: Record<string, unknown>): void {
  if (!isDebug()) return;
  const entry: DebugEntry = { kind, message, data, at: Date.now() };
  if (typeof console !== 'undefined') {
    if (data) console.log(`%c[splithub] ${kind}%c ${message}`, STYLE[kind], 'color:inherit', data);
    else console.log(`%c[splithub] ${kind}%c ${message}`, STYLE[kind], 'color:inherit');
  }
  if (typeof window !== 'undefined' && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('splithub:debug', { detail: entry }));
}

/** Subscribe to debug entries (the devtools panel). Returns an unsubscribe function. */
export function onDebug(listener: (e: DebugEntry) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (ev: Event) => listener((ev as CustomEvent<DebugEntry>).detail);
  window.addEventListener('splithub:debug', handler);
  return () => window.removeEventListener('splithub:debug', handler);
}
