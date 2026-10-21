// One experiment, read closer (SplitHub Cloud only: a self-hosted endpoint keeps raw counts).
//
//   splithub results <id> [--from --to] [--filter country=DE ...]   the verdict on a slice: first-exposure days, visitor filters
//   splithub results <id> --by <dimension>                           every segment's variants against the control there
//   splithub results <id> --timeline                                 visitors and conversions per day and variant
//   splithub results <id> --engagement                               bounce, visit length, pages per visit per variant
//   splithub results <id> --events                                   every goal and event per variant, lift vs control
//   splithub results <id> --export --by <dimension> > file.csv       the breakdown as CSV
//   splithub events --experiment <id> [--type exposure|goal] [--limit 50] [--before <ms>]   the raw tail
//
// Every view takes --from / --to (YYYY-MM-DD, first-exposure days in the project time zone) and --filter.

import { request, requestText, type Target } from '../api';
import { fail, printJson } from '../errors';
import { c, pct, table } from '../ui';
import { cloudOnly, filterFlags, n, reportQuery, str } from './analytics-reports';
import type { Flags } from './init';
import { noteKind } from './notes';

/** Visitor columns an experiment report can be filtered by (`--filter <key>=a,b`); `page` is analytics' word for `landing`. */
export const EXPERIMENT_FILTERS = ['country', 'region', 'city', 'device', 'os', 'browser', 'language', 'host', 'platform', 'app_version', 'source', 'channel', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'landing', 'page'] as const;
/** Dimensions a breakdown splits visitors by (`--by`); `page` is analytics' word for `url`. */
export const EXPERIMENT_BY = ['country', 'region', 'city', 'device', 'os', 'browser', 'language', 'host', 'platform', 'app_version', 'page', 'url', 'referrer', 'source', 'channel', 'landing', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

/** Column title of a dimension: `url` reads "page", as in analytics and the dashboard. */
export const dimensionLabel = (by: string): string => (by === 'url' ? 'page' : by);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const enc = encodeURIComponent;
const RAW_HINT = 'Read the raw counts with npx splithub results <id>.';

export interface Scope {
  filtered: boolean;
  range: { from: string; to: string } | null;
  filters: Record<string, string | string[]>;
  note?: string;
}

/** True when the flags ask for more than the plain all-time results. */
export function wantsSlice(flags: Flags): boolean {
  return Boolean(str(flags.from) || str(Array.isArray(flags.to) ? flags.to[0] : flags.to) || Number(flags.days) > 0 || (Array.isArray(flags.filter) ? flags.filter.length : flags.filter));
}

/** `?from=&to=&country=DE…` for an experiment report; refuses dates and filters the server can't read. */
export function experimentQuery(flags: Flags, extra: Record<string, string> = {}): string {
  for (const [name, v] of [['from', flags.from], ['to', Array.isArray(flags.to) ? flags.to[0] : flags.to]] as const) {
    const day = str(v);
    if (day && !DAY.test(day)) fail('INVALID_FLAG', `--${name} ${day}: use a day like 2026-10-01.`);
  }
  for (const k of Object.keys(filterFlags(flags))) {
    if (!(EXPERIMENT_FILTERS as readonly string[]).includes(k)) fail('INVALID_FLAG', `--filter ${k}: experiments filter by ${EXPERIMENT_FILTERS.join(', ')}.`);
  }
  return reportQuery(flags, extra);
}

/** "first seen 2026-10-01 → 2026-10-15 · country=DE", or null for the whole experiment. */
export function describeScope(scope: Scope | undefined): string | null {
  if (!scope || (!scope.filtered && !scope.range)) return null;
  const parts: string[] = [];
  if (scope.range) parts.push(`first seen ${scope.range.from} → ${scope.range.to}`);
  for (const [k, v] of Object.entries(scope.filters ?? {})) parts.push(`${k}=${Array.isArray(v) ? v.join(',') : v}`);
  return parts.join(' · ');
}

/** The slice banner printed above a filtered or ranged report. */
export function printScope(scope: Scope | undefined): void {
  const what = describeScope(scope);
  if (!what) return;
  console.log(c.yellow(`Filtered slice: ${what}`));
  if (scope?.note) console.log(c.dim(scope.note));
  console.log();
}

const target = (flags: Flags, what: string): Target => cloudOnly(flags, what, true, RAW_HINT);

// ---------------------------------------------------------------------------
// Results on a slice
// ---------------------------------------------------------------------------

/** GET /results/<id> with a range and filters; the caller prints it like the whole-experiment results. */
export async function fetchSlice<T>(key: string, flags: Flags): Promise<T> {
  const t = target(flags, 'Filtered results');
  return request<T>(t, `/results/${enc(key)}${experimentQuery(flags)}`, {}, key);
}

// ---------------------------------------------------------------------------
// Breakdown
// ---------------------------------------------------------------------------

interface SegmentRow {
  dim: string;
  cells: Array<{ variant: string; exposures: number; conversions: number } | null>;
  comparisons: Array<{ variant: string; lift: number | null; pValue: number; significant: boolean; better: boolean }>;
  total: number;
  small: boolean;
}
export interface BreakdownData {
  experiment: string;
  by: string;
  goal: string | null;
  order: string[];
  segments: SegmentRow[];
  scope?: Scope;
}

function byFlag(flags: Flags): string {
  const by = str(flags.by);
  if (!by) return fail('USAGE', 'Split by what? Add --by country (or device, source, channel, landing, …).');
  if (!(EXPERIMENT_BY as readonly string[]).includes(by)) fail('INVALID_FLAG', `--by ${by}: use one of ${EXPERIMENT_BY.join(', ')}.`);
  return by;
}

/** A lift cell: green ✔ / red ✖ when the difference is clear, plain otherwise. */
function liftCell(cmp: SegmentRow['comparisons'][number] | undefined): string {
  if (!cmp || cmp.lift === null) return c.dim('–');
  const text = pct(cmp.lift, true);
  if (!cmp.significant) return text;
  return cmp.better ? c.green(`${text} ✔`) : c.red(`${text} ✖`);
}

export function breakdownTable(data: BreakdownData, limit = 20): string {
  const [control, ...others] = data.order;
  const rows = data.segments.slice(0, limit).map((s) => {
    const name = s.dim === '' || s.dim === '(none)' ? c.dim('(none)') : s.small ? c.dim(s.dim) : s.dim;
    const rates = data.order.map((_, i) => {
      const cell = s.cells[i];
      return cell && cell.exposures > 0 ? `${pct(cell.conversions / cell.exposures)} ${c.dim(`of ${n(cell.exposures)}`)}` : c.dim('–');
    });
    return [name, n(s.total), ...rates, ...others.map((v) => liftCell(s.comparisons.find((x) => x.variant === v)))];
  });
  const head = [dimensionLabel(data.by).toUpperCase(), 'VISITORS', ...data.order.map((v) => (v === control ? `${v} (control)` : v)), ...others.map((v) => `LIFT ${v}`)];
  return table(head, rows);
}

export async function breakdown(key: string, flags: Flags): Promise<void> {
  const by = byFlag(flags);
  const t = target(flags, 'Breakdowns');
  const data = await request<BreakdownData>(t, `/experiments/${enc(key)}/breakdown/${enc(by)}${experimentQuery(flags)}`, {}, key);
  if (flags.json) return printJson({ ...data, experiment: key, view: 'breakdown' });
  console.log(`${c.bold(key)} ${c.dim(`· by ${dimensionLabel(by)} · goal: ${data.goal ?? 'none'}`)}\n`);
  printScope(data.scope);
  if (data.segments.length === 0) return void console.log(c.dim('No visitors in this slice yet.'));
  console.log(breakdownTable(data, Number(flags.limit) || 20));
  console.log(c.dim(`\nLift is against the control inside each segment; ✔ and ✖ mark a clear difference, dim rows have too few visitors.`));
  console.log(c.dim('Segments are for exploring: the verdict is on the whole experiment.'));
}

export async function breakdownCsv(key: string, flags: Flags): Promise<void> {
  const by = byFlag(flags);
  const t = target(flags, 'Exports');
  const csv = await requestText(t, `/experiments/${enc(key)}/export.breakdown.csv${experimentQuery(flags, { by })}`);
  if (flags.json) return printJson({ experiment: key, by, csv });
  process.stdout.write(csv.replace(/\r\n/g, '\n'));
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

interface DayRow {
  day: string;
  variant: string;
  n: number;
}
export interface TimelineData {
  experiment: string;
  goal: string | null;
  mode?: string;
  exposures: DayRow[];
  conversions: DayRow[];
  notes?: Array<{ day: string; kind?: string; text: string }>;
  scope?: Scope;
}

export function timelineTable(data: TimelineData): string {
  const variants = [...new Set([...data.exposures, ...data.conversions].map((r) => r.variant))];
  const days = [...new Set([...data.exposures, ...data.conversions].map((r) => r.day))].sort();
  const count = (rows: DayRow[]) => new Map(rows.map((r) => [`${r.day}|${r.variant}`, r.n]));
  const seen = count(data.exposures);
  const conv = count(data.conversions);
  const head = ['DAY', ...variants.flatMap((v) => [v, 'CONV', 'RATE'])];
  const rows = days.map((d) => [
    d,
    ...variants.flatMap((v) => {
      const x = seen.get(`${d}|${v}`) ?? 0;
      const y = conv.get(`${d}|${v}`) ?? 0;
      return [n(x), n(y), x > 0 ? pct(y / x) : c.dim('–')];
    }),
  ]);
  return table(head, rows);
}

export async function timeline(key: string, flags: Flags): Promise<void> {
  const t = target(flags, 'Timelines');
  const data = await request<TimelineData>(t, `/experiments/${enc(key)}/timeline${experimentQuery(flags)}`, {}, key);
  if (flags.json) return printJson({ ...data, experiment: key, view: 'timeline' });
  console.log(`${c.bold(key)} ${c.dim(`· per day · goal: ${data.goal ?? 'none'}`)}\n`);
  printScope(data.scope);
  if (data.exposures.length === 0) return void console.log(c.dim('No visitors in this slice yet.'));
  console.log(timelineTable(data));
  if (data.mode !== 'goal_day') console.log(c.dim("\nA day counts the visitors first seen that day and how many of them converted, whenever they did."));
  if (data.notes?.length) {
    console.log(`\n${c.bold('Notes')}`);
    for (const a of data.notes.slice(-5)) console.log(`${c.dim(a.day)}  ${a.kind && a.kind !== 'note' ? `${noteKind(a.kind)} ` : ''}${a.text}`);
  }
}

// ---------------------------------------------------------------------------
// Engagement (from the analytics property collecting on the same visitors)
// ---------------------------------------------------------------------------

export interface EngagementData {
  property: string | null;
  variants: Array<{ variant: string; visitors: number; sessions: number; pageviews: number; bounces: number; duration: number; pagesPerVisit: number; bounceRate: number; avgVisit: number }>;
  scope?: Scope;
}

/** Milliseconds as `42s` or `3m 05s`. */
export function visitLength(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export async function engagement(key: string, flags: Flags): Promise<void> {
  const t = target(flags, 'Engagement by variant');
  const data = await request<EngagementData>(t, `/experiments/${enc(key)}/engagement${experimentQuery(flags, str(flags.property) ? { property: str(flags.property)! } : {})}`, {}, key);
  if (flags.json) return printJson({ ...data, experiment: key, view: 'engagement' });
  if (!data.property || data.variants.length === 0) {
    console.log(c.dim('No analytics on these visitors yet. Name a property on the provider (or sh.js) to see visits per variant.'));
    return;
  }
  console.log(`${c.bold(key)} ${c.dim(`· engagement from ${data.property}`)}\n`);
  printScope(data.scope);
  console.log(
    table(
      ['VARIANT', 'VISITORS', 'VISITS', 'PAGES / VISIT', 'BOUNCE', 'AVG VISIT'],
      data.variants.map((v, i) => [i === 0 ? `${v.variant} ${c.dim('(control)')}` : v.variant, n(v.visitors), n(v.sessions), v.sessions ? v.pagesPerVisit.toFixed(2) : c.dim('–'), v.sessions ? pct(v.bounceRate) : c.dim('–'), v.sessions ? visitLength(v.avgVisit) : c.dim('–')])
    )
  );
  console.log(c.dim('\nCounts to read next to the verdict, not a verdict.'));
}

// ---------------------------------------------------------------------------
// Events by variant: every goal and event of the experiment's visitors
// ---------------------------------------------------------------------------

export interface EventsByVariantData {
  experiment: string;
  goal: string | null;
  property: string | null;
  variants: string[];
  visitors: Record<string, number>;
  rows: Array<{
    name: string;
    goalKey: string | null;
    isGoal: boolean;
    measured: 'goal' | 'metric' | 'guardrail' | null;
    perVariant: Record<string, { visitors: number; count: number | null; rate: number | null; revenue: number }>;
    comparisons: SegmentRow['comparisons'];
    small: boolean;
  }>;
  scope?: Scope;
}

const ROLE: Record<string, string> = { goal: 'goal', metric: 'metric', guardrail: 'guardrail' };

export function eventsTable(data: EventsByVariantData, limit = 30): string {
  const [control, ...others] = data.variants;
  const rows = data.rows.slice(0, limit).map((r) => {
    const role = r.measured ? ROLE[r.measured] : r.isGoal ? 'goal' : '';
    const label = r.goalKey && r.goalKey !== r.name ? `${r.name} ${c.dim(r.goalKey)}` : r.name;
    const cells = data.variants.map((v) => {
      const x = r.perVariant[v];
      return x && x.rate !== null ? `${n(x.visitors)} ${c.dim(`· ${pct(x.rate)}`)}` : c.dim('–');
    });
    return [r.small ? c.dim(r.name) : label, role ? c.dim(role) : '', ...cells, ...others.map((v) => (r.small ? c.dim('–') : liftCell(r.comparisons.find((x) => x.variant === v))))];
  });
  const head = ['EVENT', 'ROLE', ...data.variants.map((v) => (v === control ? `${v} (control)` : v)), ...others.map((v) => `LIFT ${v}`)];
  return table(head, rows);
}

export async function eventsByVariant(key: string, flags: Flags): Promise<void> {
  const t = target(flags, 'Events by variant');
  const data = await request<EventsByVariantData>(t, `/experiments/${enc(key)}/events-summary${experimentQuery(flags, str(flags.property) ? { property: str(flags.property)! } : {})}`, {}, key);
  if (flags.json) return printJson({ ...data, experiment: key, view: 'events' });
  console.log(`${c.bold(key)} ${c.dim(`· events by variant${data.property ? ` · from ${data.property}` : ''}`)}\n`);
  printScope(data.scope);
  if (data.rows.length === 0) return void console.log(c.dim('No goals or events from these visitors yet.'));
  console.log(eventsTable(data, Number(flags.limit) || 30));
  console.log(c.dim('\nVisitors who did it · their rate; lift is against the control, ✔ and ✖ mark a clear difference, dim rows have too few visitors.'));
  if (!data.property) console.log(c.dim('Only goals so far: other events show up once an analytics property runs on the same site.'));
  console.log(c.dim('The verdict is on the experiment goal; the other rows are for exploring.'));
}

export async function eventsByVariantCsv(key: string, flags: Flags): Promise<void> {
  const t = target(flags, 'Exports');
  const csv = await requestText(t, `/experiments/${enc(key)}/export.events-summary.csv${experimentQuery(flags)}`);
  if (flags.json) return printJson({ experiment: key, view: 'events', csv });
  process.stdout.write(csv.replace(/\r\n/g, '\n'));
}

// ---------------------------------------------------------------------------
// Raw events
// ---------------------------------------------------------------------------

interface RawEvent {
  id: string;
  type: string;
  variant: string | null;
  goal: string | null;
  visitorId: string;
  ts: number;
  url: string | null;
  country: string | null;
}

export async function experimentEvents(key: string | undefined, flags: Flags): Promise<void> {
  if (!key) fail('USAGE', 'Which experiment? npx splithub events --experiment <id>');
  const type = str(flags.type);
  if (type && type !== 'exposure' && type !== 'goal') fail('INVALID_FLAG', `--type ${type}: use exposure or goal.`);
  const before = str(flags.before);
  if (before && !(Number(before) > 0)) fail('INVALID_FLAG', `--before ${before}: use a time in milliseconds, like the nextBefore of the last page.`);
  const limit = Math.max(1, Math.min(200, Number(flags.limit) || 50));
  const t = target(flags, 'Raw experiment events');
  const extra: Record<string, string> = { limit: String(limit), ...(type ? { type } : {}), ...(before ? { before } : {}) };
  const data = await request<{ events: RawEvent[]; nextBefore: number | null; scope?: Scope }>(t, `/experiments/${enc(key)}/events${experimentQuery(flags, extra)}`, {}, key);
  if (flags.json) return printJson({ ...data, experiment: key });
  if (data.events.length === 0) return void console.log(c.dim('No events in this slice. Raw events stay 7 days (30 on Pro).'));
  console.log(
    table(
      ['TIME', 'TYPE', 'VARIANT / GOAL', 'VISITOR', 'URL', 'COUNTRY'],
      data.events.map((e) => [new Date(Number(e.ts)).toISOString().replace('T', ' ').slice(0, 19), e.type, (e.type === 'exposure' ? e.variant : e.goal) ?? '', String(e.visitorId ?? '').slice(0, 12), e.url ?? '', e.country ?? ''])
    )
  );
  if (data.nextBefore) console.log(c.dim(`\nOlder: --before ${data.nextBefore}`));
}
