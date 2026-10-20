import { validateFlow } from './targeting';
import type {
  Experiment,
  ExperimentInput,
  ExperimentMetrics,
  Holdout,
  Factor,
  Goal,
  GoalInput,
  Property,
  PropertyInput,
  SplitHubConfig,
  SplitHubConfigInput,
  Variant,
} from './types';

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class ConfigError extends Error {
  constructor(message: string) {
    super(`[splithub] ${message}`);
    this.name = 'ConfigError';
  }
}

function assertKey(kind: string, key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new ConfigError(
      `${kind} key "${key}" is invalid. Use lowercase letters, digits, "-" and "_" (max 64 chars).`
    );
  }
}

export const MVT_MAX_FACTORS = 4;
export const MVT_MAX_LEVELS = 4;
export const MVT_MAX_COMBINATIONS = 16;

/**
 * Every combination of the factors' levels as a variant, in order (first levels
 * first, so the all-control combination is the control), equal weights. The
 * variant's `value` is `{ factor: levelValue }`, what `useValue()` returns.
 */
export function mvtVariants(expKey: string, factors: Record<string, Record<string, unknown>>): { variants: Variant[]; factors: Factor[] } {
  const list: Factor[] = [];
  const valuesOf = new Map<string, Record<string, unknown>>();
  for (const [key, levels] of Object.entries(factors ?? {})) {
    assertKey('factor', key);
    const levelKeys = Object.keys(levels ?? {});
    if (levelKeys.length < 2) throw new ConfigError(`experiment "${expKey}", factor "${key}": needs at least 2 levels.`);
    if (levelKeys.length > MVT_MAX_LEVELS) throw new ConfigError(`experiment "${expKey}", factor "${key}": at most ${MVT_MAX_LEVELS} levels.`);
    for (const l of levelKeys) assertKey('level', l);
    list.push({ key, levels: levelKeys });
    valuesOf.set(key, levels);
  }
  if (list.length === 0) throw new ConfigError(`experiment "${expKey}": mvt experiments need "factors".`);
  if (list.length > MVT_MAX_FACTORS) throw new ConfigError(`experiment "${expKey}": at most ${MVT_MAX_FACTORS} factors.`);
  let combos: Array<Record<string, string>> = [{}];
  for (const f of list) combos = combos.flatMap((c) => f.levels.map((l) => ({ ...c, [f.key]: l })));
  if (combos.length > MVT_MAX_COMBINATIONS) throw new ConfigError(`experiment "${expKey}": ${combos.length} combinations; at most ${MVT_MAX_COMBINATIONS}.`);
  const variants: Variant[] = combos.map((levels) => ({
    key: list.map((f) => levels[f.key]).join('-'),
    weight: 1 / combos.length,
    value: Object.fromEntries(list.map((f) => [f.key, valuesOf.get(f.key)![levels[f.key]!]])),
    levels,
  }));
  return { variants, factors: list };
}

function normalizeVariants(expKey: string, input: ExperimentInput): Variant[] {
  if (input.kind === 'mvt') return mvtVariants(expKey, input.factors).variants;
  const entries = Object.entries(input.variants);
  if (entries.length < 2) {
    throw new ConfigError(`experiment "${expKey}" needs at least 2 variants.`);
  }
  const raw = entries.map(([key, v]) => {
    assertKey('variant', key);
    const weight = typeof v === 'number' ? v : v.weight;
    if (!Number.isFinite(weight) || weight < 0) {
      throw new ConfigError(`experiment "${expKey}", variant "${key}": weight must be a non-negative number.`);
    }
    const variant: Variant = { key, weight };
    const obj = typeof v === 'object' ? (v as Record<string, unknown>) : {};
    if (input.kind === 'value') variant.value = obj.value;
    if (input.kind === 'redirect') variant.to = String(obj.to ?? '');
    return variant;
  });
  const total = raw.reduce((s, v) => s + v.weight, 0);
  if (total <= 0) {
    throw new ConfigError(`experiment "${expKey}": variant weights sum to 0.`);
  }
  return raw.map((v) => ({ ...v, weight: v.weight / total }));
}

/** Reserved experiment key of the holdout comparison (never a valid config key: keys start with a letter or digit). */
export const HOLDOUT_KEY = '__holdout';
/** Buckets per layer: an experiment's `layer.range` is a slice of 0..LAYER_BUCKETS. */
export const LAYER_BUCKETS = 100;

function normalizeMetrics(key: string, input: ExperimentInput, primary: string | null, goals: Goal[]): ExperimentMetrics | undefined {
  const m = input.metrics;
  if (!m) return undefined;
  if (!primary) throw new ConfigError(`experiment "${key}": metrics need a primary "goal" too.`);
  const seen = new Set<string>([primary]);
  const check = (name: unknown, where: string): string => {
    const goal = goalFor(name, goals, `experiment "${key}": metrics.${where}`);
    if (seen.has(goal)) throw new ConfigError(`experiment "${key}": goal "${goal}" is listed twice (primary goal and metrics count once each).`);
    seen.add(goal);
    return goal;
  };
  const secondary = (m.secondary ?? []).map((g) => check(g, 'secondary'));
  const guardrails = (m.guardrails ?? []).map((g) => {
    const obj = typeof g === 'string' ? { goal: g } : g;
    const worse = obj.worse ?? 'lower';
    if (worse !== 'lower' && worse !== 'higher') throw new ConfigError(`experiment "${key}": guardrail "${obj.goal}": worse must be "lower" or "higher".`);
    return { goal: check(obj.goal, 'guardrails'), worse };
  });
  if (secondary.length === 0 && guardrails.length === 0) return undefined;
  return { secondary, guardrails };
}

function normalizeLayer(key: string, input: ExperimentInput, layers: Record<string, unknown>): Experiment['layer'] {
  const l = input.layer;
  if (!l) return undefined;
  if (!l.key || !(l.key in layers)) throw new ConfigError(`experiment "${key}": layer "${String(l.key)}" is not declared in "layers".`);
  const [start, end] = Array.isArray(l.range) ? l.range : [NaN, NaN];
  const ok = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= LAYER_BUCKETS;
  if (!ok(start) || !ok(end) || !(start! < end!)) throw new ConfigError(`experiment "${key}": layer.range must be [start, end] with whole numbers 0 <= start < end <= ${LAYER_BUCKETS}.`);
  return { key: l.key, range: [start!, end!] };
}

/** Two experiments of one layer that are not finished must not claim the same bucket. */
function assertNoOverlap(experiments: Experiment[]): void {
  const live = experiments.filter((e) => e.layer && e.status !== 'finished');
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      if (a.layer!.key !== b.layer!.key) continue;
      if (a.layer!.range[0] < b.layer!.range[1] && b.layer!.range[0] < a.layer!.range[1]) {
        throw new ConfigError(`experiments "${a.key}" and "${b.key}" overlap in layer "${a.layer!.key}" ([${a.layer!.range.join(', ')}) and [${b.layer!.range.join(', ')})). Give each its own range.`);
      }
    }
  }
}

function normalizeHoldout(input: SplitHubConfigInput, goals: Goal[]): Holdout | null {
  const h = input.holdout;
  if (!h) return null;
  if (typeof h.percent !== 'number' || !Number.isFinite(h.percent) || h.percent < 0 || h.percent > 50) throw new ConfigError('holdout.percent must be a number between 0 and 50.');
  const goal = h.goal ? goalFor(h.goal, goals, 'holdout.goal') : null;
  if (h.percent === 0) return null;
  return { percent: h.percent, seed: h.seed ?? HOLDOUT_KEY, goal: goal ?? goals[0]?.key ?? null };
}

function normalizeExperiment(key: string, input: ExperimentInput, goals: Goal[], layers: Record<string, unknown> = {}): Experiment {
  assertKey('experiment', key);
  const traffic = input.traffic ?? 1;
  if (traffic < 0 || traffic > 1) {
    throw new ConfigError(`experiment "${key}": traffic must be between 0 and 1.`);
  }
  const goal = input.goal ? goalFor(input.goal, goals, `experiment "${key}"`) : null;
  if (input.kind === 'redirect' && !input.match) {
    throw new ConfigError(`experiment "${key}": redirect experiments need "match".`);
  }
  if (input.maxExposures !== undefined && (!Number.isFinite(input.maxExposures) || input.maxExposures < 1)) {
    throw new ConfigError(`experiment "${key}": maxExposures must be a positive number.`);
  }
  if (input.minDays !== undefined && !(Number.isInteger(input.minDays) && input.minDays >= 0 && input.minDays <= 30)) {
    throw new ConfigError(`experiment "${key}": minDays must be a whole number from 0 to 30.`);
  }
  if (input.goodSample !== undefined && !(Number.isInteger(input.goodSample) && input.goodSample >= 100 && input.goodSample <= 10_000_000)) {
    throw new ConfigError(`experiment "${key}": goodSample must be a whole number from 100 to 10,000,000.`);
  }
  if (input.name !== undefined && !(typeof input.name === 'string' && input.name.trim() && input.name.trim().length <= 80)) {
    throw new ConfigError(`experiment "${key}": name must be text of 1 to 80 characters.`);
  }
  for (const [k, v] of Object.entries(input.schedule ?? {})) {
    if (v !== undefined && Number.isNaN(Date.parse(v))) throw new ConfigError(`experiment "${key}": schedule.${k} must be an ISO date.`);
  }
  const variants = normalizeVariants(key, input);
  const metrics = normalizeMetrics(key, input, goal, goals);
  const layer = normalizeLayer(key, input, layers);
  if (input.flow) {
    const problem = validateFlow(input.flow, variants.map((v) => v.key));
    if (problem) throw new ConfigError(`experiment "${key}": flow: ${problem}`);
  }
  return {
    key,
    kind: input.kind,
    status: input.status,
    traffic,
    goal,
    seed: input.seed ?? key,
    description: input.description ?? null,
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    match: input.kind === 'redirect' ? input.match : null,
    variants,
    ...(input.kind === 'mvt' ? { factors: mvtVariants(key, input.factors).factors } : {}),
    ...(input.flow ? { flow: input.flow } : {}),
    ...(metrics ? { metrics } : {}),
    ...(layer ? { layer } : {}),
    ...(input.minDays !== undefined ? { minDays: input.minDays } : {}),
    ...(input.goodSample !== undefined ? { goodSample: input.goodSample } : {}),
    ...(input.maxExposures ? { maxExposures: Math.floor(input.maxExposures) } : {}),
    ...(input.schedule && (input.schedule.startAt || input.schedule.endAt) ? { schedule: { startAt: input.schedule.startAt ?? null, endAt: input.schedule.endAt ?? null } } : {}),
  };
}

function goalExtras(key: string, g: GoalInput): Pick<Goal, 'name' | 'value' | 'event'> {
  if (g.name !== undefined && !(typeof g.name === 'string' && g.name.trim() && g.name.trim().length <= 80)) throw new ConfigError(`goal "${key}": name must be text of 1 to 80 characters.`);
  if (g.value !== undefined && !(typeof g.value === 'number' && Number.isFinite(g.value) && g.value >= 0)) throw new ConfigError(`goal "${key}": value must be a number of 0 or more.`);
  const event = g.type === 'event' ? g.event : undefined;
  if (event !== undefined && !EVENT_NAME_PATTERN.test(event)) throw new ConfigError(`goal "${key}": event "${event}" is not a valid event name.`);
  return { ...(g.name !== undefined ? { name: g.name.trim() } : {}), ...(g.value !== undefined ? { value: g.value } : {}), ...(event !== undefined && event !== key ? { event } : {}) };
}

/** Analytics property ids, like every key: lowercase letters, digits, - and _. Generated ones look like `sh-x1h78w`. */
export const PROPERTY_KEY_PATTERN = KEY_PATTERN;
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A new property id: `sh-` and six letters or digits without look-alikes (0/o, 1/l/i). */
export function newPropertyId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `sh-${Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('')}`;
}

/** Custom event names: letters, digits, spaces and `_ . : / -`, up to 64 characters (`signup`, `Video Played`). */
export const EVENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,63}$/;

/**
 * The goal key of an event name: `Video Played` → `video-played`, `signup` → `signup`.
 * Lowercase, every run of other characters becomes `-`. Empty when nothing usable is left;
 * check the result against `PROPERTY_KEY_PATTERN` before sending it as a key.
 */
export function eventKey(name: string): string {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

/**
 * The goal key an event name counts as: a declared goal key itself, the goal whose `event`
 * is that name, or the name's slug (`eventKey`). Null when the name has no usable key.
 */
export function goalKeyFor(goals: ReadonlyArray<Pick<Goal, 'key' | 'event'>>, name: string): string | null {
  if (goals.some((g) => g.key === name)) return name;
  const byEvent = goals.find((g) => g.event === name);
  if (byEvent) return byEvent.key;
  const slug = eventKey(name);
  return KEY_PATTERN.test(slug) ? slug : null;
}

/**
 * The key of the goal an experiment (or the holdout) is judged on. Any event name works: one
 * that is not declared in `goals` becomes an event goal here (`{ type: 'event' }`, keyed by its
 * slug, with `event` set when the name differs from the key).
 */
function goalFor(name: unknown, goals: Goal[], where: string): string {
  if (typeof name !== 'string' || !(KEY_PATTERN.test(name) || EVENT_NAME_PATTERN.test(name))) {
    throw new ConfigError(`${where}: goal "${String(name)}" is not a valid event name (letters, digits, spaces and "_ . : / -", up to 64 characters).`);
  }
  const key = goalKeyFor(goals, name);
  if (!key) throw new ConfigError(`${where}: goal "${name}" has no usable key; use letters or digits in the name.`);
  if (!goals.some((g) => g.key === key)) {
    goals.push({ key, type: 'event', path: null, selector: null, revenue: false, description: null, ...(name !== key ? { event: name } : {}) });
  }
  return key;
}

export function normalizeProperty(key: string, input: PropertyInput, goals: Goal[]): Property {
  assertKey('property', key);
  const p = input ?? {};
  const status = p.status ?? 'running';
  if (status !== 'running' && status !== 'paused') throw new ConfigError(`property "${key}": status must be "running" or "paused".`);
  if (p.name !== undefined && !(typeof p.name === 'string' && p.name.trim() && p.name.trim().length <= 80)) {
    throw new ConfigError(`property "${key}": name must be text of 1 to 80 characters.`);
  }
  const list = p.goals ?? [];
  if (!Array.isArray(list)) throw new ConfigError(`property "${key}": goals must be a list of goal keys.`);
  for (const g of list) {
    if (!goals.some((d) => d.key === g)) throw new ConfigError(`property "${key}": goal "${String(g)}" is not declared in "goals".`);
  }
  return {
    key,
    status,
    ...(p.name !== undefined ? { name: p.name.trim() } : {}),
    description: p.description ?? null,
    goals: [...new Set(list)],
  };
}

/** The property with this id, or null. Events only go to a property named explicitly, never to a guess. */
export function pickProperty(config: Pick<SplitHubConfig, 'properties'>, key?: string | null): Property | null {
  if (!key) return null;
  return (config.properties ?? []).find((p) => p.key === key) ?? null;
}

/**
 * Validate and normalize a config. Call it once in `splithub.config.ts`:
 *
 * ```ts
 * export default defineConfig({ project: 'my-app', storage: { mode: 'self', endpoint: '/api/splithub' }, experiments: { ... } });
 * ```
 */
export function defineConfig(input: SplitHubConfigInput): SplitHubConfig {
  if (!input || typeof input !== 'object') throw new ConfigError('config must be an object.');
  if (!input.project) throw new ConfigError('"project" is required.');
  if (!input.storage || !('mode' in input.storage)) throw new ConfigError('"storage.mode" is required.');
  if (input.storage.mode === 'self' && !input.storage.endpoint) {
    throw new ConfigError('"storage.endpoint" is required in self mode.');
  }

  const goals: Goal[] = Object.entries(input.goals ?? {}).map(([key, g]) => {
    assertKey('goal', key);
    return {
      key,
      type: g.type,
      path: g.type === 'pageview' ? g.path : null,
      selector: g.type === 'click' ? g.selector : null,
      revenue: g.type === 'event' ? Boolean(g.revenue) : false,
      description: g.description ?? null,
      ...goalExtras(key, g),
    };
  });

  const layers: Record<string, { seed: string }> = {};
  for (const [key, l] of Object.entries(input.layers ?? {})) {
    assertKey('layer', key);
    layers[key] = { seed: l?.seed ?? key };
  }
  const experiments = Object.entries(input.experiments ?? {}).map(([key, exp]) =>
    normalizeExperiment(key, exp, goals, layers)
  );
  assertNoOverlap(experiments);
  const holdout = normalizeHoldout(input, goals);
  const properties = Object.entries(input.properties ?? {}).map(([key, p]) => normalizeProperty(key, p, goals));

  return {
    project: input.project,
    storage: input.storage,
    visitorKey: input.visitorKey ?? 'sh_vid',
    runDraftsInDev: input.runDraftsInDev === true,
    goals,
    experiments,
    ...(properties.length ? { properties } : {}),
    ...(Object.keys(layers).length ? { layers } : {}),
    ...(holdout ? { holdout } : {}),
    __splithub: 2,
  };
}

export function isSplitHubConfig(value: unknown): value is SplitHubConfig {
  return Boolean(value) && typeof value === 'object' && (value as SplitHubConfig).__splithub === 2;
}

export function getExperiment(config: SplitHubConfig, key: string): Experiment | undefined {
  return config.experiments.find((e) => e.key === key);
}

/**
 * The holdout read as an experiment, for results: `holdout` (the control: no test
 * changed anything for them) against `enrolled`, weighted by the holdout share.
 * Every declared goal but the primary is a secondary metric. Null without a holdout.
 */
export function holdoutExperiment(config: Pick<SplitHubConfig, 'holdout' | 'goals'>): Experiment | null {
  const h = config.holdout;
  if (!h) return null;
  const share = h.percent / 100;
  const secondary = config.goals.map((g) => g.key).filter((g) => g !== h.goal);
  return {
    key: HOLDOUT_KEY,
    kind: 'component',
    status: 'running',
    traffic: 1,
    goal: h.goal,
    seed: h.seed,
    description: `Holdout: ${h.percent}% of visitors see no experiment at all`,
    match: null,
    variants: [
      { key: 'holdout', weight: share },
      { key: 'enrolled', weight: 1 - share },
    ],
    ...(h.goal && secondary.length ? { metrics: { secondary, guardrails: [] } } : {}),
  };
}

/**
 * Which goals each experiment measures, for stores that attribute at ingest (the
 * cloud): `goals` is the primary goal, `metrics` the secondary and guardrail goals.
 * Includes `__holdout` when the config has a holdout.
 */
export function measuredGoals(config: Pick<SplitHubConfig, 'experiments' | 'holdout' | 'goals'>): { goals: Record<string, string | null>; metrics: Record<string, string[]> } {
  const goals: Record<string, string | null> = {};
  const metrics: Record<string, string[]> = {};
  const all = [...config.experiments];
  const h = holdoutExperiment(config);
  if (h) all.push(h);
  for (const e of all) {
    goals[e.key] = e.goal ?? null;
    const extra = [...(e.metrics?.secondary ?? []), ...(e.metrics?.guardrails ?? []).map((g) => g.goal)];
    if (extra.length) metrics[e.key] = extra;
  }
  return { goals, metrics };
}
