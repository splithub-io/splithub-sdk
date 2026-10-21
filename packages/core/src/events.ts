import { safeGet, safeSet, type KeyValueStorage } from './platform';
import type { AppInfo, EventBatch, SplitHubEvent } from './types';
import { isBrowser } from './visitor';

/** What a transport throws when the ingest answers with an error status. */
export interface IngestError extends Error {
  status?: number;
  /** Seconds, from the `Retry-After` header. */
  retryAfter?: number;
  /** The body's `code` on a 429 (`quota_exceeded`, `deleted`, …). */
  code?: string;
}

export interface Transport {
  send(batch: EventBatch, options: { beacon: boolean }): Promise<void> | void;
}

export interface TransportOptions {
  endpoint: string;
  /** Sent as `Authorization: Bearer` (cloud public key). */
  key?: string;
  /**
   * Send the key as `?key=` so page-hide batches can use `navigator.sendBeacon`, which
   * cannot set headers. Only for endpoints that accept it; otherwise keyed batches use
   * `fetch(..., { keepalive: true })` on page hide, which also outlives the page.
   */
  keyInQuery?: boolean;
  /** `fetch(..., { keepalive })`; default true. Apps pass false: there is no page to outlive. */
  keepalive?: boolean;
}

function beaconUrl(options: TransportOptions): string | null {
  if (!options.key) return options.endpoint;
  if (!options.keyInQuery) return null;
  return `${options.endpoint}${options.endpoint.includes('?') ? '&' : '?'}key=${encodeURIComponent(options.key)}`;
}

/** Default transport: fetch with keepalive; sendBeacon on page hide when the endpoint allows it. */
export function createFetchTransport(options: TransportOptions): Transport {
  return {
    async send(batch, { beacon }) {
      const body = JSON.stringify(batch);
      const url = beacon && isBrowser() && typeof navigator.sendBeacon === 'function' ? beaconUrl(options) : null;
      if (url) {
        // A JSON content type is not CORS-safelisted, so a cross-origin beacon goes as text;
        // both ingest handlers parse the body whatever its type.
        let sameOrigin = false;
        try {
          sameOrigin = new URL(url, location.href).origin === location.origin;
        } catch {
          // relative or malformed: let fetch decide below
        }
        const blob = new Blob([body], { type: sameOrigin ? 'application/json' : 'text/plain;charset=UTF-8' });
        try {
          if (navigator.sendBeacon(url, blob)) return;
        } catch {
          // fall through to fetch
        }
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.key) headers.authorization = `Bearer ${options.key}`;
      const res = await fetch(options.endpoint, { method: 'POST', headers, body, ...(options.keepalive === false ? {} : { keepalive: true }) });
      if (!res.ok) {
        const error = new Error(`[splithub] ingest responded ${res.status}`) as IngestError;
        error.status = res.status;
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
        if (res.status === 429) {
          try {
            const code = ((await res.json()) as { code?: unknown } | null)?.code;
            if (typeof code === 'string') error.code = code;
          } catch {
            // no JSON body
          }
        }
        throw error;
      }
    },
  };
}

export interface EventQueueOptions {
  project: string;
  sdk: string;
  transport: Transport;
  /** Flush when this many events are pending. Default 20. */
  maxBatch?: number;
  /** Flush at least this often (ms). Default 2000. */
  flushInterval?: number;
  /** Events kept while the endpoint is unreachable; the oldest go first. Default 200, 1000 with `storage`. */
  maxQueue?: number;
  /**
   * Attempts per event before it is dropped. Default 5. With `storage`, network failures and
   * 5xx / 408 never use up attempts; a 429 always does (the project is throttled, over quota or gone).
   */
  maxAttempts?: number;
  /**
   * Apps: unsent events are kept here (key `sh_queue`), so they survive a restart and an offline
   * stretch; network failures and 5xx / 408 back off up to 60 s. Queues sharing one storage share
   * `sh_queue`: only the first restores it, and each write carries every live queue's events.
   */
  storage?: KeyValueStorage;
  /** Sent with every batch (apps). */
  app?: AppInfo;
  onError?: (error: unknown) => void;
}

// sh.js (LITE) never has app storage: the offline queue's code drops out of it (see client.ts).
declare const __SPLITHUB_LITE__: true | undefined;

const MAX_BACKOFF_MS = 30_000;
const MAX_OFFLINE_BACKOFF_MS = 60_000;
/** The ingest takes at most 500 events per batch; a restored offline queue goes out in slices. */
const MAX_SEND = 500;
export const QUEUE_STORAGE_KEY = 'sh_queue';

/** A 429 for a project over quota or deleted: nothing will change soon, so wait an hour. */
const LONG_BACKOFF_MS = 3_600_000;
const LONG_BACKOFF_CODES = new Set(['quota_exceeded', 'quota', 'deleted']);
/** Upper bound for a server's Retry-After. */
const MAX_RETRY_AFTER_MS = 86_400_000;

/**
 * Queues per storage, across copies of this module (Symbol.for), so two clients on one storage
 * (React StrictMode, two providers) neither send the saved events twice nor overwrite each other's.
 */
function queuesOf(storage: KeyValueStorage): Set<EventQueue> {
  const g = globalThis as { [k: symbol]: WeakMap<KeyValueStorage, Set<EventQueue>> | undefined };
  const key = Symbol.for('splithub.queues');
  const map = (g[key] ??= new WeakMap());
  let set = map.get(storage);
  if (!set) map.set(storage, (set = new Set()));
  return set;
}

/** Events a previous launch could not send, newest `max` of them. */
function restoreQueue(storage: KeyValueStorage, max: number): SplitHubEvent[] {
  try {
    const raw = safeGet(storage, QUEUE_STORAGE_KEY);
    const saved = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(saved) ? saved.filter((e): e is SplitHubEvent => Boolean(e) && typeof e === 'object' && typeof (e as SplitHubEvent).type === 'string').slice(-max) : [];
  } catch {
    return [];
  }
}

/**
 * Batches events and sends them on a timer, when a batch is full, and when the page is
 * hidden (sendBeacon / keepalive). A failed batch is retried with exponential backoff and
 * jitter, up to `maxAttempts`; a 4xx other than 408/429 is a refusal and is not retried.
 * At most `maxQueue` events wait in memory. Page listeners are bound on the first event
 * and removed by `destroy()`, so a client created and thrown away (React StrictMode) leaks nothing.
 */
export class EventQueue {
  private pending: SplitHubEvent[] = [];
  private retry: SplitHubEvent[] = [];
  /** Batches on their way: still persisted until the transport says they arrived. */
  private readonly inflight = new Set<SplitHubEvent[]>();
  private attempts = 0;
  /** 429s in a row: they drop the batch after `maxAttempts`, storage or not. */
  private throttled = 0;
  private destroyed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoffUntil = 0;
  private readonly maxBatch: number;
  private readonly flushInterval: number;
  private readonly maxQueue: number;
  private readonly maxAttempts: number;
  private unbind: (() => void) | null = null;

  constructor(private readonly options: EventQueueOptions) {
    this.maxBatch = options.maxBatch ?? 20;
    this.flushInterval = options.flushInterval ?? 2000;
    this.maxQueue = options.maxQueue ?? (options.storage ? 1000 : 200);
    this.maxAttempts = options.maxAttempts ?? 5;
    // Events a previous launch could not send go out first. Only the first queue on a storage
    // claims them; a later one adopts what destroyed queues left (StrictMode's thrown-away client).
    if (typeof __SPLITHUB_LITE__ === 'undefined' && options.storage) {
      const peers = queuesOf(options.storage);
      if (peers.size === 0) {
        this.pending = restoreQueue(options.storage, this.maxQueue);
      } else {
        for (const peer of peers) {
          if (!peer.destroyed) continue;
          this.pending.push(...peer.release());
          if (peer.inflight.size === 0) peers.delete(peer);
        }
        this.pending = this.pending.slice(-this.maxQueue);
      }
      peers.add(this);
      this.persist();
      if (this.pending.length) this.schedule(0);
    }
  }

  /** Hands over the events waiting here (not those on their way) to a queue that adopts them. */
  private release(): SplitHubEvent[] {
    const out = [...this.retry, ...this.pending];
    this.retry = [];
    this.pending = [];
    return out;
  }

  private persist(): void {
    if (!(typeof __SPLITHUB_LITE__ === 'undefined') || !this.options.storage) return;
    const queues = new Set(queuesOf(this.options.storage)).add(this);
    const all = [...queues].flatMap((q) => [...[...q.inflight].flat(), ...q.retry, ...q.pending]).slice(-this.maxQueue);
    safeSet(this.options.storage, QUEUE_STORAGE_KEY, all.length ? JSON.stringify(all) : null);
  }

  private bind(): void {
    if (this.unbind || !isBrowser()) return;
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void this.flush(true);
    };
    const onPageHide = () => void this.flush(true);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    this.unbind = () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
    };
  }

  private schedule(delay: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush(false);
    }, delay);
  }

  push(event: SplitHubEvent): void {
    this.bind();
    if (this.destroyed) {
      this.destroyed = false;
      if (typeof __SPLITHUB_LITE__ === 'undefined' && this.options.storage) queuesOf(this.options.storage).add(this);
    }
    this.pending.push(event);
    const overflow = this.size - this.maxQueue;
    if (overflow > 0) {
      const fromRetry = Math.min(overflow, this.retry.length);
      this.retry.splice(0, fromRetry);
      this.pending.splice(0, overflow - fromRetry);
    }
    this.persist();
    const waiting = Date.now() < this.backoffUntil;
    if (!waiting && this.pending.length >= this.maxBatch) {
      void this.flush(false);
      return;
    }
    this.schedule(waiting ? this.backoffUntil - Date.now() : this.flushInterval);
  }

  get size(): number {
    return this.pending.length + this.retry.length;
  }

  /** Send everything now. `beacon` is for page hide: it ignores the backoff, since the page is going away. */
  async flush(beacon = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const all = [...this.retry, ...this.pending];
    const events = all.slice(0, MAX_SEND);
    this.retry = all.slice(MAX_SEND);
    this.pending = [];
    if (events.length === 0) return;
    const offline = typeof __SPLITHUB_LITE__ === 'undefined' && Boolean(this.options.storage);
    const batch: EventBatch = { project: this.options.project, sdk: this.options.sdk, events, ...(this.options.app ? { app: this.options.app } : {}) };
    this.inflight.add(events);
    try {
      await this.options.transport.send(batch, { beacon });
      this.inflight.delete(events);
      this.attempts = 0;
      this.throttled = 0;
      this.backoffUntil = 0;
      this.persist();
      if (this.retry.length) this.schedule(0);
    } catch (error) {
      this.inflight.delete(events);
      const { status, retryAfter, code } = error as IngestError;
      // 4xx is a refusal (bad key, origin not allowed, invalid batch): retrying cannot help.
      const refused = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
      // 429: throttled, over quota or deleted. It may pass later, but never forever, even with storage.
      const throttled = status === 429;
      this.attempts += 1;
      if (throttled) this.throttled += 1;
      // An app offline for a day keeps its events: with storage a network failure or 5xx never drops them.
      const keep = !refused && (throttled ? this.throttled < this.maxAttempts : true) && (offline || this.attempts < this.maxAttempts);
      if (keep) {
        this.retry = [...events, ...this.retry, ...this.pending].slice(-this.maxQueue);
        this.pending = [];
        const base = Math.min(offline ? MAX_OFFLINE_BACKOFF_MS : MAX_BACKOFF_MS, 1000 * 2 ** (Math.min(this.attempts, 20) - 1));
        let delay = Math.round(base / 2 + Math.random() * (base / 2));
        if (retryAfter) delay = Math.max(delay, Math.min(MAX_RETRY_AFTER_MS, retryAfter * 1000));
        if (throttled && code && LONG_BACKOFF_CODES.has(code)) delay = Math.max(delay, LONG_BACKOFF_MS);
        this.backoffUntil = Date.now() + delay;
        this.schedule(delay);
      } else {
        this.attempts = 0;
        this.throttled = 0;
        this.backoffUntil = 0;
      }
      this.persist();
      this.options.onError?.(error);
    }
  }

  /** Stop the timer and the page listeners. Pending events stay; a later `push` binds again. */
  destroy(): void {
    this.unbind?.();
    this.unbind = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.destroyed = true;
    // Nothing left to hand over: leave the storage to the other queues.
    if (typeof __SPLITHUB_LITE__ === 'undefined' && this.options.storage && this.size === 0 && this.inflight.size === 0) queuesOf(this.options.storage).delete(this);
  }
}
