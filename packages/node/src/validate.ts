import { HOLDOUT_KEY, type EventBatch, type SplitHubEvent } from '@splithub/core';
import type { StoredEvent } from './store';

const ID = /^[a-z0-9_-]{8,64}$/i;
const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_EVENTS = 500;
const MAX_PROPS_BYTES = 4096;
/** Reject client timestamps more than this far from the server clock. */
const MAX_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

export type ValidationResult = { ok: true; events: StoredEvent[] } | { ok: false; error: string };

/** `expectedProject` null skips the name check (the caller already identified the project, e.g. by public key). */
export function validateBatch(body: unknown, expectedProject: string | null, now = Date.now()): ValidationResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const batch = body as Partial<EventBatch>;
  if (typeof batch.project !== 'string') return { ok: false, error: '"project" must be a string' };
  if (expectedProject !== null && batch.project !== expectedProject) return { ok: false, error: `unknown project "${batch.project}"` };
  if (!Array.isArray(batch.events)) return { ok: false, error: '"events" must be an array' };
  if (batch.events.length === 0) return { ok: true, events: [] };
  if (batch.events.length > MAX_EVENTS) return { ok: false, error: `too many events (max ${MAX_EVENTS})` };

  const out: StoredEvent[] = [];
  for (const raw of batch.events as Partial<SplitHubEvent>[]) {
    const e = normalize(raw, now);
    if (typeof e === 'string') return { ok: false, error: e };
    out.push(e);
  }
  return { ok: true, events: out };
}

function normalize(e: Partial<SplitHubEvent>, now: number): StoredEvent | string {
  if (!e || typeof e !== 'object') return 'event must be an object';
  if (typeof e.id !== 'string' || !ID.test(e.id)) return 'event.id is invalid';
  if (typeof e.vid !== 'string' || e.vid.length === 0 || e.vid.length > 64) return 'event.vid is invalid';
  if (typeof e.sid !== 'string' || e.sid.length === 0 || e.sid.length > 64) return 'event.sid is invalid';
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return 'event.ts must be a number';
  const ts = Math.abs(e.ts - now) > MAX_SKEW_MS ? now : Math.round(e.ts);
  const url = typeof e.url === 'string' ? e.url.slice(0, 512) : null;

  if (e.type === 'exposure') {
    if (typeof e.exp !== 'string' || !(KEY.test(e.exp) || e.exp === HOLDOUT_KEY)) return 'exposure.exp is invalid';
    if (typeof e.var !== 'string' || !KEY.test(e.var)) return 'exposure.var is invalid';
    return { id: e.id, type: 'exposure', experiment: e.exp, variant: e.var, goal: null, visitorId: e.vid, sessionId: e.sid, ts, url, props: null, receivedAt: now };
  }
  if (e.type === 'goal') {
    if (typeof e.goal !== 'string' || !KEY.test(e.goal)) return 'goal.goal is invalid';
    let props: Record<string, unknown> | null = null;
    if (e.props !== undefined) {
      if (!e.props || typeof e.props !== 'object' || Array.isArray(e.props)) return 'goal.props must be an object';
      if (JSON.stringify(e.props).length > MAX_PROPS_BYTES) return 'goal.props too large';
      props = e.props;
    }
    return { id: e.id, type: 'goal', experiment: null, variant: null, goal: e.goal, visitorId: e.vid, sessionId: e.sid, ts, url, props, receivedAt: now };
  }
  return `unknown event type "${String((e as { type?: unknown }).type)}"`;
}
