// Targeting: who enters an experiment and which branch they take.
//
// A `flow` is a small graph the dashboard edits visually and the SDK walks
// deterministically: start → condition (country / device / UTM …) →
// traffic split → variant | skip. No flow = everybody, plain weights.
// Every decision is a hash of visitor id + node id, so the same visitor lands
// on the same branch on every runtime (browser, edge, server).

import { hashToUnit } from './hash';
import type { Experiment, Flow, FlowNode, TargetCondition, TargetField, TargetOp, TargetingContext, Variant } from './types';

export const TARGET_FIELDS: TargetField[] = ['country', 'region', 'city', 'device', 'browser', 'os', 'language', 'referrer', 'url', 'path', 'query', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'cookie', 'visitor', 'hour', 'weekday', 'platform', 'app_version'];
export const TARGET_OPS: TargetOp[] = ['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'in', 'not_in', 'matches', 'exists', 'not_exists', 'gte', 'lt'];

/** Fields that take an extra `key` (query param name, cookie name). */
export const KEYED_FIELDS: TargetField[] = ['query', 'cookie'];

const MAX_STEPS = 64;

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const formatters = new Map<string, Intl.DateTimeFormat | null>();

/**
 * Hour and weekday where the visitor is. `ctx.timezone` is the device's zone in the
 * browser and the geo header's zone on the server (Vercel `x-vercel-ip-timezone`, or
 * `timezone` in the cloud's overrides `ctx`); when nothing says, UTC, so an edge
 * function in another region does not shift the schedule.
 */
function localClock(ctx: TargetingContext): { hour: number; weekday: number } {
  const d = new Date(ctx.now ?? Date.now());
  const tz = ctx.timezone;
  let f = tz ? formatters.get(tz) : null;
  if (tz && f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
    } catch {
      f = null; // unknown zone: UTC
    }
    formatters.set(tz, f);
  }
  if (f) {
    const parts = f.formatToParts(d);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const weekday = WEEKDAYS.indexOf((parts.find((p) => p.type === 'weekday')?.value ?? '').slice(0, 3).toLowerCase());
    if (hour >= 0 && hour < 24 && weekday >= 0) return { hour, weekday };
  }
  return { hour: d.getUTCHours(), weekday: d.getUTCDay() };
}

function queryParam(url: string | undefined, name: string): string | undefined {
  if (!url) return undefined;
  const q = url.indexOf('?');
  if (q < 0) return undefined;
  const search = url.slice(q + 1).split('#')[0] ?? '';
  for (const pair of search.split('&')) {
    const eq = pair.indexOf('=');
    const k = decodeURIComponent((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
    if (k === name) return decodeURIComponent((eq < 0 ? '' : pair.slice(eq + 1)).replace(/\+/g, ' '));
  }
  return undefined;
}

/** Value of a context field as a lowercase string, or undefined when unknown. */
export function contextValue(field: TargetField, key: string | undefined, ctx: TargetingContext): string | undefined {
  let v: string | number | undefined;
  switch (field) {
    case 'country':
    case 'region':
    case 'city':
    case 'device':
    case 'browser':
    case 'os':
    case 'referrer':
    case 'url':
    case 'visitor':
    case 'platform':
      v = ctx[field];
      break;
    case 'app_version':
      v = ctx.appVersion;
      break;
    case 'language':
      v = ctx.language?.split(',')[0]?.trim().split('-')[0];
      break;
    case 'path': {
      const u = ctx.url;
      if (!u) break;
      const noOrigin = u.replace(/^[a-z]+:\/\/[^/]+/i, '');
      v = (noOrigin.split('?')[0] ?? '').split('#')[0] || '/';
      break;
    }
    case 'query':
      v = key ? queryParam(ctx.url, key) : undefined;
      break;
    case 'utm_source':
    case 'utm_medium':
    case 'utm_campaign':
    case 'utm_term':
    case 'utm_content':
      v = queryParam(ctx.url, field);
      break;
    case 'cookie':
      v = key ? ctx.cookies?.[key] : undefined;
      break;
    case 'hour':
      v = localClock(ctx).hour;
      break;
    case 'weekday':
      v = WEEKDAYS[localClock(ctx).weekday];
      break;
  }
  return v === undefined || v === null ? undefined : String(v).toLowerCase();
}

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/**
 * Orders two versions: dotted parts compare as numbers when both are digits
 * (`2.10.0` > `2.9`), otherwise as strings; a missing part counts as 0, so
 * `2.0` equals `2`. Plain numbers are one-part versions. Native SDKs port this as is.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.trim().split('.');
  const pb = b.trim().split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function evaluateCondition(c: TargetCondition, ctx: TargetingContext): boolean {
  const actual = contextValue(c.field, c.key, ctx);
  const expected = (c.value ?? '').trim().toLowerCase();
  switch (c.op) {
    case 'exists':
      return actual !== undefined && actual !== '';
    case 'not_exists':
      return actual === undefined || actual === '';
    case 'is':
      return actual !== undefined && actual === expected;
    case 'is_not':
      return actual === undefined || actual !== expected;
    case 'contains':
      return actual !== undefined && expected !== '' && actual.includes(expected);
    case 'not_contains':
      return actual === undefined || expected === '' || !actual.includes(expected);
    case 'starts_with':
      return actual !== undefined && actual.startsWith(expected);
    case 'in':
      return actual !== undefined && list(c.value).includes(actual);
    case 'not_in':
      return actual === undefined || !list(c.value).includes(actual);
    case 'gte':
      return actual !== undefined && actual !== '' && expected !== '' && compareVersions(actual, expected) >= 0;
    case 'lt':
      return actual !== undefined && actual !== '' && expected !== '' && compareVersions(actual, expected) < 0;
    case 'matches': {
      if (actual === undefined) return false;
      try {
        return new RegExp(c.value ?? '', 'i').test(actual);
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function matchConditions(conditions: TargetCondition[], match: 'all' | 'any', ctx: TargetingContext): boolean {
  if (conditions.length === 0) return true;
  return match === 'any' ? conditions.some((c) => evaluateCondition(c, ctx)) : conditions.every((c) => evaluateCondition(c, ctx));
}

export type FlowOutcome = { variant: Variant; path: string[] } | { variant: null; path: string[]; reason: 'skip' | 'dead_end' };

/**
 * Walk the flow for one visitor. Deterministic: splits hash the visitor id
 * with the node id. Returns the variant, or null with the reason.
 */
export function runFlow(experiment: Experiment, flow: Flow, visitorId: string, ctx: TargetingContext): FlowOutcome {
  const path: string[] = [];
  let id: string | null | undefined = flow.start;
  for (let step = 0; step < MAX_STEPS && id; step++) {
    const node: FlowNode | undefined = flow.nodes[id];
    if (!node) break;
    path.push(id);
    switch (node.type) {
      case 'condition':
        id = matchConditions(node.conditions, node.match ?? 'all', ctx) ? node.then : node.else;
        break;
      case 'split': {
        const total = node.outputs.reduce((s, o) => s + Math.max(0, o.weight), 0);
        if (total <= 0 || node.outputs.length === 0) return { variant: null, path, reason: 'dead_end' };
        const unit = hashToUnit(`${experiment.seed}:${experiment.key}:flow:${id}:${visitorId}`) * total;
        let acc = 0;
        let to: string | null = node.outputs[node.outputs.length - 1]!.to;
        for (const o of node.outputs) {
          acc += Math.max(0, o.weight);
          if (unit < acc) {
            to = o.to;
            break;
          }
        }
        id = to;
        break;
      }
      case 'variant': {
        const variant = experiment.variants.find((v) => v.key === node.variant);
        return variant ? { variant, path } : { variant: null, path, reason: 'dead_end' };
      }
      case 'skip':
        return { variant: null, path, reason: 'skip' };
    }
  }
  return { variant: null, path, reason: 'dead_end' };
}

/** Structural validation; returns a message or null. Variant keys must exist on the experiment. */
export function validateFlow(flow: unknown, variantKeys: string[]): string | null {
  if (!flow || typeof flow !== 'object') return 'flow must be an object';
  const f = flow as Flow;
  if (typeof f.start !== 'string' || !f.nodes || typeof f.nodes !== 'object') return 'flow needs "start" and "nodes"';
  const ids = Object.keys(f.nodes);
  if (ids.length === 0) return 'flow has no nodes';
  if (ids.length > 200) return 'flow has too many nodes';
  if (!f.nodes[f.start]) return `start node "${f.start}" does not exist`;
  const ref = (id: unknown, where: string): string | null => (id === null || id === undefined ? null : typeof id === 'string' && f.nodes[id] ? null : `${where} points to unknown node "${String(id)}"`);
  for (const id of ids) {
    const n = f.nodes[id] as FlowNode;
    if (!n || typeof n !== 'object') return `node "${id}" is invalid`;
    switch (n.type) {
      case 'condition': {
        if (!Array.isArray(n.conditions)) return `node "${id}": conditions must be an array`;
        if (n.conditions.length > 20) return `node "${id}": too many conditions`;
        for (const c of n.conditions) {
          if (!TARGET_FIELDS.includes(c.field)) return `node "${id}": unknown field "${String(c.field)}"`;
          if (!TARGET_OPS.includes(c.op)) return `node "${id}": unknown operator "${String(c.op)}"`;
          if (KEYED_FIELDS.includes(c.field) && !c.key) return `node "${id}": "${c.field}" needs a name`;
          if (c.op === 'matches') {
            try {
              new RegExp(c.value ?? '');
            } catch {
              return `node "${id}": invalid regular expression`;
            }
          }
        }
        if (n.match !== undefined && n.match !== 'all' && n.match !== 'any') return `node "${id}": match must be "all" or "any"`;
        if (typeof n.then !== 'string') return `node "${id}": "then" branch required`;
        const e1 = ref(n.then, `node "${id}" then`) ?? ref(n.else, `node "${id}" else`);
        if (e1) return e1;
        break;
      }
      case 'split': {
        if (!Array.isArray(n.outputs) || n.outputs.length === 0) return `node "${id}": split needs outputs`;
        if (n.outputs.length > 20) return `node "${id}": too many outputs`;
        for (const o of n.outputs) {
          if (typeof o.weight !== 'number' || !(o.weight >= 0)) return `node "${id}": output weight must be ≥ 0`;
          const e = ref(o.to, `node "${id}" output`);
          if (e) return e;
        }
        if (!n.outputs.some((o) => o.weight > 0)) return `node "${id}": at least one output needs weight > 0`;
        break;
      }
      case 'variant':
        if (!variantKeys.includes(n.variant)) return `node "${id}": unknown variant "${String(n.variant)}"`;
        break;
      case 'skip':
        break;
      default:
        return `node "${id}": unknown type "${String((n as { type?: unknown }).type)}"`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pingdom|facebookexternalhit|google-inspectiontool|bingpreview|mediapartners|ahrefs|semrush|phantomjs|python-requests|curl\/|wget\//i;

/** Rough UA classification shared by the browser SDK, the Next middleware and the cloud. */
export function parseUserAgent(ua: string | null | undefined): { device: 'mobile' | 'tablet' | 'desktop' | 'bot'; browser: string; os: string } {
  const s = ua ?? '';
  const device = BOT_UA.test(s) ? 'bot' : /iPad|Tablet|PlayBook|Silk/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s)) ? 'tablet' : /Mobi|iPhone|iPod|Android|BlackBerry|Opera Mini|IEMobile/i.test(s) ? 'mobile' : 'desktop';
  const browser = /Edg\//i.test(s) ? 'edge' : /OPR\/|Opera/i.test(s) ? 'opera' : /SamsungBrowser/i.test(s) ? 'samsung' : /Firefox\//i.test(s) ? 'firefox' : /Chrome\/|CriOS/i.test(s) ? 'chrome' : /Safari\//i.test(s) && /Version\//i.test(s) ? 'safari' : s ? 'other' : 'unknown';
  const os = /Windows/i.test(s) ? 'windows' : /iPhone|iPad|iPod/i.test(s) ? 'ios' : /Android/i.test(s) ? 'android' : /Mac OS X|Macintosh/i.test(s) ? 'macos' : /CrOS/i.test(s) ? 'chromeos' : /Linux/i.test(s) ? 'linux' : s ? 'other' : 'unknown';
  return { device, browser, os };
}

/**
 * True for crawlers, link previews, monitors and headless browsers. They get the control
 * and send no exposures or goals; servers use it to drop events from such requests.
 */
export function isBot(ua: string | null | undefined): boolean {
  return Boolean(ua) && BOT_UA.test(ua!);
}

const HTTP_CLIENT_UA = /^(curl|wget|python-requests)\//i;

/**
 * For ingest: a crawler rendering pages, not a plain HTTP client. A backend that
 * sends goals with curl or python-requests is a real sender; `isBot` (targeting)
 * calls those bots, so ingest must not use it.
 */
export function isCrawler(ua: string | null | undefined): boolean {
  return isBot(ua) && !HTTP_CLIENT_UA.test(ua!.trim());
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[k] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/** Context from the current browser page. Geo fields come from the cloud (`ctx` in the overrides JSON). */
export function browserContext(extra: Partial<TargetingContext> = {}): TargetingContext {
  // React Native has `window` and `navigator` but no page: nothing here describes an app.
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || typeof document === 'undefined' || typeof location === 'undefined') return { ...extra };
  const ua = parseUserAgent(navigator.userAgent);
  return {
    platform: 'web',
    device: ua.device,
    browser: ua.browser,
    os: ua.os,
    language: navigator.language,
    referrer: typeof document !== 'undefined' ? document.referrer || undefined : undefined,
    url: location.href,
    cookies: typeof document !== 'undefined' ? parseCookies(document.cookie) : {},
    timezone: deviceTimezone(),
    ...extra,
  };
}

function deviceTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
