import { getExperiment, HOLDOUT_KEY, holdoutExperiment, type Experiment, type SplitHubConfig } from '@splithub/core';
import type { ExperimentSummary, Store, StoreVariantCounts } from './store';

const DAY_MS = 86_400_000;

/** Self-hosted reads give counts; verdicts and recommendations are computed by SplitHub Cloud. */
export const ANALYSIS_UNAVAILABLE = {
  available: false as const,
  message: 'Verdicts, stars and recommendations come with SplitHub Cloud.',
  url: 'https://splithub.io/cloud',
};

export interface RawVariant {
  variant: string;
  /** Unique visitors counted in this variant (first exposure decides). */
  visitors: number;
  /** Visitors who reached the goal after their exposure. */
  conversions: number;
  /** conversions / visitors, 0 without visitors. */
  rate: number;
  /** Sum of per-visitor revenue, when the goal carries revenue. */
  revenue?: number;
  /** Sum of squared per-visitor revenue, when the store reports it. */
  revenueSumSq?: number;
}

export interface RawMetric {
  metric: string;
  role: 'secondary' | 'guardrail';
  worse?: 'higher' | 'lower';
  variants: RawVariant[];
}

export interface RawResults {
  experiment: string;
  kind: string;
  status: string;
  goal: string | null;
  description: string | null;
  /** Human name; null = show the key. */
  name: string | null;
  /** Declared order: the first variant is the control. */
  variants: RawVariant[];
  metrics?: RawMetric[];
  /** Days between the first and the last exposure, one decimal; 0 without data. */
  days: number;
  analysis: typeof ANALYSIS_UNAVAILABLE;
}

export interface RawStatusRow {
  experiment: string;
  kind: string;
  status: string;
  goal: string | null;
  description: string | null;
  /** Human name; null = show the key. */
  name: string | null;
  exposures: number;
  visitors: number;
  /** Whole days with data, at least 1 once there is any; 0 without data. */
  days: number;
}

/** An experiment of the config, or the holdout comparison for `__holdout`. */
export function resultsExperiment(config: SplitHubConfig, key: string): Experiment | null {
  return getExperiment(config, key) ?? (key === HOLDOUT_KEY ? holdoutExperiment(config) : null);
}

/** Store rows in the config's order, silent variants as 0. */
function rawVariants(experiment: Experiment, observed: StoreVariantCounts[], withRevenue: boolean): RawVariant[] {
  return experiment.variants.map((v) => {
    const row = observed.find((o) => o.variant === v.key);
    const visitors = row?.exposures ?? 0;
    const conversions = row?.conversions ?? 0;
    const revenue = row?.revenueSum ?? row?.revenue;
    return {
      variant: v.key,
      visitors,
      conversions,
      rate: visitors > 0 ? conversions / visitors : 0,
      ...(withRevenue && revenue !== undefined ? { revenue } : {}),
      ...(withRevenue && row?.revenueSumSq !== undefined ? { revenueSumSq: row.revenueSumSq } : {}),
    };
  });
}

/** Counts per variant for one experiment, its secondary and guardrail goals included. No statistics. */
export async function rawResults(config: SplitHubConfig, store: Store, key: string, options: { summary?: ExperimentSummary | null } = {}): Promise<RawResults | null> {
  const experiment = resultsExperiment(config, key);
  if (!experiment) return null;
  const goal = experiment.goal;
  const observed = goal ? await store.variantCounts(key, goal) : [];
  const goalHasRevenue = Boolean(goal && config.goals.find((g) => g.key === goal)?.revenue);
  const withRevenue = goalHasRevenue || observed.some((o) => (o.revenueSum ?? o.revenue ?? 0) !== 0);
  const summary = options.summary !== undefined ? options.summary : ((await store.summaries()).find((s) => s.experiment === key) ?? null);
  const span = summary?.firstExposureAt != null && summary.lastExposureAt != null ? (summary.lastExposureAt - summary.firstExposureAt) / DAY_MS : 0;

  const m = goal ? experiment.metrics : undefined;
  const metrics: RawMetric[] | undefined = m
    ? await Promise.all([
        ...m.secondary.map(async (metric) => ({ metric, role: 'secondary' as const, variants: rawVariants(experiment, await store.variantCounts(key, metric), false) })),
        ...m.guardrails.map(async (g) => ({ metric: g.goal, role: 'guardrail' as const, ...(g.worse ? { worse: g.worse } : {}), variants: rawVariants(experiment, await store.variantCounts(key, g.goal), false) })),
      ])
    : undefined;

  return {
    experiment: key,
    kind: experiment.kind,
    status: experiment.status,
    goal,
    description: experiment.description ?? null,
    name: experiment.name ?? null,
    variants: rawVariants(experiment, observed, withRevenue),
    ...(metrics?.length ? { metrics } : {}),
    days: Math.round(span * 10) / 10,
    analysis: ANALYSIS_UNAVAILABLE,
  };
}

/** Every experiment with exposures, visitors and days; the holdout once it has visitors. */
export async function rawStatusTable(config: SplitHubConfig, store: Store): Promise<RawStatusRow[]> {
  const byKey = new Map<string, ExperimentSummary>((await store.summaries()).map((s) => [s.experiment, s]));
  const holdout = holdoutExperiment(config);
  const all = holdout && byKey.has(HOLDOUT_KEY) ? [...config.experiments, holdout] : config.experiments;
  return all.map((exp) => {
    const s = byKey.get(exp.key);
    const days = s?.firstExposureAt && s.lastExposureAt ? Math.max(1, Math.ceil((s.lastExposureAt - s.firstExposureAt) / DAY_MS)) : 0;
    return { experiment: exp.key, kind: exp.kind, status: exp.status, goal: exp.goal, description: exp.description ?? null, name: exp.name ?? null, exposures: s?.exposures ?? 0, visitors: s?.visitors ?? 0, days };
  });
}
