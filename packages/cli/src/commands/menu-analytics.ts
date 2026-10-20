// The menu's analytics steps: set up (connect), properties (list, create, report, raw events, pause/resume), the
// cloud reports (realtime, funnel, paths, retention) and allowed domains. Each step calls the same command function as `splithub analytics …` /
// `splithub domains …`, so the output is the one scripts see without --json.
import * as p from '@clack/prompts';
import { newPropertyId } from '@splithub/core';
import { request, resolveTarget } from '../api';
import { loadConfig } from '../config-file';
import { detectProject } from '../project';
import { analytics } from './analytics';
import { domains } from './domains';
import type { Flags } from './init';

export type Mode = 'cloud' | 'self';
type AnalyticsAction = 'connect' | 'list' | 'report' | 'realtime' | 'funnel' | 'paths' | 'retention' | 'events' | 'create' | 'toggle' | 'back';
export interface PropertyChoice {
  value: string;
  label: string;
  hint: string;
  status: string;
}

export const REPORT_SPANS = [7, 30, 90] as const;
export const REPORT_BREAKDOWNS = ['page', 'source', 'channel', 'country', 'device', 'event', 'goal'] as const;
export const FUNNEL_WITHIN = [
  { value: 'visit', label: 'In one visit' },
  { value: '7d', label: 'Within 7 days' },
  { value: '30d', label: 'Within 30 days' },
] as const;

/** Why a typed funnel is refused, or undefined: 2 to 8 steps, each page:, event: or goal:. */
export function funnelStepsError(input: string): string | undefined {
  const steps = input.split(',').map((s) => s.trim()).filter(Boolean);
  if (steps.length < 2) return 'Two steps at least, separated by commas';
  if (steps.length > 8) return 'Eight steps at most';
  const bad = steps.find((s) => !/^(page:\/\S*|event:.+|goal:.+)$/.test(s));
  return bad ? `"${bad}": start with page:/, event: or goal:` : undefined;
}
export const CLOUD_ONLY = 'Allowed domains come with SplitHub Cloud: a self-hosted endpoint accepts events from wherever you mount it.';

/** Options of the Analytics submenu. Realtime, funnels, paths and retention come with SplitHub Cloud; the rest reads raw counts when self-hosted. */
export function analyticsOptions(mode: Mode = 'cloud'): Array<{ value: AnalyticsAction; label: string; hint?: string }> {
  const cloud: Array<{ value: AnalyticsAction; label: string; hint?: string }> = [
    { value: 'realtime', label: "Who's here now", hint: 'last 5 minutes' },
    { value: 'funnel', label: 'Build a funnel', hint: 'pages, events, goals in order' },
    { value: 'paths', label: 'Where visitors go next' },
    { value: 'retention', label: 'Who comes back', hint: 'weekly cohorts' },
  ];
  return [
    { value: 'connect', label: 'Set up analytics in this app', hint: 'pick a property, name it in the code, send events' },
    { value: 'list', label: 'See all properties', hint: 'last 30 days' },
    { value: 'report', label: 'Open a report', hint: 'visitors, pages, sources, goals' },
    ...(mode === 'cloud' ? cloud : []),
    { value: 'events', label: 'Latest raw events' },
    { value: 'create', label: 'Create a property' },
    { value: 'toggle', label: 'Pause or resume a property' },
    { value: 'back', label: 'Back' },
  ];
}

/** Select options from `GET /properties`: the cloud answers `{ key, name, status, last30 }`, self-hosted `{ property, name, status, counts }`. */
export function propertyChoices(data: { properties: Array<Record<string, unknown>> }): PropertyChoice[] {
  return data.properties.flatMap((row) => {
    const key = typeof row.key === 'string' ? row.key : typeof row.property === 'string' ? row.property : null;
    if (!key) return [];
    const name = typeof row.name === 'string' && row.name ? row.name : null;
    const status = typeof row.status === 'string' ? row.status : 'running';
    const sums = (row.last30 ?? row.counts) as { visitors?: unknown } | null | undefined;
    const visitors = typeof sums?.visitors === 'number' ? sums.visitors : null;
    return [{ value: key, label: name ? `${name} (${key})` : key, hint: visitors === null ? status : `${status} · ${visitors.toLocaleString('en-US')} visitors`, status }];
  });
}

/** Where to name the property so its events arrive: the React provider prop and the sh.js tag. */
export function propertySnippets(key: string, publicKey?: string | null): { provider: string; script: string } {
  return {
    provider: `<SplitHubProvider config={config} property="${key}">`,
    script: `<script src="https://go.splithub.io/sh.js" data-key="${publicKey ?? 'pk_…'}" data-property="${key}" async></script>`,
  };
}

/** Hosts typed in one line: spaces or commas, schemes and paths dropped (`https://a.com/x` → `a.com`). */
export function parseHosts(input: string): string[] {
  const hosts = input
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, ''))
    .filter(Boolean);
  return [...new Set(hosts)];
}

async function choices(flags: Flags): Promise<PropertyChoice[]> {
  const project = detectProject();
  try {
    return propertyChoices(await request<{ properties: Array<Record<string, unknown>> }>(resolveTarget(flags, project), '/properties'));
  } catch {
    // The dev server is down or the folder is not connected: the config file still knows the ids.
    if (!project.configFile) return [];
    const config = await loadConfig(project.configFile);
    return (config.properties ?? []).map((prop) => ({ value: prop.key, label: prop.name ? `${prop.name} (${prop.key})` : prop.key, hint: prop.status, status: prop.status }));
  }
}

export async function pickProperty(flags: Flags, message: string): Promise<PropertyChoice | null> {
  const list = await choices(flags);
  if (list.length === 0) {
    p.log.warn('No analytics properties yet. Create one first.');
    return null;
  }
  const picked = await p.select({ message, options: list.map(({ value, label, hint }) => ({ value, label, hint })) });
  if (p.isCancel(picked)) return null;
  return list.find((x) => x.value === picked) ?? null;
}

async function createStep(flags: Flags): Promise<void> {
  const name = await p.text({ message: 'Name of the property', placeholder: 'Marketing site' });
  if (p.isCancel(name)) return;
  const key = newPropertyId();
  await analytics(['create', key], { ...flags, name: name.trim() || undefined });
  const s = propertySnippets(key);
  p.note(`React / Next.js:\n  ${s.provider}\n\nAny site, with sh.js:\n  ${s.script}`, `Send events to ${key}`);
}

async function reportStep(flags: Flags, mode: Mode): Promise<void> {
  const prop = await pickProperty(flags, 'Which property?');
  if (!prop) return;
  let days: number = 30;
  for (;;) {
    const span = await p.select({ message: 'Which period?', initialValue: days, options: REPORT_SPANS.map((d) => ({ value: d, label: `Last ${d} days` })) });
    if (p.isCancel(span)) return;
    days = span;
    await analytics([prop.value], { ...flags, days: String(days) });
    // Self-hosted answers raw counts only; breakdowns are computed in the cloud.
    if (mode !== 'cloud') return;
    for (;;) {
      console.log();
      const by = await p.select<string>({
        message: 'Break it down?',
        options: [...REPORT_BREAKDOWNS.map((b) => ({ value: b, label: `By ${b}` })), ...(mode === 'cloud' ? [{ value: 'compare', label: 'Compare with the period before' }] : []), { value: 'span', label: 'Another period' }, { value: 'done', label: 'Done' }],
      });
      if (p.isCancel(by) || by === 'done') return;
      if (by === 'span') break;
      if (by === 'compare') await analytics([prop.value], { ...flags, days: String(days), compare: 'previous' });
      else await analytics([prop.value], { ...flags, days: String(days), by });
    }
  }
}

async function funnelStep(flags: Flags): Promise<void> {
  const prop = await pickProperty(flags, 'Funnel of which property?');
  if (!prop) return;
  const steps = await p.text({ message: 'Steps, in order', placeholder: 'page:/, page:/pricing, event:Signup, goal:paid', validate: funnelStepsError });
  if (p.isCancel(steps)) return;
  const within = await p.select<string>({ message: 'Counted when they happen', options: FUNNEL_WITHIN.map((w) => ({ value: w.value, label: w.label })) });
  if (p.isCancel(within)) return;
  await analytics(['funnel', prop.value], { ...flags, steps, within });
}

async function pathsStep(flags: Flags): Promise<void> {
  const prop = await pickProperty(flags, 'Paths of which property?');
  if (!prop) return;
  const page = await p.text({ message: 'Which page?', placeholder: '/pricing', validate: (v) => (v.trim().startsWith('/') ? undefined : 'A path like /pricing') });
  if (p.isCancel(page)) return;
  const direction = await p.select<'next' | 'prev'>({ message: 'Show', options: [{ value: 'next', label: 'Where visitors go next' }, { value: 'prev', label: 'Where they came from' }] });
  if (p.isCancel(direction)) return;
  await analytics(['paths', prop.value], { ...flags, page: page.trim(), prev: direction === 'prev' });
}

async function retentionStep(flags: Flags): Promise<void> {
  const prop = await pickProperty(flags, 'Retention of which property?');
  if (!prop) return;
  const period = await p.select<'week' | 'day'>({ message: 'Cohorts by', options: [{ value: 'week', label: 'Week', hint: 'last 12 weeks' }, { value: 'day', label: 'Day', hint: 'last 30 days' }] });
  if (p.isCancel(period)) return;
  await analytics(['retention', prop.value], { ...flags, period, days: period === 'week' ? '84' : '30' });
}

export async function analyticsMenu(flags: Flags, mode: Mode): Promise<void> {
  for (;;) {
    const action = await p.select<AnalyticsAction>({ message: 'Analytics', options: analyticsOptions(mode) });
    if (p.isCancel(action) || action === 'back') return;
    switch (action) {
      case 'connect':
        await analytics(['connect'], flags);
        break;
      case 'list':
        await analytics([], flags);
        break;
      case 'report':
        await reportStep(flags, mode);
        break;
      case 'realtime': {
        const prop = await pickProperty(flags, 'Which property?');
        if (prop) await analytics(['realtime', prop.value], flags);
        break;
      }
      case 'funnel':
        await funnelStep(flags);
        break;
      case 'paths':
        await pathsStep(flags);
        break;
      case 'retention':
        await retentionStep(flags);
        break;
      case 'events': {
        const prop = await pickProperty(flags, 'Events of which property?');
        if (prop) await analytics(['events', prop.value], flags);
        break;
      }
      case 'create':
        await createStep(flags);
        break;
      case 'toggle': {
        const prop = await pickProperty(flags, 'Which property?');
        if (!prop) break;
        const verb = prop.status === 'paused' ? 'resume' : 'pause';
        const ok = await p.confirm({ message: `${verb === 'pause' ? 'Pause' : 'Resume'} ${prop.label}?` });
        if (ok === true) await analytics([verb, prop.value], flags);
        break;
      }
    }
    console.log();
  }
}

/** Allowed domains: the list, then set or clear one experiment's or property's origins. */
export async function domainsMenu(flags: Flags, mode: Mode, pickExperiment: (flags: Flags, message: string) => Promise<string | null>): Promise<void> {
  if (mode !== 'cloud') {
    p.log.info(CLOUD_ONLY);
    return;
  }
  await domains([], flags);
  console.log();
  const action = await p.select<'set' | 'clear' | 'back'>({
    message: 'Change one?',
    options: [
      { value: 'set', label: 'Limit to some domains', hint: 'subdomains are included' },
      { value: 'clear', label: 'Accept any origin again' },
      { value: 'back', label: 'Back' },
    ],
  });
  if (p.isCancel(action) || action === 'back') return;
  const kind = await p.select<'experiment' | 'property'>({ message: 'For what?', options: [{ value: 'experiment', label: 'An experiment' }, { value: 'property', label: 'An analytics property' }] });
  if (p.isCancel(kind)) return;
  const key = kind === 'experiment' ? await pickExperiment(flags, 'Which experiment?') : (await pickProperty(flags, 'Which property?'))?.value;
  if (!key) return;
  if (action === 'clear') return domains(['clear', kind, key], flags);
  const typed = await p.text({ message: 'Domains, separated by spaces or commas', placeholder: 'example.com app.example.com', validate: (v) => (parseHosts(v).length === 0 ? 'Type at least one domain' : undefined) });
  if (p.isCancel(typed)) return;
  await domains(['set', kind, key, ...parseHosts(typed)], flags);
}
