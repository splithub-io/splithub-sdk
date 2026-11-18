// splithub alerts — alert rules on SplitHub Cloud (they run on Pro): a message on the project's
// channels (email, Slack, Discord, webhook) when something happens, and for experiments optionally
// pause / finish / drop the losing variant.
//
//   splithub alerts                                   rules (what, for what, progress, on/off) and recent alerts
//   splithub alerts add <condition> [flags]           e.g. alerts add usage --every 1000, alerts add winner --experiment hero
//   splithub alerts enable|disable|delete|test <id>   id, the start of it, or the rule's name
//
// Conditions and their flags:
//   experiments  srm | winner [--min-visitors] | loser --lift 10 [--min-visitors] | exposures --visitors N
//                | conversions --conversions N | duration --days N | no_events [--hours 24]   (--experiment <key>, else every running one)
//   account      quota [--percent 80] | usage --every 1000
//   analytics    traffic_drop|traffic_spike --property <id> [--percent 50] | goal_silent --property <id> --goal <key> [--hours 24]
//                | event_count --property <id> [--event <name>] --count N [--repeat]
//   any rule     --name "..." --cooldown <hours> --disabled; experiment rules also --pause --finish --drop-loser

import { request, requireCloudToken, type Target } from '../api';
import { CliError, fail, printJson } from '../errors';
import { c, table } from '../ui';
import { cloudOnly, n, str } from './analytics-reports';
import type { Flags } from './init';

export const ALERT_CONDITIONS = ['srm', 'winner', 'loser', 'exposures', 'conversions', 'duration', 'no_events', 'quota', 'usage', 'traffic_drop', 'traffic_spike', 'goal_silent', 'event_count'] as const;
export type AlertCondition = (typeof ALERT_CONDITIONS)[number];
const ACCOUNT: readonly string[] = ['quota', 'usage'];
const PROPERTY: readonly string[] = ['traffic_drop', 'traffic_spike', 'goal_silent', 'event_count'];

export interface AlertParams {
  minVisitors?: number;
  lift?: number;
  visitors?: number;
  conversions?: number;
  days?: number;
  hours?: number;
  percent?: number;
  property?: string;
  goal?: string;
  every?: number;
  event?: string;
  count?: number;
  repeat?: boolean;
  progress?: { total: number; fired: number; month?: string };
}

export interface AlertRule {
  id: string;
  experiment: string | null;
  name: string;
  condition: AlertCondition;
  params: AlertParams;
  actions: { channels: string[]; pause: boolean; finish: boolean; dropLoser: boolean };
  enabled: boolean;
  cooldownHours: number;
  lastFiredAt: string | null;
}

interface AlertsData {
  plan: string;
  rules: AlertRule[];
  channels: Array<{ id: string; type: string; name: string }>;
  history: Array<{
    id: string;
    experiment: string | null;
    kind: string;
    message: string;
    createdAt: string;
    ruleId: string | null;
  }>;
}

const enc = encodeURIComponent;

/** `1000`, `1,000`, `10k`, `1.5m` → a number; NaN otherwise. */
export function parseCount(v: unknown): number {
  if (typeof v !== 'string' || !v.trim()) return Number.NaN;
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(v.trim().replace(/[,_\s](?=\d)/g, ''));
  if (!m) return Number.NaN;
  return Math.round(Number(m[1]) * (m[2]?.toLowerCase() === 'k' ? 1_000 : m[2]?.toLowerCase() === 'm' ? 1_000_000 : 1));
}

/** What the rule watches, in one plain line. */
export function describeRule(r: Pick<AlertRule, 'condition' | 'params'>): string {
  const p = r.params;
  switch (r.condition) {
    case 'srm':
      return 'The split breaks (SRM)';
    case 'winner':
      return 'A clear winner';
    case 'loser':
      return `A variant ${p.lift ?? 0}%+ worse than control`;
    case 'exposures':
      return `${n(p.visitors ?? 0)} visitors reached`;
    case 'conversions':
      return `${n(p.conversions ?? 0)} conversions reached`;
    case 'duration':
      return `Running for ${p.days ?? 0} days`;
    case 'no_events':
      return `No visitors for ${p.hours ?? 24}h`;
    case 'quota':
      return `${p.percent ?? 80}% of the monthly allowance used`;
    case 'usage':
      return `Every ${n(p.every ?? 0)} events used`;
    case 'traffic_drop':
      return `Visitors down ${p.percent ?? 50}%+ vs a week before`;
    case 'traffic_spike':
      return `Visitors up ${p.percent ?? 50}%+ vs a week before`;
    case 'goal_silent':
      return `No ${p.goal ?? 'goal'} for ${p.hours ?? 24}h`;
    case 'event_count':
      return `${p.event ?? 'Any event'} ${p.repeat ? 'every' : 'reaches'} ${n(p.count ?? 0)}`;
    default:
      return r.condition;
  }
}

/** What the rule applies to. */
export function ruleTarget(r: Pick<AlertRule, 'condition' | 'params' | 'experiment'>): string {
  if (ACCOUNT.includes(r.condition)) return 'this project';
  if (PROPERTY.includes(r.condition)) return `property ${r.params.property ?? '?'}`;
  return r.experiment ? `experiment ${r.experiment}` : 'every running experiment';
}

/** Milestone rules: how far the count got. */
export function ruleProgress(r: Pick<AlertRule, 'condition' | 'params'>): string {
  const pr = r.params.progress;
  if (!pr) return '';
  if (r.condition === 'usage' && r.params.every) return `${n(pr.total)} used this month, next at ${n((pr.fired + 1) * r.params.every)}`;
  if (r.condition === 'event_count' && r.params.count) {
    if (!r.params.repeat && pr.fired > 0) return `${n(pr.total)} counted, done`;
    return `${n(pr.total)} of ${n((pr.fired + 1) * r.params.count)}`;
  }
  return '';
}

function count(flags: Flags, flag: string, why: string): number {
  const v = parseCount(flags[flag]);
  if (!Number.isFinite(v) || v <= 0) fail('USAGE', `--${flag} N: ${why}.`);
  return v;
}
const optional = (flags: Flags, flag: string): number | undefined => {
  if (flags[flag] === undefined) return undefined;
  const v = parseCount(flags[flag]);
  if (!Number.isFinite(v) || v < 0) fail('INVALID_FLAG', `--${flag} ${String(flags[flag])}: a number.`);
  return v;
};

/** POST body of a new rule from the typed condition and flags. */
export function ruleBody(condition: string, flags: Flags): Record<string, unknown> {
  if (!(ALERT_CONDITIONS as readonly string[]).includes(condition)) fail('USAGE', `Which condition? One of ${ALERT_CONDITIONS.join(', ')}.`, 'Example: npx splithub alerts add usage --every 1000');
  const params: AlertParams = {};
  const property = str(flags.property);
  const needProperty = () => {
    if (!property) fail('USAGE', `--property <id>: which analytics property to watch.`);
    params.property = property;
  };
  switch (condition as AlertCondition) {
    case 'winner':
    case 'loser':
      if (optional(flags, 'min-visitors') !== undefined) params.minVisitors = optional(flags, 'min-visitors');
      if (condition === 'loser') params.lift = optional(flags, 'lift') ?? 10;
      break;
    case 'exposures':
      params.visitors = count(flags, 'visitors', 'alert once the experiment reaches this many visitors');
      break;
    case 'conversions':
      params.conversions = count(flags, 'conversions', 'alert once the experiment reaches this many conversions');
      break;
    case 'duration':
      params.days = count(flags, 'days', 'alert once the experiment has run this many days');
      break;
    case 'no_events':
    case 'goal_silent':
      params.hours = optional(flags, 'hours') ?? 24;
      if (condition === 'goal_silent') {
        needProperty();
        const goal = str(flags.goal);
        if (!goal) fail('USAGE', '--goal <key>: the goal that should keep converting.');
        params.goal = goal;
      }
      break;
    case 'quota':
      params.percent = optional(flags, 'percent') ?? 80;
      break;
    case 'usage':
      params.every = count(flags, 'every', 'alert each time this many more events are used this month (100 or more)');
      if (params.every < 100) fail('INVALID_FLAG', '--every: 100 or more.');
      break;
    case 'traffic_drop':
    case 'traffic_spike':
      needProperty();
      params.percent = optional(flags, 'percent') ?? 50;
      break;
    case 'event_count':
      needProperty();
      if (str(flags.event)) params.event = str(flags.event);
      params.count = count(flags, 'count', 'alert when the event reaches this many');
      params.repeat = Boolean(flags.repeat);
      break;
    case 'srm':
      break;
  }
  const experiment = str(flags.experiment);
  if (experiment && (ACCOUNT.includes(condition) || PROPERTY.includes(condition))) fail('USAGE', `${condition} is not about one experiment: drop --experiment.`);
  const doing = {
    pause: Boolean(flags.pause),
    finish: Boolean(flags.finish),
    dropLoser: Boolean(flags['drop-loser']),
  };
  if ((doing.pause || doing.finish || doing.dropLoser) && (ACCOUNT.includes(condition) || PROPERTY.includes(condition))) fail('USAGE', 'This rule can only send a message: drop --pause / --finish / --drop-loser.');
  if (doing.dropLoser && condition !== 'loser' && condition !== 'winner') fail('USAGE', '--drop-loser goes with winner or loser.');
  const cooldown = optional(flags, 'cooldown');
  return {
    condition,
    params,
    actions: { notify: true, ...doing },
    ...(str(flags.name) ? { name: str(flags.name) } : {}),
    ...(experiment ? { experiment } : {}),
    ...(cooldown ? { cooldownHours: cooldown } : {}),
    enabled: !flags.disabled,
  };
}

async function load(t: Target): Promise<AlertsData> {
  return request<AlertsData>(t, '/alerts');
}

/** A rule by id, the start of its id, or its name. */
export function pickRule(rules: AlertRule[], want: string): AlertRule {
  const w = want.toLowerCase();
  const rule = rules.find((r) => r.id === want) ?? rules.find((r) => w.length >= 4 && r.id.startsWith(w)) ?? rules.find((r) => r.name.toLowerCase() === w);
  if (!rule) fail('NOT_FOUND', `There's no alert rule "${want}".`, 'See them with npx splithub alerts.');
  return rule;
}

export async function addRule(t: Target, body: Record<string, unknown>): Promise<{ rule: AlertRule; savedOff: boolean }> {
  try {
    return {
      ...(await request<{ rule: AlertRule }>(t, '/alerts/rules', {
        method: 'POST',
        body: JSON.stringify(body),
      })),
      savedOff: false,
    };
  } catch (error) {
    // Free plan: keep the rule, switched off, so upgrading is the only step left.
    if (error instanceof CliError && error.code === 'PRO_REQUIRED' && body.enabled !== false) {
      return {
        ...(await request<{ rule: AlertRule }>(t, '/alerts/rules', {
          method: 'POST',
          body: JSON.stringify({ ...body, enabled: false }),
        })),
        savedOff: true,
      };
    }
    throw error;
  }
}

export async function alerts(args: string[], flags: Flags): Promise<void> {
  const t = cloudOnly(flags, 'Alerts', false);
  if (!t.token) requireCloudToken(flags);
  const [action, arg] = args;
  if (!action || action === 'list') return list(t, flags);
  if (action === 'add' || action === 'create') {
    if (!arg) fail('USAGE', `Which condition? npx splithub alerts add <condition>: ${ALERT_CONDITIONS.join(', ')}.`, 'Example: npx splithub alerts add usage --every 1000');
    const out = await addRule(t, ruleBody(arg, flags));
    if (flags.json) return printJson(out);
    console.log(`${c.green('✔')} ${c.bold(out.rule.name)} ${c.dim(`(${ruleTarget(out.rule)})`)}`);
    if (out.savedOff) console.log(c.yellow('! Saved, switched off: alert rules run on Pro. Upgrade in the dashboard (Billing), then npx splithub alerts enable ' + out.rule.id.slice(0, 8)));
    return;
  }
  if (!['enable', 'disable', 'delete', 'remove', 'test'].includes(action)) fail('USAGE', `Unknown "alerts ${action}". Use alerts, alerts add <condition>, alerts enable|disable|delete|test <id>.`);
  if (!arg) fail('USAGE', `Which rule? npx splithub alerts ${action} <id> (ids are in npx splithub alerts).`);
  const rule = pickRule((await load(t)).rules, arg);
  const path = `/alerts/rules/${enc(rule.id)}`;
  if (action === 'test') {
    const out = await request<{ matches: Array<{ experiment: string | null; message: string }> }>(t, `${path}/test`, { method: 'POST', body: '{}' });
    if (flags.json) return printJson({ rule: rule.id, ...out });
    if (out.matches.length === 0) return void console.log(c.dim(`${rule.name}: nothing matches right now, so it would stay quiet.`));
    console.log(`${c.bold(rule.name)} would fire now:`);
    for (const m of out.matches) console.log(`  ${m.experiment ? c.dim(`${m.experiment}: `) : ''}${m.message}`);
    return;
  }
  if (action === 'delete' || action === 'remove') {
    await request(t, path, { method: 'DELETE' });
    if (flags.json) return printJson({ ok: true, id: rule.id });
    console.log(`${c.green('✔')} ${rule.name} deleted`);
    return;
  }
  const out = await request<{ rule: AlertRule }>(t, path, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: action === 'enable' }),
  });
  if (flags.json) return printJson(out);
  console.log(`${c.green('✔')} ${rule.name} ${action === 'enable' ? 'is on' : 'is off'}`);
}

async function list(t: Target, flags: Flags): Promise<void> {
  const data = await load(t);
  if (flags.json)
    return printJson({
      plan: data.plan,
      rules: data.rules,
      channels: data.channels,
      history: data.history,
    });
  if (data.rules.length === 0) console.log(c.dim('No alert rules yet. Add one: npx splithub alerts add usage --every 1000'));
  else {
    console.log(
      table(
        ['RULE', 'WHEN', 'FOR', 'PROGRESS', 'STATUS', 'ID'],
        data.rules.map((r) => [c.bold(r.name), describeRule(r), ruleTarget(r), ruleProgress(r) || c.dim('–'), r.enabled ? c.green('on') : c.dim('off'), c.dim(r.id.slice(0, 8))])
      )
    );
  }
  if (data.plan !== 'pro' && data.rules.length) console.log(c.dim('\nAlert rules run on Pro: they fire once the project is on Pro (dashboard, Billing).'));
  if (data.channels.length === 0) console.log(c.dim('Where alerts go (email, Slack, Discord, webhook) is set in the dashboard, under Alerts.'));
  if (data.history.length) {
    console.log(`\n${c.bold('Recent alerts')}`);
    for (const h of data.history.slice(0, 5)) console.log(`${c.dim(h.createdAt.slice(0, 16).replace('T', ' '))}  ${h.message}`);
  }
}
