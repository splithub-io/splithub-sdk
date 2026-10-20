import { EVENT_NAME_PATTERN, HOLDOUT_KEY, type EventBatch, type SplitHubEvent } from '@splithub/core';
import type { StoredEvent } from './store';

const ID = /^[a-z0-9_-]{8,64}$/i;
const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_EVENTS = 500;
const MAX_PROPS_BYTES = 4096;
const MAX_ENGAGE_MS = 3_600_000;
/** Reject client timestamps more than this far from the server clock. */
const MAX_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A batch whose shape is wrong is refused whole (`ok: false`). Otherwise each invalid event is
 * dropped on its own (`dropped`, with the first `errors`), so one bad goal key never takes the
 * exposures and pageviews of the same batch down with it.
 */
export type ValidationResult = { ok: true; events: StoredEvent[]; dropped: number; errors: string[] } | { ok: false; error: string };

/** `expectedProject` null skips the name check (the caller already identified the project, e.g. by public key). */
export function validateBatch(body: unknown, expectedProject: string | null, now = Date.now()): ValidationResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const batch = body as Partial<EventBatch>;
  if (typeof batch.project !== 'string') return { ok: false, error: '"project" must be a string' };
  if (expectedProject !== null && batch.project !== expectedProject) return { ok: false, error: `unknown project "${batch.project}"` };
  if (!Array.isArray(batch.events)) return { ok: false, error: '"events" must be an array' };
  if (batch.events.length > MAX_EVENTS) return { ok: false, error: `too many events (max ${MAX_EVENTS})` };

  const out: StoredEvent[] = [];
  const errors: string[] = [];
  let dropped = 0;
  for (const raw of batch.events as Partial<SplitHubEvent>[]) {
    const e = normalize(raw, now);
    if (typeof e === 'string') {
      dropped++;
      if (errors.length < 5 && !errors.includes(e)) errors.push(e);
    } else out.push(e);
  }
  return { ok: true, events: out, dropped, errors };
}

function normalize(e: Partial<SplitHubEvent>, now: number): StoredEvent | string {
  if (!e || typeof e !== 'object') return 'event must be an object';
  if (typeof e.id !== 'string' || !ID.test(e.id)) return 'event.id is invalid';
  if (typeof e.vid !== 'string' || e.vid.length === 0 || e.vid.length > 64) return 'event.vid is invalid';
  if (typeof e.sid !== 'string' || e.sid.length === 0 || e.sid.length > 64) return 'event.sid is invalid';
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return 'event.ts must be a number';
  const ts = Math.abs(e.ts - now) > MAX_SKEW_MS ? now : Math.round(e.ts);
  const url = 'url' in e && typeof e.url === 'string' ? e.url.slice(0, 512) : null;
  const base = { id: e.id, visitorId: e.vid, sessionId: e.sid, ts, url, receivedAt: now };

  if (e.type === 'exposure') {
    if (typeof e.exp !== 'string' || !(KEY.test(e.exp) || e.exp === HOLDOUT_KEY)) return 'exposure.exp is invalid';
    if (typeof e.var !== 'string' || !KEY.test(e.var)) return 'exposure.var is invalid';
    // Where the visit came from (`''` = direct). Lenient: anything but a string is ignored, never a reason to drop.
    const ref = typeof e.ref === 'string' ? e.ref.slice(0, 300) : null;
    return { ...base, type: 'exposure', experiment: e.exp, variant: e.var, goal: null, props: ref === null ? null : { ref } };
  }
  if (e.type === 'goal') {
    if (typeof e.goal !== 'string' || !KEY.test(e.goal)) return 'goal.goal is invalid';
    const props = propsOf(e.props, 'goal');
    if (typeof props === 'string') return props;
    return { ...base, type: 'goal', experiment: null, variant: null, goal: e.goal, props };
  }
  // Analytics rows reuse the columns: `experiment` is the property, `goal` the event name.
  // Property ids are lowercase; a client that sent capitals still lands on the property.
  const prop = 'prop' in e && typeof e.prop === 'string' ? e.prop.trim().toLowerCase() : null;
  if (e.type === 'page') {
    if (!prop || !KEY.test(prop)) return 'page.prop is invalid';
    if (!url) return 'page.url is required';
    const title = typeof e.title === 'string' && e.title ? e.title.slice(0, 200) : null;
    const ref = typeof e.ref === 'string' && e.ref ? e.ref.slice(0, 512) : null;
    const props = title || ref ? { ...(title ? { title } : {}), ...(ref ? { ref } : {}) } : null;
    return { ...base, type: 'page', experiment: prop, variant: null, goal: null, props };
  }
  if (e.type === 'event') {
    if (!prop || !KEY.test(prop)) return 'event.prop is invalid';
    if (typeof e.name !== 'string' || !EVENT_NAME_PATTERN.test(e.name)) return 'event.name is invalid';
    const props = propsOf(e.props, 'event');
    if (typeof props === 'string') return props;
    return { ...base, type: 'event', experiment: prop, variant: null, goal: e.name, props };
  }
  if (e.type === 'engage') {
    if (!prop || !KEY.test(prop)) return 'engage.prop is invalid';
    if (!url) return 'engage.url is required';
    if (typeof e.ms !== 'number' || !Number.isFinite(e.ms) || e.ms < 0) return 'engage.ms must be a number of milliseconds';
    if (typeof e.scroll !== 'number' || !Number.isFinite(e.scroll) || e.scroll < 0) return 'engage.scroll must be a percent';
    const ms = Math.min(MAX_ENGAGE_MS, Math.round(e.ms));
    const scroll = Math.min(100, Math.round(e.scroll));
    return { ...base, type: 'engage', experiment: prop, variant: null, goal: null, props: { ms, scroll } };
  }
  if (e.type === 'identify') {
    if (!prop || !KEY.test(prop)) return 'identify.prop is invalid';
    const uid = typeof e.uid === 'string' ? e.uid.trim() : '';
    if (!uid || uid.length > 128) return 'identify.uid must be 1 to 128 characters';
    const traits = traitsOf(e.traits);
    if (typeof traits === 'string') return traits;
    return { ...base, type: 'identify', experiment: prop, variant: null, goal: null, url: null, props: { uid, ...(traits ? { traits } : {}) } };
  }
  return `unknown event type "${String((e as { type?: unknown }).type)}"`;
}

function propsOf(value: unknown, kind: string): Record<string, unknown> | null | string {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `${kind}.props must be an object`;
  if (JSON.stringify(value).length > MAX_PROPS_BYTES) return `${kind}.props too large`;
  return value as Record<string, unknown>;
}

/** Flat traits: text, numbers and booleans; other values are left out. */
function traitsOf(value: unknown): Record<string, string | number | boolean> | null | string {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'identify.traits must be an object';
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  }
  if (JSON.stringify(out).length > MAX_PROPS_BYTES) return 'identify.traits too large';
  return Object.keys(out).length ? out : null;
}
