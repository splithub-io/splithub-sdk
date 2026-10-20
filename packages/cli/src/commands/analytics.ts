// splithub analytics — analytics properties: pageviews and custom events, read as reports.
//
//   splithub analytics                          every property (last 30 days)
//   splithub analytics create --name "Site" [<id>] [--goals a,b --description --status paused]   (id generated: sh-x1h78w)
//   splithub analytics connect [<id>] [--name "Site"]   pick or create a property and name it in the app's provider (connect.ts)
//   splithub analytics <id> [--days 7 | --from --to] [--filter country=DE]
//   splithub analytics <id> --by page|source|country|event|goal|... [--goal <goal>]
//   splithub analytics <id> --compare [year | <from>..<to>]   change against the period right before, a year earlier or chosen days
//   splithub analytics events <id> [--limit 50]
//   splithub analytics pause|resume <id>
//   splithub analytics archive|restore <id>     SplitHub Cloud: like Archive in the dashboard (stops collecting, leaves the list, numbers kept)
//   splithub analytics remove <id>
//   splithub analytics funnel|paths|retention|realtime|props|export|segments ...   (analytics-reports.ts)
//
// Like experiments, properties are declared in splithub.config.ts; pause / resume also apply
// live in the cloud. Self-hosted endpoints answer raw counts and rows; reports (visits,
// sources, pages, conversions) come from SplitHub Cloud.

import { newPropertyId } from '@splithub/core';
import { relative } from 'node:path';
import { cloudTarget, request, resolveTarget, type Target } from '../api';
import { insertProperty, loadConfig, readSource, removeProperty, setPropertyStatus, writeConfigChecked } from '../config-file';
import { fail, printJson } from '../errors';
import { detectProject, requireConfig } from '../project';
import { bar, c, statusColor, table } from '../ui';
import { change, cloudOnly, compareQuery, exportCsv, filterFlags, funnel, n, paths, props, rate, realtime, reportQuery, retention, segmentFilters, segments, str } from './analytics-reports';
import type { Flags } from './init';
import { noteKind } from './notes';

const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SUBCOMMANDS = new Set(['create', 'connect', 'events', 'pause', 'resume', 'archive', 'restore', 'remove', 'funnel', 'paths', 'retention', 'realtime', 'props', 'export', 'segments']);
export const ANALYTICS_BY = ['source', 'referrer', 'channel', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'country', 'region', 'city', 'device', 'os', 'browser', 'language', 'host', 'entry', 'exit', 'page', 'event', 'goal', 'variant', 'trait'] as const;

interface Sums {
  visitors: number;
  newVisitors: number;
  sessions: number;
  pageviews: number;
  events: number;
  bounces: number;
  duration: number;
}
interface PropertyView {
  key: string;
  name: string | null;
  status: string;
  origin: string;
  goals: string[];
  domains: string[];
  /** Archived in the dashboard (or with `analytics archive`): paused and out of the list, numbers kept. */
  archived?: boolean;
  last30: Sums | null;
}
interface RawCounts {
  pageviews: number;
  visitors: number;
  sessions: number;
  events: Array<{ name: string; count: number; visitors: number }>;
}
interface RawReport {
  property: string;
  status: string;
  name: string | null;
  goals: string[];
  days: number;
  /** Servers before 0.4.0 leave it out. */
  range?: { from: string; to: string };
  counts: RawCounts | null;
  analysis: { available: false; message: string; url: string };
}
interface Row extends Sums {
  value: string;
  entries: number;
  exits: number;
  conversions: number;
  revenue: number;
}

const list = (v: unknown): string[] => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const minutes = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/** Cloud: /properties; self-hosted: {endpoint}/properties. */
function target(flags: Flags): Target {
  return resolveTarget(flags, detectProject());
}

export async function analytics(args: string[], flags: Flags): Promise<void> {
  const [first, second] = args;
  if (!first) return listProperties(flags);
  if (SUBCOMMANDS.has(first)) {
    if (first === 'create') return createProperty(second ?? newPropertyId(), flags);
    if (first === 'connect') return (await import('./connect')).connect(second, flags);
    if (first === 'segments') return segments(args.slice(1), flags);
    if (!second) fail('USAGE', `Which property? npx splithub analytics ${first} <id>`);
    if (first === 'events') return rawEvents(second, flags);
    if (first === 'funnel') return funnel(second, flags);
    if (first === 'paths') return paths(second, flags);
    if (first === 'retention') return retention(second, flags);
    if (first === 'realtime') return realtime(second, flags);
    if (first === 'props') return props(second, flags);
    if (first === 'export') return exportCsv(second, flags);
    if (first === 'remove') return remove(second, flags);
    if (first === 'archive' || first === 'restore') return archive(second, first === 'archive', flags);
    return setStatus(second, first === 'pause' ? 'paused' : 'running', flags);
  }
  return report(first, flags);
}

async function listProperties(flags: Flags): Promise<void> {
  const t = target(flags);
  if (t.cloud) {
    const data = await request<{ properties: PropertyView[] }>(t, '/properties');
    if (flags.json) return printJson(data);
    if (data.properties.length === 0) {
      console.log(c.dim('No analytics properties yet. Run npx splithub analytics create --name "Marketing site".'));
      return;
    }
    const max = Math.max(1, ...data.properties.map((p) => p.last30?.visitors ?? 0));
    console.log(c.dim('Last 30 days\n'));
    console.log(
      table(
        ['PROPERTY', 'STATUS', 'VISITORS', '', 'VISITS', 'PAGEVIEWS', 'BOUNCE', 'GOALS', 'DOMAINS'],
        data.properties.map((p) => {
          const s = p.last30;
          return [c.bold(p.name ? `${p.name} (${p.key})` : p.key), statusColor(p.archived ? 'archived' : p.status), n(s?.visitors ?? 0), bar(s?.visitors ?? 0, max, 12, p.status === 'running' && !p.archived ? c.green : c.dim), n(s?.sessions ?? 0), n(s?.pageviews ?? 0), s ? rate(s.bounces, s.sessions) : '–', p.goals.join(', ') || c.dim('none'), p.domains.join(', ') || c.dim('any')];
        })
      )
    );
    return;
  }
  const data = await request<{ properties: RawReport[] }>(t, '/properties');
  if (flags.json) return printJson(data);
  if (data.properties.length === 0) {
    console.log(c.dim('No analytics properties in splithub.config.ts yet. Run npx splithub analytics create --name "Marketing site".'));
    return;
  }
  console.log(c.dim('Last 30 days, raw counts from your database\n'));
  console.log(table(['PROPERTY', 'STATUS', 'VISITORS', 'SESSIONS', 'PAGEVIEWS', 'EVENTS'], data.properties.map((p) => [c.bold(p.property), statusColor(p.status), n(p.counts?.visitors ?? 0), n(p.counts?.sessions ?? 0), n(p.counts?.pageviews ?? 0), n((p.counts?.events ?? []).reduce((s, e) => s + e.count, 0))])));
  console.log(`\n${c.dim(data.properties[0]!.analysis.message)}`);
}

interface Summary {
  range: { from: string; to: string };
  totals: Sums;
  goals: Array<{ goal: string; conversions: number; completions: number; revenue: number }>;
  days: Array<Sums & { day: string }>;
  notes?: Array<{ day: string; kind?: string; text: string }>;
  previous?: { range: { from: string; to: string }; totals: Sums; goals: Array<{ goal: string; conversions: number }> };
}

/** The number a breakdown row is ranked by, per dimension: what its CHANGE column compares. */
const headline = (by: string, goal: string | undefined) => (r: Row) => (by === 'page' ? r.pageviews : by === 'event' ? r.events : by === 'goal' || goal ? r.conversions : r.visitors);

async function report(key: string, flags: Flags): Promise<void> {
  const t = target(flags);
  if (!t.cloud) return rawReport(t, key, flags);
  const segment = await segmentFilters(t, flags, key);
  const compare = compareQuery(flags);
  const by = str(flags.by);
  if (by) {
    if (!(ANALYTICS_BY as readonly string[]).includes(by)) fail('INVALID_FLAG', `--by ${by}: use one of ${ANALYTICS_BY.join(', ')}.`);
    const goal = str(flags.goal);
    // variant needs the experiment whose variants split the visits; trait needs the trait name.
    const experiment = by === 'variant' ? str(flags.experiment) : undefined;
    const trait = by === 'trait' ? str(flags.key) : undefined;
    if (by === 'variant' && !experiment) fail('INVALID_FLAG', '--by variant needs --experiment <key>.');
    if (by === 'trait' && !trait) fail('INVALID_FLAG', '--by trait needs --key <trait>, e.g. --key plan.');
    const extra = { by, ...(goal ? { goal } : {}), ...(experiment ? { experiment } : {}), ...(trait ? { key: trait } : {}), ...compare };
    const data = await request<{ rows: Row[]; range: { from: string; to: string }; previous?: Row[]; previousRange?: { from: string; to: string } }>(t, `/properties/${encodeURIComponent(key)}/breakdown${reportQuery(flags, extra, segment)}`);
    if (flags.json) return printJson(data);
    console.log(`${c.bold(key)} ${c.dim(`· by ${by} · ${data.range.from} → ${data.range.to}${data.previousRange ? ` vs ${data.previousRange.from} → ${data.previousRange.to}` : ''}`)}\n`);
    if (data.rows.length === 0) return void console.log(c.dim('Nothing in this range.'));
    const rows = data.rows.slice(0, Number(flags.limit) || 20);
    const pick = headline(by, goal);
    const before = new Map((data.previous ?? []).map((r) => [r.value, pick(r)]));
    const delta = (r: Row) => (data.previous ? [change(pick(r), before.get(r.value) ?? 0)] : []);
    const CHANGE = data.previous ? ['CHANGE'] : [];
    if (by === 'page') console.log(table(['PAGE', 'PAGEVIEWS', 'VISITORS', 'ENTRIES', 'EXITS', ...CHANGE], rows.map((r) => [r.value, n(r.pageviews), n(r.visitors), n(r.entries), n(r.exits), ...delta(r)])));
    else if (by === 'event') console.log(table(['EVENT', 'COUNT', 'VISITORS', 'VISITS', ...CHANGE], rows.map((r) => [r.value, n(r.events), n(r.visitors), n(r.sessions), ...delta(r)])));
    else if (by === 'goal') console.log(table(['GOAL', 'CONVERSIONS', 'COMPLETIONS', 'REVENUE', ...CHANGE], rows.map((r) => [r.value, n(r.conversions), n(r.events), r.revenue ? r.revenue.toFixed(2) : '–', ...delta(r)])));
    else console.log(table([by.toUpperCase(), 'VISITORS', 'VISITS', 'PAGEVIEWS', 'BOUNCE', ...(goal ? ['CONVERSIONS', 'RATE'] : []), ...CHANGE], rows.map((r) => [r.value, n(r.visitors), n(r.sessions), n(r.pageviews), rate(r.bounces, r.sessions), ...(goal ? [n(r.conversions), rate(r.conversions, r.visitors)] : []), ...delta(r)])));
    return;
  }
  const path = `/properties/${encodeURIComponent(key)}`;
  const [summary, pages, sources] = await Promise.all([
    request<Summary>(t, `${path}/summary${reportQuery(flags, compare, segment)}`),
    request<{ rows: Row[] }>(t, `${path}/breakdown${reportQuery(flags, { by: 'page' }, segment)}`),
    request<{ rows: Row[] }>(t, `${path}/breakdown${reportQuery(flags, { by: 'source' }, segment)}`),
  ]);
  if (flags.json) return printJson({ ...summary, topPages: pages.rows.slice(0, 10), topSources: sources.rows.slice(0, 10) });
  const s = summary.totals;
  const p = summary.previous?.totals;
  console.log(`${c.bold(key)} ${c.dim(`· ${summary.range.from} → ${summary.range.to}${summary.previous ? ` vs ${summary.previous.range.from} → ${summary.previous.range.to}` : ''}`)}\n`);
  const rows = [[n(s.visitors), n(s.newVisitors), n(s.sessions), n(s.pageviews), s.sessions ? (s.pageviews / s.sessions).toFixed(2) : '–', rate(s.bounces, s.sessions), s.sessions ? minutes(s.duration / s.sessions) : '–', n(s.events)]];
  if (p) {
    const ratio = (a: number, b: number) => (b ? a / b : 0);
    rows.push([change(s.visitors, p.visitors), change(s.newVisitors, p.newVisitors), change(s.sessions, p.sessions), change(s.pageviews, p.pageviews), change(ratio(s.pageviews, s.sessions), ratio(p.pageviews, p.sessions)), change(ratio(s.bounces, s.sessions), ratio(p.bounces, p.sessions)), change(ratio(s.duration, s.sessions), ratio(p.duration, p.sessions)), change(s.events, p.events)]);
  }
  console.log(table(['VISITORS', 'NEW', 'VISITS', 'PAGEVIEWS', 'PAGES / VISIT', 'BOUNCE', 'AVG VISIT', 'EVENTS'], rows));
  if (summary.goals.length) {
    const before = new Map((summary.previous?.goals ?? []).map((g) => [g.goal, g.conversions]));
    console.log(`\n${c.bold('Goals')}`);
    console.log(table(['GOAL', 'CONVERSIONS', 'RATE', 'REVENUE', ...(p ? ['CHANGE'] : [])], summary.goals.map((g) => [g.goal, n(g.conversions), rate(g.conversions, s.visitors), g.revenue ? g.revenue.toFixed(2) : '–', ...(p ? [change(g.conversions, before.get(g.goal) ?? 0)] : [])])));
  }
  if (pages.rows.length) {
    console.log(`\n${c.bold('Top pages')}`);
    console.log(table(['PAGE', 'PAGEVIEWS', 'VISITORS'], pages.rows.slice(0, 5).map((r) => [r.value, n(r.pageviews), n(r.visitors)])));
  }
  if (sources.rows.length) {
    console.log(`\n${c.bold('Top sources')}`);
    console.log(table(['SOURCE', 'VISITS', 'BOUNCE'], sources.rows.slice(0, 5).map((r) => [r.value === '(none)' ? c.dim('direct') : r.value, n(r.sessions), rate(r.bounces, r.sessions)])));
  }
  if (summary.notes?.length) {
    console.log(`\n${c.bold('Notes')}`);
    for (const a of summary.notes.slice(-5)) console.log(`${c.dim(a.day)}  ${a.kind && a.kind !== 'note' ? `${noteKind(a.kind)} ` : ''}${a.text}`);
  }
  console.log(c.dim(`\nMore: --by page|source|channel|country|device|event|goal, --compare [year|<from>..<to>], --days 7, --filter country=DE, funnel|paths|retention|realtime <id>`));
}

/** Self-hosted reads take a day range only; anything else is a SplitHub Cloud report, said so instead of ignored. */
function rawOnlyFlags(flags: Flags): void {
  const extra = [['--filter', Object.keys(filterFlags(flags)).length > 0], ['--segment', Boolean(str(flags.segment))], ['--by', Boolean(str(flags.by))], ['--compare', flags.compare !== undefined && flags.compare !== false]] as const;
  const used = extra.filter(([, on]) => on).map(([flag]) => flag);
  if (used.length) fail('NOT_CLOUD', `${used.join(', ')} come${used.length === 1 ? 's' : ''} with SplitHub Cloud: a self-hosted endpoint reads raw counts by day range only.`, 'Read them with --days 7, or --from 2026-10-01 --to 2026-10-31 (UTC days).');
}

async function rawReport(t: Target, key: string, flags: Flags): Promise<void> {
  rawOnlyFlags(flags);
  const from = str(flags.from);
  const to = str(Array.isArray(flags.to) ? flags.to[0] : flags.to);
  for (const [name, day] of [['from', from], ['to', to]] as const) if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) fail('INVALID_FLAG', `--${name} ${day}: use a day like 2026-10-01.`);
  const days = Number(flags.days) > 0 ? Math.floor(Number(flags.days)) : 30;
  const query = new URLSearchParams(from || to ? { ...(from ? { from } : {}), ...(to ? { to } : {}) } : { days: String(days) });
  const data = await request<RawReport>(t, `/properties/${encodeURIComponent(key)}?${query}`);
  if (flags.json) return printJson(data);
  const span = data.range && (from || to) ? `${data.range.from} → ${data.range.to} (UTC)` : `last ${data.days} days`;
  console.log(`${c.bold(key)} ${c.dim(`· ${span} · raw counts`)}\n`);
  if (!data.counts) {
    console.log(c.yellow('This store keeps no analytics reads (propertyCounts). Update @splithub/node and the store.'));
    return;
  }
  const k = data.counts;
  console.log(table(['VISITORS', 'SESSIONS', 'PAGEVIEWS'], [[n(k.visitors), n(k.sessions), n(k.pageviews)]]));
  if (k.events.length) {
    console.log(`\n${c.bold('Events')}`);
    console.log(table(['EVENT', 'COUNT', 'VISITORS'], k.events.slice(0, 20).map((e) => [e.name, n(e.count), n(e.visitors)])));
  }
  console.log(`\n${c.dim(data.analysis.message)}`);
}

async function rawEvents(key: string, flags: Flags): Promise<void> {
  const t = target(flags);
  const limit = Math.max(1, Math.min(200, Number(flags.limit) || 50));
  const data = await request<{ events: Array<Record<string, unknown>> }>(t, `/properties/${encodeURIComponent(key)}/events?limit=${limit}`);
  if (flags.json) return printJson(data);
  if (data.events.length === 0) return void console.log(c.dim('No events yet.'));
  console.log(
    table(
      ['TIME', 'TYPE', 'NAME / URL', 'VISITOR', 'COUNTRY'],
      data.events.map((e) => [new Date(Number(e.ts)).toISOString().replace('T', ' ').slice(0, 19), String(e.type), String(e.type === 'event' ? e.goal : e.url ?? ''), String(e.visitorId ?? '').slice(0, 12), String(e.country ?? '')])
    )
  );
}

/** Writes a property into splithub.config.ts (checked by reloading it). Used by `analytics create` and `analytics connect`. */
export async function addProperty(key: string, flags: Flags): Promise<{ key: string; status: 'running' | 'paused'; goals: string[]; file: string; cloud: boolean }> {
  if (!KEY.test(key)) fail('INVALID_FLAG', `"${key}" is not a valid id: lowercase letters, digits, - and _.`);
  const project = requireConfig();
  const file = relative(project.root, project.configFile);
  const before = await loadConfig(project.configFile);
  const goals = list(flags.goals ?? flags.goal);
  for (const g of goals) if (!before.goals.some((d) => d.key === g)) fail('GOAL_NOT_FOUND', `Goal "${g}" is not declared in ${file}.`, 'Declare it under goals first, or create it with npx splithub create.');
  const status = flags.status === 'paused' ? 'paused' : 'running';
  const original = readSource(project.configFile);
  const updated = insertProperty(original, { key, status, name: str(flags.name), description: str(flags.description), goals });
  await writeConfigChecked(project.configFile, original, updated, (config) => (config.properties?.some((p) => p.key === key) ? null : `"${key}" did not appear`));
  return { key, status, goals, file, cloud: before.storage.mode === 'cloud' };
}

async function createProperty(key: string, flags: Flags): Promise<void> {
  const { status, goals, file, cloud } = await addProperty(key, flags);
  const next = cloud
    ? `Run npx splithub push, then name the property where events are sent: <SplitHubProvider property="${key}"> or data-property="${key}" on sh.js.`
    : `Name the property where events are sent (<SplitHubProvider property="${key}">), then read them with npx splithub analytics ${key}.`;
  if (flags.json) return printJson({ property: key, status, goals, configFile: file, next });
  console.log(`${c.green('✔')} analytics property ${c.bold(key)} added to ${c.dim(file)}`);
  console.log(c.dim(`Next: ${next}`));
}

async function setStatus(key: string, status: 'running' | 'paused', flags: Flags): Promise<void> {
  const project = requireConfig();
  const file = relative(project.root, project.configFile);
  const before = await loadConfig(project.configFile);
  const current = before.properties?.find((p) => p.key === key);
  let changedFile = false;
  if (current && current.status !== status) {
    const original = readSource(project.configFile);
    await writeConfigChecked(project.configFile, original, setPropertyStatus(original, key, status), (config) => (config.properties?.find((p) => p.key === key)?.status === status ? null : `"${key}" did not change`));
    changedFile = true;
  }
  let live = 'skipped';
  if (before.storage.mode === 'cloud') {
    const t = cloudTarget(flags);
    if (!t.token) live = 'no API key (run npx splithub login or set SPLITHUB_API_KEY to apply it without a deploy)';
    else {
      try {
        await request(t, `/properties/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
        live = 'applied';
      } catch (error) {
        live = `cloud refused: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  if (!current && live !== 'applied') fail('PROPERTY_NOT_FOUND', `There's no analytics property "${key}" in ${file}.`, 'See the ids with npx splithub analytics.');
  if (flags.json) return printJson({ property: key, status, configFile: changedFile ? file : null, live });
  console.log(`${c.green('✔')} ${c.bold(key)} → ${status}${changedFile ? c.dim(` (${file})`) : ''}`);
  if (live === 'applied') console.log(`${c.green('✔')} live in the cloud within 60s, no deploy needed`);
  else if (live !== 'skipped') console.log(c.yellow(`! ${live}`));
}

/**
 * Archive or restore a property in SplitHub Cloud, as the dashboard does: the same PATCH, for a
 * dashboard-made or a config property alike (the file is left as it is; push keeps it archived).
 */
async function archive(key: string, archived: boolean, flags: Flags): Promise<void> {
  const t = cloudOnly(flags, 'Archived properties', false);
  const data = await request<{ property: PropertyView }>(t, `/properties/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify({ archived }) });
  const status = data.property.archived ? 'archived' : data.property.status;
  const next = archived ? `Bring it back with npx splithub analytics restore ${key}.` : `It is paused: start collecting again with npx splithub analytics resume ${key}.`;
  if (flags.json) return printJson({ property: key, status, archived: Boolean(data.property.archived), live: 'applied', next });
  console.log(`${c.green('✔')} ${c.bold(key)} → ${status}`);
  console.log(c.dim(`Next: ${next}`));
}

async function remove(key: string, flags: Flags): Promise<void> {
  const project = requireConfig();
  const file = relative(project.root, project.configFile);
  const before = await loadConfig(project.configFile);
  const inFile = before.properties?.some((p) => p.key === key);
  if (inFile) {
    const original = readSource(project.configFile);
    await writeConfigChecked(project.configFile, original, removeProperty(original, key), (config) => (config.properties?.some((p) => p.key === key) ? `"${key}" is still there` : null));
  }
  let cloud = 'skipped';
  if (before.storage.mode === 'cloud' && !inFile) {
    // Made in the dashboard: delete it there (its numbers go with it).
    const t = cloudTarget(flags);
    if (t.token) {
      await request(t, `/properties/${encodeURIComponent(key)}`, { method: 'DELETE' });
      cloud = 'deleted';
    }
  }
  if (!inFile && cloud !== 'deleted') fail('PROPERTY_NOT_FOUND', `There's no analytics property "${key}" in ${file}.`, 'See the ids with npx splithub analytics.');
  const next = inFile && before.storage.mode === 'cloud' ? 'Run npx splithub push: the cloud stops counting it then.' : null;
  if (flags.json) return printJson({ property: key, removed: true, configFile: inFile ? file : null, cloud, ...(next ? { next } : {}) });
  console.log(`${c.green('✔')} ${c.bold(key)} removed${inFile ? c.dim(` from ${file}`) : ' from the cloud'}`);
  if (next) console.log(c.dim(`Next: ${next}`));
}
