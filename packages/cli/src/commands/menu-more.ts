// The menu's Links, Alerts and Notes steps (SplitHub Cloud). Each step asks a few plain questions,
// then calls the same function as `splithub links|alerts|notes …`, so the output is what scripts see.
import * as p from '@clack/prompts';
import { request, requireCloudToken } from '../api';
import { CliError } from '../errors';
import { alerts, describeRule, parseCount, type AlertRule } from './alerts';
import type { Flags } from './init';
import { links, type Link } from './links';
import { pickProperty } from './menu-analytics';
import { notes, NOTE_KINDS, type Note } from './notes';

export type PickExperiment = (flags: Flags, message: string) => Promise<string | null>;

/** What the cloud-only menu items say in a self-hosted project. */
export const CLOUD_ONLY_ITEM = (what: string) => `${what} come with SplitHub Cloud. Run npx splithub init --mode cloud to connect this app.`;

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type AlertPreset = 'usage' | 'event_count' | 'traffic_drop' | 'traffic_spike' | 'goal_silent' | 'winner' | 'loser' | 'srm' | 'no_events' | 'exposures' | 'quota';

/** Friendly starting points, grouped: account, analytics, experiments. */
export const ALERT_PRESETS: Array<{ value: AlertPreset; label: string; hint?: string }> = [
  { value: 'usage', label: 'Every N events used', hint: 'this month, e.g. every 1,000' },
  { value: 'quota', label: 'Monthly allowance almost used' },
  { value: 'event_count', label: 'When an event reaches N', hint: 'once, or every N' },
  { value: 'traffic_drop', label: 'Traffic drops', hint: 'vs the same day a week before' },
  { value: 'traffic_spike', label: 'Traffic spikes' },
  { value: 'goal_silent', label: 'A goal goes quiet', hint: 'no conversions for some hours' },
  { value: 'winner', label: 'Clear winner', hint: 'an experiment has a verdict' },
  { value: 'loser', label: 'A variant is losing' },
  { value: 'srm', label: 'Broken split', hint: 'visitors not split as configured' },
  { value: 'no_events', label: 'An experiment gets no visitors' },
  { value: 'exposures', label: 'An experiment reaches N visitors' },
];

/** "Every N events used" choices; `custom` asks for a number. */
export const USAGE_STEPS = [100, 1_000, 10_000, 100_000] as const;

const countError = (v: string) => (Number.isFinite(parseCount(v)) && parseCount(v) > 0 ? undefined : 'A number, like 1000 or 10k');

async function askCount(message: string, placeholder: string): Promise<string | null> {
  const v = await p.text({ message, placeholder, validate: countError });
  return p.isCancel(v) ? null : String(parseCount(v));
}

async function scopeExperiment(flags: Flags, pickExperiment: PickExperiment): Promise<string | null | undefined> {
  const which = await p.select<'all' | 'one'>({
    message: 'For which experiments?',
    options: [
      { value: 'all', label: 'Every running experiment' },
      { value: 'one', label: 'One experiment' },
    ],
  });
  if (p.isCancel(which)) return undefined;
  if (which === 'all') return null;
  return (await pickExperiment(flags, 'Which experiment?')) ?? undefined;
}

/** Asks what a preset needs and returns the `alerts add` flags, or null when cancelled. */
async function presetFlags(preset: AlertPreset, flags: Flags, pickExperiment: PickExperiment): Promise<Flags | null> {
  const out: Flags = {};
  const pickPct = async (message: string, values: number[]) => {
    const v = await p.select<number>({
      message,
      options: values.map((x) => ({ value: x, label: `${x}%` })),
    });
    return p.isCancel(v) ? null : String(v);
  };
  switch (preset) {
    case 'usage': {
      const step = await p.select<number | 'custom'>({
        message: 'Alert every',
        options: [...USAGE_STEPS.map((s) => ({ value: s, label: `${s.toLocaleString('en-US')} events` })), { value: 'custom', label: 'Another number' }],
      });
      if (p.isCancel(step)) return null;
      out.every = step === 'custom' ? ((await askCount('Every how many events? (100 or more)', '5000')) ?? undefined) : String(step);
      return out.every ? out : null;
    }
    case 'quota':
      out.percent = (await pickPct('Alert when this much is used', [50, 80, 90, 100])) ?? undefined;
      return out.percent ? out : null;
    case 'event_count': {
      const prop = await pickProperty(flags, 'Which property?');
      if (!prop) return null;
      out.property = prop.value;
      const event = await p.text({
        message: 'Which event? (empty = any event)',
        placeholder: 'Signup',
      });
      if (p.isCancel(event)) return null;
      if (event.trim()) out.event = event.trim();
      const count = await askCount('How many?', '1000');
      if (!count) return null;
      out.count = count;
      const repeat = await p.confirm({
        message: `Again every ${Number(count).toLocaleString('en-US')} after that?`,
        initialValue: false,
      });
      if (p.isCancel(repeat)) return null;
      out.repeat = repeat;
      return out;
    }
    case 'traffic_drop':
    case 'traffic_spike': {
      const prop = await pickProperty(flags, 'Which property?');
      if (!prop) return null;
      out.property = prop.value;
      out.percent = (await pickPct(preset === 'traffic_drop' ? 'Alert when visitors drop by' : 'Alert when visitors rise by', preset === 'traffic_drop' ? [30, 50, 70] : [50, 100, 200])) ?? undefined;
      return out.percent ? out : null;
    }
    case 'goal_silent': {
      const prop = await pickProperty(flags, 'Which property?');
      if (!prop) return null;
      out.property = prop.value;
      const goal = await p.text({
        message: 'Which goal?',
        placeholder: 'signup',
        validate: (v) => (v.trim() ? undefined : 'The goal key'),
      });
      if (p.isCancel(goal)) return null;
      out.goal = goal.trim();
      const hours = await p.select<number>({
        message: 'Quiet for',
        options: [6, 24, 72].map((h) => ({ value: h, label: `${h} hours` })),
      });
      if (p.isCancel(hours)) return null;
      out.hours = String(hours);
      return out;
    }
    case 'loser': {
      out.lift = (await pickPct('Alert when a variant is worse than control by', [5, 10, 20])) ?? undefined;
      if (!out.lift) return null;
      break;
    }
    case 'exposures': {
      const count = await askCount('How many visitors?', '10000');
      if (!count) return null;
      out.visitors = count;
      break;
    }
    case 'no_events':
      out.hours = '24';
      break;
    case 'winner':
    case 'srm':
      break;
  }
  const experiment = await scopeExperiment(flags, pickExperiment);
  if (experiment === undefined) return null;
  if (experiment) out.experiment = experiment;
  return out;
}

async function pickRule(flags: Flags, message: string): Promise<AlertRule | null> {
  const { rules } = await request<{ rules: AlertRule[] }>(requireCloudToken(flags), '/alerts');
  if (rules.length === 0) {
    p.log.warn('No alert rules yet. Add one first.');
    return null;
  }
  const picked = await p.select<string>({
    message,
    options: rules.map((r) => ({
      value: r.id,
      label: r.name,
      hint: `${r.enabled ? 'on' : 'off'} · ${describeRule(r)}`,
    })),
  });
  return p.isCancel(picked) ? null : (rules.find((r) => r.id === picked) ?? null);
}

export function alertsOptions(): Array<{
  value: 'list' | 'add' | 'toggle' | 'test' | 'delete' | 'back';
  label: string;
  hint?: string;
}> {
  return [
    { value: 'list', label: 'See rules and recent alerts' },
    { value: 'add', label: 'Add a rule', hint: 'events used, traffic, goals, winners…' },
    { value: 'toggle', label: 'Turn a rule on or off' },
    { value: 'test', label: 'Try a rule now', hint: 'what would fire, nothing is sent' },
    { value: 'delete', label: 'Delete a rule' },
    { value: 'back', label: 'Back' },
  ];
}

export async function alertsMenu(flags: Flags, pickExperiment: PickExperiment): Promise<void> {
  for (;;) {
    const action = await p.select({ message: 'Alerts', options: alertsOptions() });
    if (p.isCancel(action) || action === 'back') return;
    await step(async () => {
      if (action === 'list') await alerts([], flags);
      else if (action === 'add') {
        const preset = await p.select<AlertPreset>({
          message: 'Alert me when…',
          options: ALERT_PRESETS,
        });
        if (p.isCancel(preset)) return;
        const extra = await presetFlags(preset, flags, pickExperiment);
        if (extra) await alerts(['add', preset], { ...flags, ...extra });
      } else {
        const rule = await pickRule(flags, action === 'toggle' ? 'Which rule?' : action === 'test' ? 'Try which rule?' : 'Delete which rule?');
        if (!rule) return;
        if (action === 'delete') {
          const ok = await p.confirm({ message: `Delete "${rule.name}"?` });
          if (ok !== true) return;
        }
        await alerts([action === 'toggle' ? (rule.enabled ? 'disable' : 'enable') : action, rule.id], flags);
      }
    });
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const urlError = (v: string) => {
  try {
    return /^https?:$/.test(new URL(v.trim()).protocol) ? undefined : 'A full URL, like https://example.com/spring';
  } catch {
    return 'A full URL, like https://example.com/spring';
  }
};

async function pickLink(flags: Flags, message: string): Promise<Link | null> {
  const { links: list } = await request<{ links: Link[] }>(requireCloudToken(flags), '/links');
  if (list.length === 0) {
    p.log.warn('No short links yet. Create one first.');
    return null;
  }
  const picked = await p.select<string>({
    message,
    options: list.map((l) => ({
      value: l.linkId,
      label: l.shortUrl,
      hint: `${l.name} · ${l.totalClicks.toLocaleString('en-US')} clicks${l.status === 'active' ? '' : ` · ${l.status}`}`,
    })),
  });
  return p.isCancel(picked) ? null : (list.find((l) => l.linkId === picked) ?? null);
}

export function linksOptions(): Array<{
  value: 'list' | 'stats' | 'create' | 'toggle' | 'delete' | 'back';
  label: string;
  hint?: string;
}> {
  return [
    { value: 'list', label: 'See all links', hint: 'with clicks' },
    { value: 'stats', label: 'Clicks of one link', hint: 'days, destinations, countries' },
    { value: 'create', label: 'Create a link' },
    { value: 'toggle', label: 'Pause or resume a link' },
    { value: 'delete', label: 'Delete a link' },
    { value: 'back', label: 'Back' },
  ];
}

export async function linksMenu(flags: Flags): Promise<void> {
  for (;;) {
    const action = await p.select({ message: 'Short links', options: linksOptions() });
    if (p.isCancel(action) || action === 'back') return;
    await step(async () => {
      if (action === 'list') await links([], flags);
      else if (action === 'create') {
        const url = await p.text({
          message: 'Where should it go?',
          placeholder: 'https://example.com/spring',
          validate: urlError,
        });
        if (p.isCancel(url)) return;
        const slug = await p.text({
          message: 'Short name (empty = random)',
          placeholder: 'spring',
          validate: (v) => (!v.trim() || /^[a-zA-Z0-9_-]{3,32}$/.test(v.trim()) ? undefined : '3 to 32 letters, digits, - or _'),
        });
        if (p.isCancel(slug)) return;
        await links(['create', url.trim()], { ...flags, slug: slug.trim() || undefined });
      } else {
        const link = await pickLink(flags, action === 'stats' ? 'Which link?' : action === 'toggle' ? 'Pause or resume which link?' : 'Delete which link?');
        if (!link) return;
        if (action === 'delete') {
          const ok = await p.confirm({ message: `Delete ${link.shortUrl}? It stops redirecting.` });
          if (ok !== true) return;
        }
        await links([action === 'stats' ? link.linkId : action === 'toggle' ? (link.status === 'active' ? 'pause' : 'resume') : 'delete', ...(action === 'stats' ? [] : [link.linkId])], flags);
      }
    });
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export const NOTE_KIND_LABELS: Record<(typeof NOTE_KINDS)[number], string> = {
  note: 'Note',
  issue: 'Issue',
  win: 'Win',
};

async function pickNote(flags: Flags, message: string): Promise<Note | null> {
  const { notes: list } = await request<{ notes: Note[] }>(requireCloudToken(flags), '/notes');
  if (list.length === 0) {
    p.log.warn('No notes yet. Add one first.');
    return null;
  }
  const picked = await p.select<string>({
    message,
    options: list.slice(0, 30).map((n) => ({
      value: n.id,
      label: n.text.length > 60 ? `${n.text.slice(0, 59)}…` : n.text,
      hint: `${n.day} · ${n.kind}`,
    })),
  });
  return p.isCancel(picked) ? null : (list.find((n) => n.id === picked) ?? null);
}

export function notesOptions(): Array<{
  value: 'list' | 'add' | 'edit' | 'delete' | 'back';
  label: string;
  hint?: string;
}> {
  return [
    { value: 'list', label: 'See notes', hint: 'newest first' },
    { value: 'add', label: 'Add a note', hint: 'a launch, an outage, a campaign' },
    { value: 'edit', label: 'Edit a note' },
    { value: 'delete', label: 'Delete a note' },
    { value: 'back', label: 'Back' },
  ];
}

export async function notesMenu(flags: Flags, pickExperiment: PickExperiment): Promise<void> {
  for (;;) {
    const action = await p.select({ message: 'Notes', options: notesOptions() });
    if (p.isCancel(action) || action === 'back') return;
    await step(async () => {
      if (action === 'list') await notes([], flags);
      else if (action === 'add') {
        const text = await p.text({
          message: 'What happened?',
          placeholder: 'Launched the new pricing page',
          validate: (v) => (v.trim() ? undefined : 'A few words'),
        });
        if (p.isCancel(text)) return;
        const kind = await p.select<(typeof NOTE_KINDS)[number]>({
          message: 'Kind',
          options: NOTE_KINDS.map((k) => ({ value: k, label: NOTE_KIND_LABELS[k] })),
        });
        if (p.isCancel(kind)) return;
        const scope = await p.select<'project' | 'experiment' | 'property'>({
          message: 'About',
          options: [
            { value: 'project', label: 'The whole project', hint: 'shown on every chart' },
            { value: 'experiment', label: 'One experiment' },
            { value: 'property', label: 'One analytics property' },
          ],
        });
        if (p.isCancel(scope)) return;
        const extra: Flags = { kind };
        if (scope === 'experiment') {
          const key = await pickExperiment(flags, 'Which experiment?');
          if (!key) return;
          extra.experiment = key;
        } else if (scope === 'property') {
          const prop = await pickProperty(flags, 'Which property?');
          if (!prop) return;
          extra.property = prop.value;
        }
        await notes(['add', text.trim()], { ...flags, ...extra });
      } else {
        const note = await pickNote(flags, action === 'edit' ? 'Edit which note?' : 'Delete which note?');
        if (!note) return;
        if (action === 'delete') {
          const ok = await p.confirm({ message: `Delete "${note.text.slice(0, 50)}"?` });
          if (ok === true) await notes(['delete', note.id], flags);
        } else {
          const text = await p.text({
            message: 'New text',
            initialValue: note.text,
            validate: (v) => (v.trim() ? undefined : 'A few words'),
          });
          if (p.isCancel(text)) return;
          await notes(['edit', note.id, text.trim()], flags);
        }
      }
    });
    console.log();
  }
}

/** Runs one menu step; an error is shown and the submenu stays open. */
export async function step(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    if (error instanceof CliError && error.hint) p.log.info(error.hint);
  }
}
