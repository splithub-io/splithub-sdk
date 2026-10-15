import * as p from '@clack/prompts';
import { mvtVariants, type ExperimentKind, type ExperimentStatus } from '@splithub/core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ensureLayer, hasExperiment, insertExperiment, loadConfig, readSource, writeConfigChecked, type NewExperiment } from '../config-file';
import { fail, printJson } from '../errors';
import { requireConfig } from '../project';
import { componentVariantTemplate } from '../templates';
import { c } from '../ui';
import type { Flags } from './init';

const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return [v];
  return [];
}
function parsePairs(items: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    const i = item.indexOf('=');
    if (i > 0) out[item.slice(0, i).trim()] = item.slice(i + 1);
  }
  return out;
}
function pascal(s: string): string {
  return s.replace(/(^|[-_])([a-z0-9])/g, (_, __, ch: string) => ch.toUpperCase());
}

async function ask<T>(promise: Promise<T | symbol>): Promise<T> {
  const v = await promise;
  if (p.isCancel(v)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }
  return v as T;
}

export async function create(flags: Flags): Promise<void> {
  const json = Boolean(flags.json);
  const yes = Boolean(flags.yes);
  const project = requireConfig();
  const config = await loadConfig(project.configFile);
  const source = readSource(project.configFile);
  const interactive = !yes && !json;

  if (interactive) p.intro(c.bold('splithub create'));

  let kind = str(flags.kind) as ExperimentKind | undefined;
  if (!kind) {
    if (!interactive) fail('USAGE', 'Which kind? Pass --kind value|component|redirect|mvt.');
    kind = await ask(
      p.select<ExperimentKind>({
        message: 'What changes between variants?',
        options: [
          { value: 'value', label: 'Text, image URL, number', hint: 'no new components' },
          { value: 'component', label: 'Layout / structure', hint: 'one component per variant' },
          { value: 'redirect', label: 'A whole page', hint: 'needs @splithub/next middleware' },
          { value: 'mvt', label: 'Several things at once', hint: 'multivariate: every combination, each factor read on its own' },
        ],
      })
    );
  }

  let id = str(flags.id);
  if (!id) {
    if (!interactive) fail('USAGE', 'Which id? Pass --id <key>, e.g. --id hero-title.');
    id = await ask(
      p.text({
        message: 'Experiment id',
        placeholder: 'hero-title',
        validate: (v) => (!KEY.test(v) ? 'lowercase a-z 0-9 - _ only' : hasExperiment(source, v) ? 'already exists' : undefined),
      })
    );
  }
  if (!['value', 'component', 'redirect', 'mvt'].includes(kind)) fail('INVALID_FLAG', `Unknown kind "${kind}".`, 'Use --kind value, component, redirect or mvt.');
  if (!KEY.test(id)) fail('INVALID_FLAG', `"${id}" isn't a valid id.`, 'Use lowercase a-z, 0-9, - and _, at most 64 characters.');
  if (hasExperiment(source, id) || config.experiments.some((e) => e.key === id)) fail('EXPERIMENT_EXISTS', `There's already an experiment "${id}".`, 'Pick another id: an old id keeps its history.');
  const limits = parseLimits(flags);

  // Multivariate: --factor headline=old:Old,new:New (repeatable); the variants are the combinations.
  const factors: Record<string, Record<string, string>> = {};
  if (kind === 'mvt') {
    for (const raw of list(flags.factor)) {
      const eq = raw.indexOf('=');
      if (eq <= 0) fail('INVALID_FLAG', `--factor expects name=level:value,level:value, got "${raw}".`);
      const name = raw.slice(0, eq).trim();
      const levels: Record<string, string> = {};
      for (const part of raw.slice(eq + 1).split(',')) {
        const colon = part.indexOf(':');
        const level = (colon >= 0 ? part.slice(0, colon) : part).trim();
        if (!level) continue;
        levels[level] = colon >= 0 ? part.slice(colon + 1).trim() : level;
      }
      factors[name] = levels;
    }
    while (interactive && Object.keys(factors).length === 0) {
      const name = await ask(p.text({ message: 'Factor name (what changes), e.g. headline', validate: (v) => (!KEY.test(v) ? 'lowercase a-z 0-9 - _ only' : undefined) }));
      const levelsRaw = await ask(p.text({ message: `Levels of "${name}" as key:value, comma separated (first = control)`, placeholder: 'old:Old headline, new:New headline' }));
      const levels: Record<string, string> = {};
      for (const part of levelsRaw.split(',')) {
        const colon = part.indexOf(':');
        const level = (colon >= 0 ? part.slice(0, colon) : part).trim();
        if (level) levels[level] = colon >= 0 ? part.slice(colon + 1).trim() : level;
      }
      factors[name] = levels;
      while (await ask(p.confirm({ message: 'Add another factor?', initialValue: false }))) {
        const more = await ask(p.text({ message: 'Factor name', validate: (v) => (!KEY.test(v) ? 'lowercase a-z 0-9 - _ only' : undefined) }));
        const moreRaw = await ask(p.text({ message: `Levels of "${more}" as key:value, comma separated`, placeholder: 'blue:#2563eb, green:#16a34a' }));
        const moreLevels: Record<string, string> = {};
        for (const part of moreRaw.split(',')) {
          const colon = part.indexOf(':');
          const level = (colon >= 0 ? part.slice(0, colon) : part).trim();
          if (level) moreLevels[level] = colon >= 0 ? part.slice(colon + 1).trim() : level;
        }
        factors[more] = moreLevels;
      }
    }
    if (Object.keys(factors).length === 0) fail('USAGE', 'An mvt experiment needs factors.', 'Pass --factor name=level:value,level:value once per factor.');
    if (flags.variants || flags.weights) fail('INVALID_FLAG', 'An mvt experiment takes --factor, not --variants or --weights.', 'Its variants are every combination of the factor levels, split equally.');
  }
  let mvt: ReturnType<typeof mvtVariants> | null = null;
  try {
    mvt = kind === 'mvt' ? mvtVariants(id, factors) : null;
  } catch (error) {
    fail('INVALID_FLAG', error instanceof Error ? error.message : String(error), 'At most 4 factors × 4 levels, 16 combinations.');
  }

  let variantKeys = mvt ? mvt.variants.map((v) => v.key) : str(flags.variants)?.split(',').map((s) => s.trim()).filter(Boolean);
  if (!variantKeys || variantKeys.length < 2) {
    if (!interactive) variantKeys = ['control', 'b'];
    else {
      const v = await ask(p.text({ message: 'Variant keys, comma separated (first = control)', initialValue: 'control, b' }));
      variantKeys = v.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  for (const k of variantKeys) if (!KEY.test(k)) fail('INVALID_FLAG', `"${k}" isn't a valid variant key.`, 'Use lowercase a-z, 0-9, - and _.');
  if (variantKeys.length < 2) fail('INVALID_FLAG', 'An experiment needs at least 2 variants.', 'Pass --variants control,b.');
  if (new Set(variantKeys).size !== variantKeys.length) fail('INVALID_FLAG', 'Two variants have the same key.');

  const weights = mvt ? variantKeys.map(() => 1) : parseWeights(str(flags.weights), variantKeys.length);

  const values = parsePairs(list(flags.value));
  const tos = parsePairs(list(flags.to));
  if (kind === 'value' && interactive) {
    for (const k of variantKeys) {
      if (values[k] === undefined) values[k] = await ask(p.text({ message: `Value for "${k}"`, placeholder: k === variantKeys[0] ? 'current text' : 'new text' }));
    }
  }
  let match = str(flags.match);
  if (kind === 'redirect') {
    if (!match) {
      if (!interactive) fail('USAGE', 'A redirect experiment needs the path it runs on.', 'Pass --match /path.');
      match = await ask(p.text({ message: 'Path to run the redirect test on', initialValue: '/' }));
    }
    for (const k of variantKeys) {
      if (tos[k] === undefined) {
        if (!interactive) tos[k] = k === variantKeys[0] ? match : `${match.replace(/\/$/, '')}/${k}`;
        else tos[k] = await ask(p.text({ message: `URL for "${k}"`, initialValue: k === variantKeys[0] ? match : '' }));
      }
    }
  }

  let goal = str(flags.goal);
  const goals = config.goals.map((g) => g.key);
  if (!goal) {
    if (!interactive) goal = goals[0];
    else if (goals.length > 0) {
      goal = await ask(
        p.select<string>({
          message: 'Goal (conversion) to optimise',
          options: [...goals.map((g) => ({ value: g, label: g })), { value: '', label: 'none yet (add later)' }],
        })
      );
      if (!goal) goal = undefined;
    }
  }
  if (goal && !goals.includes(goal)) fail('GOAL_NOT_FOUND', `There's no goal "${goal}" in the config.`, `Declared goals: ${goals.join(', ') || 'none'}. Add it to goals first.`);
  const extras = parseExtras(flags, goals, goal);

  // Running by default: the test goes live with the deploy that ships its code, first page views included.
  const status = (str(flags.status) as ExperimentStatus | undefined) ?? 'running';
  if (!['draft', 'running', 'paused'].includes(status)) fail('INVALID_FLAG', `A new experiment can't be "${status}".`, 'Use --status running or --status draft.');
  const description = str(flags.description);
  const name = str(flags.name)?.trim() || undefined;
  if (name && name.length > 80) fail('INVALID_FLAG', 'The name is longer than 80 characters.', 'Use a shorter --name; the key stays the id.');

  const experiment: NewExperiment = {
    key: id,
    kind,
    status,
    goal,
    match,
    name,
    description,
    variants: mvt ? mvt.variants.map((v) => ({ key: v.key, weight: v.weight })) : variantKeys.map((k, i) => ({ key: k, weight: weights[i]!, value: values[k], to: tos[k] })),
    ...(mvt ? { factors } : {}),
    ...limits,
    ...extras,
  };

  await writeConfigChecked(project.configFile, source, insertExperiment(extras.layer ? ensureLayer(source, extras.layer.key) : source, experiment), (loaded) => {
    const e = loaded.experiments.find((x) => x.key === id);
    if (!e) return `"${id}" is not in the file after the write`;
    if (e.status !== status) return `"${id}" loads as ${e.status}, not ${status}`;
    if (limits.minDays !== undefined && e.minDays !== limits.minDays) return `"${id}" loads with minDays ${e.minDays ?? 'unset'}, not ${limits.minDays}`;
    if (limits.goodSample !== undefined && e.goodSample !== limits.goodSample) return `"${id}" loads with goodSample ${e.goodSample ?? 'unset'}, not ${limits.goodSample}`;
    return null;
  });

  const files: string[] = [];
  const componentNames: Record<string, string> = {};
  if (kind === 'component') {
    const dir = join(project.root, project.hasSrc ? 'src/splithub' : 'splithub', id);
    mkdirSync(dir, { recursive: true });
    for (const k of variantKeys) {
      const name = `${pascal(id)}${pascal(k)}`;
      componentNames[k] = name;
      const file = join(dir, `${pascal(k)}.tsx`);
      if (!existsSync(file)) {
        writeFileSync(file, componentVariantTemplate(name, id, k), 'utf8');
        files.push(relative(project.root, file));
      }
    }
  }

  const snippet =
    kind === 'mvt'
      ? `const { ${Object.keys(factors).join(', ')} } = useValue<{ ${Object.keys(factors).map((f) => `${f}: string`).join('; ')} }>('${id}');`
      : kind === 'value'
      ? `const value = useValue<string>('${id}');`
      : kind === 'component'
        ? `<Experiment id="${id}">\n${variantKeys.map((k) => `  <Variant name="${k}"><${componentNames[k]} /></Variant>`).join('\n')}\n</Experiment>`
        : `// handled by @splithub/next middleware on ${match}; no code needed`;

  const result = { experiment: id, kind, status, variants: experiment.variants, goal: goal ?? null, traffic: limits.traffic ?? 1, maxVisitors: limits.maxExposures ?? null, minDays: limits.minDays ?? null, goodSample: limits.goodSample ?? null, schedule: limits.schedule ?? null, configFile: relative(project.root, project.configFile), files, snippet };
  if (json) {
    const cloudMode = /mode\s*:\s*['"]cloud['"]/.test(readSource(project.configFile));
    // Agents read this JSON: the hand-off line makes sure the human learns the test is not live yet.
    const handoff =
      status === 'draft'
        ? `${id} is a draft: visitors do not see it and nothing is recorded until it is started. Tell the user and ask whether to start it now (npx splithub start ${id}).`
        : `${id} is running in the config: it goes live for visitors when this code is deployed${cloudMode ? ' and pushed; local development never sends events to the cloud' : ''}. Tell the user, and that npx splithub pause ${id} or Pause in the dashboard holds it.`;
    const nextStep = cloudMode ? `npx splithub push  # the cloud does not know about ${id} until you push` : status === 'draft' ? `npx splithub start ${id}` : 'deploy the app';
    printJson({ ...result, nextStep, handoff });
    return;
  }
  p.note(snippet, kind === 'redirect' ? 'Nothing to wire' : 'Wire it in your code');
  if (files.length) p.note(files.join('\n'), 'Scaffolded');
  const cloud = /mode\s*:\s*['"]cloud['"]/.test(readSource(project.configFile));
  if (cloud) p.log.warn(`Cloud mode: the cloud does not know about it until you run ${c.cyan('npx splithub push')}.`);
  if (status === 'draft') p.log.warn(`${c.bold(id)} is a draft: visitors do not see it and nothing is recorded until you start it.`);
  if (status === 'running') p.log.info(`${c.bold(id)} goes live when you deploy this code. Check it first with ${c.cyan(`?sh_force=${id}:<variant>`)}; ${c.cyan(`npx splithub pause ${id}`)} holds it.`);
  if (status === 'draft') p.log.info(`See it before you start it: ${c.cyan('runDraftsInDev: true')} in the config serves drafts in development, ${c.cyan(`?sh_force=${id}:<variant>`)} shows one variant anywhere.`);
  p.outro(`Added ${c.bold(id)} (${status}) to ${relative(project.root, project.configFile)}. ${status === 'running' ? '' : `Start it with ${c.cyan(`npx splithub start ${id}`)}. `}${cloud ? `Then ${c.cyan('npx splithub push')}.` : ''}`);
}

/** --weights 50,50: one non-negative number per variant, not all zero. Equal weights when absent. */
export function parseWeights(raw: string | undefined, count: number): number[] {
  if (!raw) return Array.from({ length: count }, () => 1);
  const weights = raw.split(',').map((w) => Number(w.trim()));
  if (weights.length !== count) fail('INVALID_FLAG', `--weights has ${weights.length} numbers for ${count} variants.`, 'Give one weight per variant, in the same order: --weights 50,50.');
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) fail('INVALID_FLAG', `--weights "${raw}" has a value that isn't a number of 0 or more.`);
  if (weights.every((w) => w === 0)) fail('INVALID_FLAG', 'All weights are 0, so nobody would see the test.');
  return weights;
}

export interface Limits {
  traffic?: number;
  maxExposures?: number;
  minDays?: number;
  goodSample?: number;
  schedule?: { startAt: string | null; endAt: string | null };
}

/** --traffic (percent, 0 < t <= 100), --max-visitors (whole number > 0), --min-days (whole number 0..30), --good-sample (whole number 100..10,000,000), --start / --end (dates, start before end). */
export function parseLimits(flags: Flags): Limits {
  const out: Limits = {};
  const traffic = str(flags.traffic);
  if (traffic !== undefined) {
    const t = Number(traffic.replace(/%$/, ''));
    if (!Number.isFinite(t) || t <= 0 || t > 100) fail('INVALID_FLAG', `--traffic "${traffic}" must be a percent between 0 and 100.`, 'For example --traffic 50 puts half of the visitors in the test.');
    if (t !== 100) out.traffic = Math.round(t * 100) / 10000;
  }
  const max = str(flags['max-visitors']);
  if (max !== undefined) {
    const m = Number(max);
    if (!Number.isInteger(m) || m <= 0) fail('INVALID_FLAG', `--max-visitors "${max}" must be a whole number above 0.`);
    out.maxExposures = m;
  }
  const minDays = str(flags['min-days']);
  if (minDays !== undefined) {
    const d = Number(minDays);
    if (!Number.isInteger(d) || d < 0 || d > 30) fail('INVALID_FLAG', `--min-days "${minDays}" must be a whole number from 0 to 30.`, 'It is the fewest days before a verdict; 0 means none, the default.');
    out.minDays = d;
  }
  const good = str(flags['good-sample']);
  if (good !== undefined) {
    const g = Number(good);
    if (!Number.isInteger(g) || g < 100 || g > 10_000_000) fail('INVALID_FLAG', `--good-sample "${good}" must be a whole number from 100 to 10,000,000.`, 'It is the total visitors at which the sample counts as good; the default is 5000.');
    out.goodSample = g;
  }
  const date = (name: 'start' | 'end'): string | null => {
    const v = str(flags[name]);
    if (v === undefined) return null;
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) fail('INVALID_FLAG', `--${name} "${v}" isn't a date.`, 'Use an ISO date like 2026-11-01 or 2026-11-01T09:00:00Z.');
    return new Date(ms).toISOString();
  };
  const startAt = date('start');
  const endAt = date('end');
  if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) fail('INVALID_FLAG', '--end must be after --start.');
  if (startAt || endAt) out.schedule = { startAt, endAt };
  return out;
}

/**
 * --secondary a,b (goals to watch) · --guardrail refunds:higher,errors (goals that must not get worse;
 * :higher when a rise is bad, default :lower) · --layer key:0-50 (mutual exclusion, buckets [start, end)).
 */
export function parseExtras(flags: Flags, goals: string[], primary: string | undefined): Pick<NewExperiment, 'metrics' | 'layer'> {
  const out: Pick<NewExperiment, 'metrics' | 'layer'> = {};
  const split = (v: unknown) => list(v).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
  const secondary = split(flags.secondary);
  const guardrails = split(flags.guardrail).map((g) => {
    const [goal = '', worse] = g.split(':');
    if (worse !== undefined && worse !== 'lower' && worse !== 'higher') fail('INVALID_FLAG', `--guardrail "${g}": after the colon comes lower or higher.`, 'refunds:higher means more refunds is worse; signups (or signups:lower) means fewer is worse.');
    return worse === 'higher' ? { goal, worse: 'higher' as const } : goal;
  });
  const named = [...secondary, ...guardrails.map((g) => (typeof g === 'string' ? g : g.goal))];
  if (named.length) {
    if (!primary) fail('USAGE', 'Secondary metrics and guardrails need a primary goal.', 'Pass --goal too.');
    for (const g of named) if (!goals.includes(g)) fail('GOAL_NOT_FOUND', `There's no goal "${g}" in the config.`, `Declared goals: ${goals.join(', ') || 'none'}. Add it to goals first.`);
    const all = [primary, ...named];
    if (new Set(all).size !== all.length) fail('INVALID_FLAG', 'A goal is listed twice across --goal, --secondary and --guardrail.');
    out.metrics = { ...(secondary.length ? { secondary } : {}), ...(guardrails.length ? { guardrails } : {}) };
  }
  const layer = str(flags.layer);
  if (layer) {
    const m = /^([a-z0-9][a-z0-9_-]{0,63}):(\d{1,3})-(\d{1,3})$/.exec(layer);
    const start = Number(m?.[2]);
    const end = Number(m?.[3]);
    if (!m || !(start < end) || end > 100) fail('INVALID_FLAG', `--layer "${layer}" must look like key:start-end with 0 <= start < end <= 100.`, 'For example --layer checkout:0-50; another test in checkout:50-100 never shares a visitor.');
    out.layer = { key: m[1]!, range: [start, end] };
  }
  return out;
}
