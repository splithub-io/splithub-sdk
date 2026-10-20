// Analytics reports past the summary and breakdowns, plus what people save around them.
// SplitHub Cloud only: a self-hosted endpoint answers raw counts (`splithub analytics <id>`).
//
//   splithub analytics funnel <id> --steps "page:/,event:Signup,goal:paid" [--within visit|7d|30d] [--by <dimension>]
//   splithub analytics paths <id> --page /pricing [--prev]
//   splithub analytics retention <id> [--start visit|event:<name>|goal:<key>] [--return visit|event:<name>] [--period day|week]
//   splithub analytics realtime <id>
//   splithub analytics props <id> --event <name> [--key <prop>]
//   splithub analytics export <id> [--by <dimension>|day] [--raw] > file.csv
//   splithub analytics segments [--property <id>] | --save <name> country=DE ... | --delete <id|name>
//
// Every report takes --days 7 | --from --to, --filter dimension=value and --segment <name|id>.

import { requestText, request, requireCloudToken, resolveTarget, type Target } from '../api';
import { fail, printJson } from '../errors';
import { detectProject } from '../project';
import { bar, c, table } from '../ui';
import type { Flags } from './init';

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const COMPARE_RANGE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;
/** `--compare` (the period right before), `--compare year` (the same days a year earlier) or `--compare 2026-09-01..2026-09-30`. */
export function compareQuery(flags: Flags): Record<string, string> {
  const v = flags.compare;
  if (v === undefined || v === false) return {};
  if (v === true || v === '' || v === 'previous') return { compare: 'previous' };
  if (v === 'year') return { compare: 'year' };
  const m = typeof v === 'string' ? COMPARE_RANGE.exec(v) : null;
  if (!m || m[1]! > m[2]!) fail('INVALID_FLAG', `--compare ${String(v)}: use previous, year or a range like 2026-09-01..2026-09-30.`);
  return { compare: 'custom', cfrom: m[1]!, cto: m[2]! };
}
export const n = (x: number) => x.toLocaleString('en-US');
export const rate = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '–');
const share = (x: number) => `${(x * 100).toFixed(1)}%`;
const enc = encodeURIComponent;

/** Signed change against the period before: `+12%`, `-3%`, `new`, or `–` when both are zero. */
export function change(now: number, before: number | undefined): string {
  if (before === undefined) return c.dim('–');
  if (before === 0) return now > 0 ? c.green('new') : c.dim('–');
  const d = (now - before) / before;
  if (d === 0) return c.dim('0%');
  const text = `${d >= 0 ? '+' : ''}${(d * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}%`;
  return d > 0 ? c.green(text) : d < 0 ? c.red(text) : c.dim(text);
}

/** `--filter country=DE,FR` (repeatable) as `{ country: 'DE,FR' }`. */
export function filterFlags(flags: Flags): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of (Array.isArray(flags.filter) ? flags.filter : flags.filter ? [flags.filter] : []) as string[]) {
    const at = f.indexOf('=');
    const k = at > 0 ? f.slice(0, at).trim() : '';
    const v = at > 0 ? f.slice(at + 1).trim() : '';
    if (!k || !v) fail('INVALID_FLAG', `--filter ${f}: use dimension=value[,value], e.g. --filter country=DE`);
    out[k] = v;
  }
  return out;
}

/**
 * `?from=&to=` (or the last `--days`), a saved segment's filters, then `--filter` (which wins on the
 * same dimension), then the report's own parameters.
 */
export function reportQuery(flags: Flags, extra: Record<string, string> = {}, segment: Record<string, string> = {}): string {
  const q = new URLSearchParams();
  const from = str(flags.from);
  // --to is shared with redirect variants (`create --to b=/new`), so it may arrive as a list.
  const to = str(Array.isArray(flags.to) ? flags.to[0] : flags.to);
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  const days = Number(flags.days);
  if (!from && Number.isFinite(days) && days > 0) {
    const d = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    q.set('from', d(Math.floor(days) - 1));
    if (!to) q.set('to', d(0));
  }
  for (const [k, v] of Object.entries({ ...segment, ...filterFlags(flags) })) q.set(k, v);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

interface Segment {
  id: string;
  name: string;
  propertyKey: string | null;
  filters: Record<string, string[]>;
  createdAt: string;
}

async function listSegments(t: Target, property?: string): Promise<Segment[]> {
  return (await request<{ segments: Segment[] }>(t, `/segments${property ? `?property=${enc(property)}` : ''}`)).segments;
}

function findSegment(list: Segment[], want: string): Segment {
  const s = list.find((x) => x.id === want) ?? list.find((x) => x.name.toLowerCase() === want.toLowerCase());
  if (!s) fail('INVALID_FLAG', `There's no segment "${want}".`, 'See the saved ones with npx splithub analytics segments.');
  return s;
}

/** `--segment <name|id>`: the saved filters, as query values. */
export async function segmentFilters(t: Target, flags: Flags, property: string): Promise<Record<string, string>> {
  const want = str(flags.segment);
  if (!want) return {};
  const s = findSegment(await listSegments(t, property), want);
  return Object.fromEntries(Object.entries(s.filters).map(([k, v]) => [k, v.join(',')]));
}

/**
 * The cloud target for a cloud-only report. A self-hosted project gets NOT_CLOUD: its endpoint
 * keeps raw counts only. Outside a project, a saved login or SPLITHUB_API_KEY is enough.
 */
export function cloudOnly(flags: Flags, what: string, report = true, rawHint = 'Read the raw counts with npx splithub analytics <id>.'): Target {
  const project = detectProject();
  const t = resolveTarget(flags, project);
  if (t.cloud) return t;
  const explicit = (typeof flags.url === 'string' && flags.url) || process.env.SPLITHUB_URL;
  if (!project.configFile && !explicit) return requireCloudToken(flags);
  if (!report) return fail('NOT_CLOUD', `${what} come with SplitHub Cloud.`, 'Connect this app with npx splithub init --mode cloud (or npx splithub login).');
  return fail('NOT_CLOUD', `${what} come with SplitHub Cloud: a self-hosted endpoint keeps raw counts only.`, rawHint);
}

const head = (key: string, parts: string[]) => console.log(`${c.bold(key)} ${c.dim(`· ${parts.join(' · ')}`)}\n`);
const span = (r: { from: string; to: string }) => `${r.from} → ${r.to}`;

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

interface FunnelData {
  range: { from: string; to: string };
  within: string;
  steps: Array<{ step: string; label: string; visitors: number; conversion: number; dropoff: number }>;
  byDimension?: string;
  by?: Array<{ value: string; steps: number[] }>;
  rolledUp?: boolean;
}

const WITHIN: Record<string, string> = { visit: 'in one visit', '7d': 'within 7 days', '30d': 'within 30 days' };

export async function funnel(key: string, flags: Flags): Promise<void> {
  const steps = str(flags.steps);
  if (!steps || steps.split(',').filter((s) => s.trim()).length < 2) fail('USAGE', 'Which steps? npx splithub analytics funnel <id> --steps "page:/,event:Signup,goal:paid" (2 or more).');
  const t = cloudOnly(flags, 'Funnels');
  const within = str(flags.within) ?? 'visit';
  const by = str(flags.by);
  const data = await request<FunnelData>(t, `/properties/${enc(key)}/funnel${reportQuery(flags, { steps, within, ...(by ? { by } : {}) }, await segmentFilters(t, flags, key))}`);
  if (flags.json) return printJson(data);
  head(key, [`funnel ${WITHIN[data.within] ?? data.within}`, span(data.range)]);
  const first = data.steps[0]?.visitors ?? 0;
  console.log(
    table(
      ['STEP', 'VISITORS', '', 'CONVERSION', 'DROP-OFF'],
      data.steps.map((s, i) => [`${i + 1}. ${s.label === s.step.slice(s.step.indexOf(':') + 1) ? s.step : `${s.label} ${c.dim(`(${s.step})`)}`}`, n(s.visitors), bar(s.visitors, Math.max(1, first), 16), share(s.conversion), i === 0 ? c.dim('–') : share(s.dropoff)])
    )
  );
  if (data.by?.length) {
    console.log(`\n${c.bold(`By ${data.byDimension ?? by}`)}`);
    const rows = data.by.slice(0, Number(flags.limit) || 15);
    console.log(table([(data.byDimension ?? 'value').toUpperCase(), ...data.steps.map((_, i) => `STEP ${i + 1}`), 'CONVERSION'], rows.map((r) => [r.value, ...r.steps.map(n), rate(r.steps[r.steps.length - 1] ?? 0, r.steps[0] ?? 0)])));
  }
  if (data.rolledUp) console.log(c.dim('\nDays older than 90 days keep no step order, so they count nothing here.'));
  if (first === 0) console.log(c.dim('Nobody reached the first step in this range.'));
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export async function paths(key: string, flags: Flags): Promise<void> {
  const page = str(flags.page);
  if (!page) fail('USAGE', 'Which page? npx splithub analytics paths <id> --page /pricing (add --prev for where visitors came from).');
  const t = cloudOnly(flags, 'Paths');
  const direction = flags.prev ? 'prev' : 'next';
  const data = await request<{ range: { from: string; to: string }; rows: Array<{ value: string; visits: number }> }>(t, `/properties/${enc(key)}/paths${reportQuery(flags, { page, direction }, await segmentFilters(t, flags, key))}`);
  if (flags.json) return printJson(data);
  head(key, [direction === 'next' ? `after ${page}` : `before ${page}`, span(data.range)]);
  if (data.rows.length === 0) return void console.log(c.dim(`No visits to ${page} in this range.`));
  const total = data.rows.reduce((s, r) => s + r.visits, 0);
  const label = (v: string) => (v === '(exit)' ? c.dim('left the site') : v === '(entrance)' ? c.dim('landed here') : v);
  console.log(table([direction === 'next' ? 'NEXT PAGE' : 'PREVIOUS PAGE', 'VISITS', 'SHARE'], data.rows.slice(0, Number(flags.limit) || 20).map((r) => [label(r.value), n(r.visits), rate(r.visits, total)])));
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

interface RetentionData {
  range: { from: string; to: string };
  start: string;
  return: string;
  period: 'day' | 'week';
  cohorts: Array<{ cohort: string; size: number; returned: number[] }>;
}

export async function retention(key: string, flags: Flags): Promise<void> {
  const t = cloudOnly(flags, 'Retention reports');
  const extra: Record<string, string> = { start: str(flags.start) ?? 'visit', return: str(flags.return) ?? 'visit', period: str(flags.period) ?? 'week' };
  const data = await request<RetentionData>(t, `/properties/${enc(key)}/retention${reportQuery(flags, extra, await segmentFilters(t, flags, key))}`);
  if (flags.json) return printJson(data);
  head(key, [`retention by ${data.period}`, `start ${data.start}, back with ${data.return}`, span(data.range)]);
  if (data.cohorts.length === 0) return void console.log(c.dim('No cohorts in this range.'));
  const periods = Math.max(0, ...data.cohorts.map((r) => r.returned.length));
  const unit = data.period === 'day' ? 'DAY' : 'WEEK';
  console.log(table(['COHORT', 'VISITORS', ...Array.from({ length: periods }, (_, i) => `${unit} ${i}`)], data.cohorts.map((r) => [r.cohort, n(r.size), ...Array.from({ length: periods }, (_, i) => (i < r.returned.length ? rate(r.returned[i] ?? 0, r.size) : ''))])));
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

interface RealtimeData {
  activeVisitors5m: number;
  pageviews: Array<{ minute: number; n: number }>;
  events: Array<{ minute: number; n: number }>;
  pages: Array<{ value: string; n: number }>;
  sources: Array<{ value: string; n: number }>;
}

export async function realtime(key: string, flags: Flags): Promise<void> {
  const t = cloudOnly(flags, 'Realtime reports');
  const data = await request<RealtimeData>(t, `/properties/${enc(key)}/realtime`);
  if (flags.json) return printJson(data);
  const sum = (rows: Array<{ n: number }>) => rows.reduce((s, r) => s + r.n, 0);
  console.log(`${c.bold(key)} ${c.dim('· right now')}\n`);
  console.log(`${c.bold(n(data.activeVisitors5m))} ${data.activeVisitors5m === 1 ? 'visitor' : 'visitors'} in the last 5 minutes ${c.dim(`· ${n(sum(data.pageviews))} pageviews and ${n(sum(data.events))} events in the last 30`)}`);
  if (data.pages.length) {
    console.log(`\n${c.bold('Pages')}`);
    console.log(table(['PAGE', 'PAGEVIEWS'], data.pages.slice(0, 10).map((r) => [r.value, n(r.n)])));
  }
  if (data.sources.length) {
    console.log(`\n${c.bold('Sources')}`);
    console.log(table(['SOURCE', 'VISITS'], data.sources.slice(0, 10).map((r) => [r.value === '(none)' ? c.dim('direct') : r.value, n(r.n)])));
  }
}

// ---------------------------------------------------------------------------
// Event props
// ---------------------------------------------------------------------------

interface PropRow {
  value: string;
  visitors: number;
  sessions: number;
  events: number;
}

export async function props(key: string, flags: Flags): Promise<void> {
  const event = str(flags.event);
  if (!event) fail('USAGE', 'Which event? npx splithub analytics props <id> --event Signup [--key plan]');
  const t = cloudOnly(flags, 'Event props');
  const prop = str(flags.key);
  const data = await request<{ range: { from: string; to: string }; rows: PropRow[]; previous?: PropRow[] }>(
    t,
    `/properties/${enc(key)}/breakdown${reportQuery(flags, { by: 'prop', name: event, ...(prop ? { key: prop } : {}), ...compareQuery(flags) }, await segmentFilters(t, flags, key))}`
  );
  if (flags.json) return printJson(data);
  head(key, [prop ? `${event} by ${prop}` : `props of ${event}`, span(data.range)]);
  if (data.rows.length === 0) return void console.log(c.dim(`No ${event} events with props in this range.`));
  const before = new Map((data.previous ?? []).map((r) => [r.value, r.events]));
  const rows = data.rows.slice(0, Number(flags.limit) || 20);
  console.log(table([prop ? prop.toUpperCase() : 'PROP', 'EVENTS', 'VISITORS', 'VISITS', ...(data.previous ? ['CHANGE'] : [])], rows.map((r) => [r.value, n(r.events), n(r.visitors), n(r.sessions), ...(data.previous ? [change(r.events, before.get(r.value) ?? 0)] : [])])));
  if (!prop) console.log(c.dim(`\nValues of one: --key ${rows[0]!.value}`));
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

export async function exportCsv(key: string, flags: Flags): Promise<void> {
  const t = cloudOnly(flags, 'Exports');
  const by = str(flags.by) ?? 'day';
  const goal = str(flags.goal);
  const extra: Record<string, string> = flags.raw ? { raw: '1' } : { by, ...(goal ? { goal } : {}) };
  const csv = await requestText(t, `/properties/${enc(key)}/export.csv${reportQuery(flags, extra, await segmentFilters(t, flags, key))}`);
  if (flags.json) return printJson({ property: key, ...(flags.raw ? { raw: true } : { by }), csv });
  process.stdout.write(csv.replace(/\r\n/g, '\n'));
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

/** `country=DE,FR` positionals (and --filter) as saved filters. */
function segmentBody(args: string[], flags: Flags): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (k: string, v: string) => (out[k] = v.split(',').map((x) => x.trim()).filter(Boolean));
  for (const a of args) {
    const at = a.indexOf('=');
    if (at <= 0 || at === a.length - 1) fail('INVALID_FLAG', `"${a}": use dimension=value[,value], e.g. country=DE,FR`);
    add(a.slice(0, at).trim(), a.slice(at + 1).trim());
  }
  for (const [k, v] of Object.entries(filterFlags(flags))) add(k, v);
  return out;
}

const describeFilters = (f: Record<string, string[]>) =>
  Object.entries(f)
    .map(([k, v]) => `${k}=${v.join(',')}`)
    .join(' ');

export async function segments(args: string[], flags: Flags): Promise<void> {
  const t = cloudOnly(flags, 'Saved segments');
  const property = str(flags.property);
  const save = str(flags.save);
  const del = str(flags.delete);
  if (save) {
    const filters = segmentBody(args, flags);
    if (Object.keys(filters).length === 0) fail('USAGE', `Which visits? npx splithub analytics segments --save "${save}" country=DE source=google`);
    const out = await request<{ segment: Segment }>(t, '/segments', { method: 'POST', body: JSON.stringify({ name: save, filters, ...(property ? { propertyKey: property } : {}) }) });
    if (flags.json) return printJson(out);
    console.log(`${c.green('✔')} segment ${c.bold(out.segment.name)} saved ${c.dim(`(${describeFilters(out.segment.filters)})`)}`);
    console.log(c.dim(`Use it on any report: --segment "${out.segment.name}"`));
    return;
  }
  if (del) {
    const s = findSegment(await listSegments(t), del);
    await request(t, `/segments/${enc(s.id)}`, { method: 'DELETE' });
    if (flags.json) return printJson({ ok: true, id: s.id, name: s.name });
    console.log(`${c.green('✔')} segment ${c.bold(s.name)} deleted`);
    return;
  }
  const list = await listSegments(t, property);
  if (flags.json) return printJson({ segments: list });
  if (list.length === 0) return void console.log(c.dim('No saved segments yet. Save one: npx splithub analytics segments --save "Paid traffic" channel="Paid Search"'));
  console.log(table(['NAME', 'FILTERS', 'PROPERTY', 'ID'], list.map((s) => [c.bold(s.name), describeFilters(s.filters), s.propertyKey ?? c.dim('all'), c.dim(s.id)])));
}
