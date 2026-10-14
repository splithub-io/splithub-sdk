import type { EventBatch, SplitHubEvent } from './types';
import { isBrowser } from './visitor';

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
      const res = await fetch(options.endpoint, { method: 'POST', headers, body, keepalive: true });
      if (!res.ok) {
        const error = new Error(`[splithub] ingest responded ${res.status}`) as Error & { status?: number };
        error.status = res.status;
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
  /** Events kept while the endpoint is unreachable; the oldest go first. Default 200. */
  maxQueue?: number;
  /** Attempts per event before it is dropped. Default 5. */
  maxAttempts?: number;
  onError?: (error: unknown) => void;
}

const MAX_BACKOFF_MS = 30_000;

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
  private attempts = 0;
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
    this.maxQueue = options.maxQueue ?? 200;
    this.maxAttempts = options.maxAttempts ?? 5;
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
    this.pending.push(event);
    const overflow = this.size - this.maxQueue;
    if (overflow > 0) {
      const fromRetry = Math.min(overflow, this.retry.length);
      this.retry.splice(0, fromRetry);
      this.pending.splice(0, overflow - fromRetry);
    }
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
    const events = [...this.retry, ...this.pending];
    this.retry = [];
    this.pending = [];
    if (events.length === 0) return;
    const batch: EventBatch = { project: this.options.project, sdk: this.options.sdk, events };
    try {
      await this.options.transport.send(batch, { beacon });
      this.attempts = 0;
      this.backoffUntil = 0;
    } catch (error) {
      const status = (error as { status?: number }).status;
      // 4xx is a refusal (bad key, origin not allowed, invalid batch): retrying cannot help.
      const refused = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
      this.attempts += 1;
      if (!refused && this.attempts < this.maxAttempts) {
        this.retry = events.slice(-this.maxQueue);
        const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.attempts - 1));
        const delay = Math.round(base / 2 + Math.random() * (base / 2));
        this.backoffUntil = Date.now() + delay;
        this.schedule(delay);
      } else {
        this.attempts = 0;
        this.backoffUntil = 0;
      }
      this.options.onError?.(error);
    }
  }

  /** Stop the timer and the page listeners. Pending events stay; a later `push` binds again. */
  destroy(): void {
    this.unbind?.();
    this.unbind = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
