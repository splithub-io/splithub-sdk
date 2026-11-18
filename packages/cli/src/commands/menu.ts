// `npx splithub` with no arguments: one menu for everything, step by step (like an interactive
// assistant), so nobody has to learn the flags. The top level stays short: experiments, analytics,
// links, alerts, notes, domains, then the project chores; longer areas open a submenu.
// Agents and scripts keep using the subcommands + --json.
import * as p from '@clack/prompts';
import { readFileSync } from 'node:fs';
import { cloudTarget, fetchStatus, resolveTarget } from '../api';
import { loadCredential } from '../credentials';
import { detectProject } from '../project';
import { CliError } from '../errors';
import { c } from '../ui';
import { create } from './create';
import { dev } from './dev';
import { EXPERIMENT_FILTERS, experimentEvents } from './experiment-reports';
import { doctor } from './doctor';
import { init, type Flags } from './init';
import { lifecycle } from './lifecycle';
import { analyticsMenu, domainsMenu } from './menu-analytics';
import { alertsMenu, CLOUD_ONLY_ITEM, linksMenu, notesMenu, step } from './menu-more';
import { login, logout } from './login';
import { pull, push } from './push';
import { results } from './results';
import { skills } from './skills';
import { status } from './status';

export type Action = 'init' | 'login' | 'experiments' | 'analytics' | 'links' | 'alerts' | 'notes' | 'domains' | 'sync' | 'dev' | 'doctor' | 'skills' | 'logout' | 'exit';
type ExperimentAction = 'create' | 'status' | 'results' | 'filtered' | 'breakdown' | 'timeline' | 'events' | 'start' | 'pause' | 'finish' | 'back';
type Option<T> = { value: T; label: string; hint?: string };

export interface MenuState {
  hasConfig: boolean;
  mode: 'cloud' | 'self' | null;
  connected: boolean;
  signedIn: boolean;
}

function state(flags: Flags) {
  const project = detectProject();
  const api = cloudTarget({ api: flags.api }).url;
  const cred = loadCredential(api, project.root);
  const mode: 'cloud' | 'self' | null = project.configFile ? (/mode\s*:\s*['"]cloud['"]/.test(readSafe(project.configFile)) ? 'cloud' : 'self') : null;
  return { project, cred, mode, connected: Boolean(cred || process.env.SPLITHUB_API_KEY) };
}

function readSafe(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** The top level. Cloud-only areas stay listed in a self-hosted project and say how to get them. */
export function menuOptions(s: MenuState): Array<Option<Action>> {
  if (!s.hasConfig)
    return [
      {
        value: 'init',
        label: 'Set up this app',
        hint: 'config, framework files, agent docs, sign-in link',
      },
      { value: 'exit', label: 'Exit' },
    ];
  const cloud = s.mode === 'cloud';
  const later = 'with SplitHub Cloud';
  return [
    ...(cloud && !s.connected
      ? [
          {
            value: 'login' as const,
            label: 'Connect to SplitHub Cloud',
            hint: 'opens a sign-in link',
          },
        ]
      : []),
    {
      value: 'experiments',
      label: 'Experiments',
      hint: 'create, status, results, start, pause, finish',
    },
    {
      value: 'analytics',
      label: 'Analytics',
      hint: cloud ? 'set up, visitors, pages, sources, funnels' : 'set up, raw counts from your database',
    },
    {
      value: 'links',
      label: 'Short links',
      hint: cloud ? 'one URL, split across pages, clicks counted' : later,
    },
    {
      value: 'alerts',
      label: 'Alerts',
      hint: cloud ? 'events used, traffic, goals, winners' : later,
    },
    {
      value: 'notes',
      label: 'Notes',
      hint: cloud ? 'launches, outages, wins on the charts' : later,
    },
    {
      value: 'domains',
      label: 'Allowed domains',
      hint: cloud ? 'which sites may send events' : later,
    },
    ...(cloud
      ? [
          {
            value: 'sync' as const,
            label: 'Push or pull the config',
            hint: 'after editing splithub.config.ts',
          },
        ]
      : []),
    {
      value: 'dev',
      label: 'Test locally in the browser',
      hint: 'debug panel: variants, reasons, events',
    },
    { value: 'doctor', label: 'Check the installation' },
    { value: 'skills', label: 'Agent skills + MCP server', hint: 'Claude Code, Cursor, Codex' },
    ...(s.signedIn ? [{ value: 'logout' as const, label: 'Disconnect this folder' }] : []),
    { value: 'exit', label: 'Exit' },
  ];
}

/** Options of the Experiments submenu. Slices, breakdowns, timelines and raw events come with SplitHub Cloud. */
export function experimentOptions(mode: 'cloud' | 'self' = 'cloud'): Array<Option<ExperimentAction>> {
  const cloud: Array<Option<ExperimentAction>> = [
    { value: 'filtered', label: 'Results with filters or dates', hint: 'first-seen days, country, device, source' },
    { value: 'breakdown', label: 'Breakdown', hint: 'lift per country, device, source' },
    { value: 'timeline', label: 'Timeline', hint: 'visitors and conversions per day' },
    { value: 'events', label: 'Raw events', hint: 'latest exposures and goals' },
  ];
  return [
    {
      value: 'create',
      label: 'Create an experiment',
      hint: 'step by step; its goal can be any event',
    },
    { value: 'status', label: 'Status of all experiments' },
    { value: 'results', label: 'Results of one experiment', hint: 'verdict, lift, confidence' },
    ...(mode === 'cloud' ? cloud : []),
    { value: 'start', label: 'Start an experiment' },
    { value: 'pause', label: 'Pause an experiment' },
    { value: 'finish', label: 'Finish an experiment' },
    { value: 'back', label: 'Back' },
  ];
}

async function pickExperiment(flags: Flags, message: string): Promise<string | null> {
  try {
    const data = await fetchStatus(resolveTarget(flags, detectProject()));
    if (data.experiments.length === 0) {
      p.log.warn('No experiments yet. Create one first.');
      return null;
    }
    const picked = await p.select({
      message,
      options: data.experiments.map((e) => ({
        value: e.experiment,
        label: e.experiment,
        hint: `${e.status} · ${e.visitors} visitors${e.headline ? ` · ${e.headline}` : ''}`,
      })),
    });
    if (p.isCancel(picked)) return null;
    return picked as string;
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Menu periods for a slice: first-exposure days. */
export const SLICE_SPANS = [7, 30, 90] as const;
/** Breakdowns offered in the menu; any of EXPERIMENT_BY works from the command line. */
export const MENU_BREAKDOWNS = ['country', 'device', 'source', 'channel', 'landing', 'browser', 'os', 'utm_campaign'] as const;

/**
 * Typed filters (`country=DE,FR device=mobile channel=Paid Search`) as --filter values, or why they
 * are refused. A word without `=` belongs to the value before it, so values may hold spaces.
 */
export function parseFilterInput(input: string): { filters: string[] } | { error: string } {
  const parts: string[] = [];
  for (const word of input.trim().split(/\s+/).filter(Boolean)) {
    if (!word.includes('=') && parts.length) parts[parts.length - 1] += ` ${word}`;
    else parts.push(word);
  }
  for (const part of parts) {
    const at = part.indexOf('=');
    const k = at > 0 ? part.slice(0, at) : '';
    if (!k || at === part.length - 1) return { error: `"${part}": use name=value, like country=DE` };
    if (!(EXPERIMENT_FILTERS as readonly string[]).includes(k)) return { error: `"${k}": filter by ${EXPERIMENT_FILTERS.join(', ')}` };
  }
  return { filters: parts };
}

const RANGE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

async function filteredStep(flags: Flags, key: string): Promise<void> {
  const span = await p.select<string>({
    message: 'Visitors first seen',
    options: [{ value: 'all', label: 'All time' }, ...SLICE_SPANS.map((d) => ({ value: String(d), label: `In the last ${d} days` })), { value: 'custom', label: 'Between two days' }],
  });
  if (p.isCancel(span)) return;
  const range: Flags = {};
  if (span === 'custom') {
    const typed = await p.text({ message: 'Days', placeholder: '2026-10-01..2026-10-15', validate: (v) => (RANGE.test(v.trim()) ? undefined : 'Two days like 2026-10-01..2026-10-15') });
    if (p.isCancel(typed)) return;
    const m = RANGE.exec(typed.trim())!;
    range.from = m[1];
    range.to = [m[2]!];
  } else if (span !== 'all') range.days = span;
  const typed = await p.text({
    message: 'Filters (optional)',
    placeholder: 'country=DE device=mobile channel=Paid Search',
    validate: (v) => {
      const r = parseFilterInput(v ?? '');
      return 'error' in r ? r.error : undefined;
    },
  });
  if (p.isCancel(typed)) return;
  const parsed = parseFilterInput(typed ?? '');
  const filter = 'filters' in parsed ? parsed.filters : [];
  await results(key, { ...flags, ...range, filter });
}

async function breakdownStep(flags: Flags, key: string): Promise<void> {
  for (;;) {
    const by = await p.select<string>({ message: 'Split by', options: [...MENU_BREAKDOWNS.map((b) => ({ value: b, label: b })), { value: 'done', label: 'Done' }] });
    if (p.isCancel(by) || by === 'done') return;
    await results(key, { ...flags, by });
    console.log();
  }
}

async function experimentsMenu(flags: Flags, mode: 'cloud' | 'self'): Promise<void> {
  for (;;) {
    const action = await p.select<ExperimentAction>({
      message: 'Experiments',
      options: experimentOptions(mode),
    });
    if (p.isCancel(action) || action === 'back') return;
    await step(async () => {
      if (action === 'create') await create(flags);
      else if (action === 'status') await status(flags);
      else if (action === 'results') {
        const key = await pickExperiment(flags, 'Which experiment?');
        if (key) await results(key, flags);
      } else if (action === 'filtered' || action === 'breakdown' || action === 'timeline' || action === 'events') {
        const key = await pickExperiment(flags, 'Which experiment?');
        if (!key) return;
        if (action === 'filtered') await filteredStep(flags, key);
        else if (action === 'breakdown') await breakdownStep(flags, key);
        else if (action === 'timeline') await results(key, { ...flags, timeline: true });
        else await experimentEvents(key, flags);
      } else {
        const key = await pickExperiment(flags, `Which experiment to ${action}?`);
        if (key) await lifecycle(action, key, flags);
      }
    });
    console.log();
  }
}

async function syncMenu(flags: Flags): Promise<void> {
  const action = await p.select<'push' | 'pull' | 'back'>({
    message: 'Config',
    options: [
      {
        value: 'push',
        label: 'Push splithub.config.ts to the cloud',
        hint: 'after editing the file',
      },
      { value: 'pull', label: 'Pull dashboard changes into the file' },
      { value: 'back', label: 'Back' },
    ],
  });
  if (p.isCancel(action) || action === 'back') return;
  await (action === 'push' ? push(flags) : pull(flags));
}

export async function menu(flags: Flags): Promise<void> {
  p.intro(c.bold('splithub'));
  for (;;) {
    const s = state(flags);
    const where = s.project.configFile ? `${c.green('config')} ${s.mode === 'cloud' ? 'cloud mode' : 'self-hosted'}` : c.yellow('no config yet');
    const who = s.cred ? `${c.green('connected')} to ${c.cyan(s.cred.projectName ?? s.cred.projectId ?? 'project')}` : s.mode === 'cloud' ? c.yellow('not connected') : c.dim('local only');
    p.log.info(`${c.bold(s.project.name)} (${s.project.framework}) · ${where} · ${who}`);

    const options = menuOptions({
      hasConfig: Boolean(s.project.configFile),
      mode: s.mode,
      connected: s.connected,
      signedIn: Boolean(s.cred),
    });
    const action = await p.select<Action>({ message: 'What do you want to do?', options });
    if (p.isCancel(action) || action === 'exit') break;
    const cloud = s.mode === 'cloud';
    try {
      switch (action) {
        case 'init':
          await init({ ...flags, mode: flags.mode ?? 'cloud' });
          break;
        case 'login':
          await login({ ...flags, yes: true });
          break;
        case 'experiments':
          await experimentsMenu(flags, cloud ? 'cloud' : 'self');
          break;
        case 'analytics':
          await analyticsMenu(flags, cloud ? 'cloud' : 'self');
          break;
        case 'links':
          if (cloud) await linksMenu(flags);
          else p.log.info(CLOUD_ONLY_ITEM('Short links'));
          break;
        case 'alerts':
          if (cloud) await alertsMenu(flags, pickExperiment);
          else p.log.info(CLOUD_ONLY_ITEM('Alerts'));
          break;
        case 'notes':
          if (cloud) await notesMenu(flags, pickExperiment);
          else p.log.info(CLOUD_ONLY_ITEM('Notes'));
          break;
        case 'domains':
          await domainsMenu(flags, cloud ? 'cloud' : 'self', pickExperiment);
          break;
        case 'sync':
          await syncMenu(flags);
          break;
        case 'logout':
          await logout(flags);
          break;
        case 'dev':
          await dev(flags);
          break;
        case 'doctor':
          await doctor(flags);
          break;
        case 'skills':
          await skills({ ...flags, mcp: true });
          break;
      }
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : String(error));
      if (error instanceof CliError && error.hint) p.log.info(error.hint);
    }
    console.log();
  }
  p.outro(`Scripts and agents: ${c.cyan('splithub --help')} lists every command; add ${c.cyan('--json')} for machine output.`);
}
