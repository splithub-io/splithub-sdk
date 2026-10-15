import { HOLDOUT_KEY, LAYER_BUCKETS } from './config';
import { hashToUnit } from './hash';
import { runFlow } from './targeting';
import type { Assignment, Experiment, SplitHubConfig, TargetingContext, Variant } from './types';

// Module-scoped so it compiles without node types and still shadows nothing at runtime.
declare const process: { env: Record<string, string | undefined> };

/**
 * True in `next dev` / `vite` and on the server of a dev build. Bundlers
 * replace `process.env.NODE_ENV` with a literal, so the expression is kept
 * verbatim; where nothing replaces it and no `process` exists, it is false.
 */
export function isDevEnvironment(): boolean {
  try {
    return process.env.NODE_ENV === 'development';
  } catch {
    return false;
  }
}

/** A draft shown in development because the config says `runDraftsInDev: true`. */
export function isDevDraft(config: Pick<SplitHubConfig, 'runDraftsInDev'>, experiment: Pick<Experiment, 'status'>): boolean {
  return experiment.status === 'draft' && config.runDraftsInDev && isDevEnvironment();
}

/** Running now, or a draft served in development. What the middleware and the drop-in script check before assigning. */
export function isActive(config: Pick<SplitHubConfig, 'runDraftsInDev'>, experiment: Pick<Experiment, 'status' | 'schedule'>, now?: number): boolean {
  return (experiment.status === 'running' && inSchedule(experiment, now)) || isDevDraft(config, experiment);
}

/**
 * Deterministic bucketing. Same visitor + same experiment + same seed always
 * yields the same variant, on any runtime, with no network call.
 *
 * Two independent hashes are used so that changing `traffic` does not
 * reshuffle variants of visitors already inside the experiment.
 */
export function pickVariant(experiment: Experiment, visitorId: string): Variant | null {
  const trafficUnit = hashToUnit(`${experiment.seed}:${experiment.key}:traffic:${visitorId}`);
  if (trafficUnit >= experiment.traffic) return null;

  const unit = hashToUnit(`${experiment.seed}:${experiment.key}:variant:${visitorId}`);
  let cumulative = 0;
  for (const variant of experiment.variants) {
    cumulative += variant.weight;
    if (unit < cumulative) return variant;
  }
  // Floating point rounding: fall back to the last variant.
  return experiment.variants[experiment.variants.length - 1] ?? null;
}

/**
 * Holdout group of a visitor: `holdout` (sees the control everywhere, sends no
 * exposures but the `__holdout` marker) or `enrolled`. Null without a holdout.
 * One hash per visitor and project, independent of every experiment's seed.
 */
export function holdoutGroup(config: Pick<SplitHubConfig, 'holdout'>, visitorId: string): 'holdout' | 'enrolled' | null {
  const h = config.holdout;
  if (!h || !(h.percent > 0)) return null;
  return hashToUnit(`${h.seed}:${HOLDOUT_KEY}:${visitorId}`) < h.percent / 100 ? 'holdout' : 'enrolled';
}

/** The visitor's bucket 0..99 in a layer: the same in every experiment of the layer. */
export function layerBucket(config: Pick<SplitHubConfig, 'layers'>, layerKey: string, visitorId: string): number {
  const seed = config.layers?.[layerKey]?.seed ?? layerKey;
  return Math.min(LAYER_BUCKETS - 1, Math.floor(hashToUnit(`${seed}:layer:${layerKey}:${visitorId}`) * LAYER_BUCKETS));
}

/** True when the experiment has no layer or the visitor's bucket is inside its range. */
export function inLayer(config: Pick<SplitHubConfig, 'layers'>, experiment: Pick<Experiment, 'layer'>, visitorId: string): boolean {
  const l = experiment.layer;
  if (!l) return true;
  const b = layerBucket(config, l.key, visitorId);
  return b >= l.range[0] && b < l.range[1];
}

/**
 * Whether an assignment puts the visitor in the holdout comparison: they reached a
 * running experiment (in or out of its traffic, layer or targeting), so holdout and
 * enrolled visitors are counted by the same rule. Overrides, bots and tests that are
 * not running do not count.
 */
export function countsForHoldout(a: Pick<Assignment, 'reason'>): boolean {
  return a.reason === 'assigned' || a.reason === 'holdout' || a.reason === 'outside_traffic' || a.reason === 'targeting' || a.reason === 'layer';
}

export interface AssignOptions {
  /** Force a variant (QA, `?sh_force=hero-cta:bold`). */
  overrides?: Record<string, string>;
  /** Visitor context for targeting flows (country, device, UTM ...). */
  context?: TargetingContext;
}

export function assign(
  config: SplitHubConfig,
  experimentKey: string,
  visitorId: string,
  options: AssignOptions = {}
): Assignment {
  const experiment = config.experiments.find((e) => e.key === experimentKey);
  if (!experiment) return { experiment: experimentKey, variant: null, reason: 'unknown_experiment' };

  const forced = options.overrides?.[experimentKey];
  if (forced) {
    // A typo in a preview link (`?sh_force=hero:a` with no variant `a`) is still a preview:
    // it shows the control and is never counted as a visit.
    const variant = experiment.variants.find((v) => v.key === forced) ?? controlVariant(experiment);
    return { experiment: experimentKey, variant, reason: 'override' };
  }

  // Crawlers and headless browsers see the control and are never counted: the SDK, sh.js and
  // the middleware all pass the user agent's device, so they agree.
  if (options.context?.device === 'bot') return { experiment: experimentKey, variant: null, reason: 'bot' };

  const devDraft = isDevDraft(config, experiment);
  if (!devDraft && (experiment.status !== 'running' || !inSchedule(experiment, options.context?.now))) {
    return { experiment: experimentKey, variant: null, reason: 'not_running' };
  }
  // Holdout and layers come before traffic and targeting: they decide who may enter at all.
  if (holdoutGroup(config, visitorId) === 'holdout') return { experiment: experimentKey, variant: null, reason: 'holdout' };
  if (!inLayer(config, experiment, visitorId)) return { experiment: experimentKey, variant: null, reason: 'layer' };
  // A draft in development is served exactly like a running test; only the reason differs, so the debug panel can say why.
  const reason = devDraft ? 'dev' : 'assigned';
  if (experiment.flow) {
    const trafficUnit = hashToUnit(`${experiment.seed}:${experiment.key}:traffic:${visitorId}`);
    if (trafficUnit >= experiment.traffic) return { experiment: experimentKey, variant: null, reason: 'outside_traffic' };
    const outcome = runFlow(experiment, experiment.flow, visitorId, options.context ?? {});
    return outcome.variant ? { experiment: experimentKey, variant: outcome.variant, reason } : { experiment: experimentKey, variant: null, reason: 'targeting' };
  }
  const variant = pickVariant(experiment, visitorId);
  if (!variant) return { experiment: experimentKey, variant: null, reason: 'outside_traffic' };
  return { experiment: experimentKey, variant, reason };
}

/** True when the experiment has no run window or `now` is inside it. */
export function inSchedule(experiment: Pick<Experiment, 'schedule'>, now = Date.now()): boolean {
  const s = experiment.schedule;
  if (!s) return true;
  if (s.startAt && now < Date.parse(s.startAt)) return false;
  if (s.endAt && now > Date.parse(s.endAt)) return false;
  return true;
}

/** Control is always the first declared variant. */
export function controlVariant(experiment: Experiment): Variant {
  return experiment.variants[0]!;
}

/** Parse `?sh_force=hero-cta:bold,pricing-title:urgency` into overrides. */
export function parseForceParam(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  const match = /[?&]sh_force=([^&]+)/.exec(search);
  if (!match || !match[1]) return out;
  let raw: string;
  try {
    raw = decodeURIComponent(match[1]);
  } catch {
    // A malformed escape (`%E0%A4`) must not break rendering: ignore the parameter.
    return out;
  }
  for (const pair of raw.split(',')) {
    const [exp, variant] = pair.split(':');
    if (exp && variant) out[exp] = variant;
  }
  return out;
}
