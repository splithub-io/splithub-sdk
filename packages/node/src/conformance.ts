// Shared cases for the attribution rule (./attribution). Every store's tests
// insert `events` and compare `variantCounts(experiment, goal)`, sorted with
// `sortCounts`, to `expected`. Plain data so this ships without a test runner.

import { ATTRIBUTION_SKEW_MS, GOAL_DAILY_CAP, type AttributedCounts } from './attribution';
import type { StoreVariantCounts, StoredEvent } from './store';

export interface ConformanceCase {
  name: string;
  experiment: string;
  goal: string;
  events: StoredEvent[];
  expected: AttributedCounts[];
  /**
   * The cloud decides at ingest in arrival order, so a later-arriving exposure
   * with an earlier ts cannot move a visitor. Cases that depend on that are
   * only for the read-time stores.
   */
  readTimeOnly?: boolean;
}

const T = Date.UTC(2026, 0, 10, 12, 0, 0);
const DAY = 86_400_000;
let seq = 0;

function exposure(visitorId: string, variant: string, ts: number, experiment = 'hero'): StoredEvent {
  seq++;
  return { id: `exp_${String(seq).padStart(6, '0')}`, type: 'exposure', experiment, variant, goal: null, visitorId, sessionId: `s_${visitorId}`, ts, url: null, props: null, receivedAt: ts };
}
function goal(visitorId: string, ts: number, revenue?: unknown, key = 'signup'): StoredEvent {
  seq++;
  return { id: `goal_${String(seq).padStart(6, '0')}`, type: 'goal', experiment: null, variant: null, goal: key, visitorId, sessionId: `s_${visitorId}`, ts, url: null, props: revenue === undefined ? null : { revenue }, receivedAt: ts };
}
function counts(variant: string, exposures: number, conversions: number, revenueSum = 0, revenueSumSq = 0): AttributedCounts {
  return { variant, exposures, conversions, revenue: revenueSum, revenueSum, revenueSumSq };
}

export const attributionConformance: ConformanceCase[] = [
  {
    name: 'a visitor belongs to the variant of their earliest exposure (tie: smallest key)',
    experiment: 'hero',
    goal: 'signup',
    readTimeOnly: true,
    events: [
      exposure('v1', 'control', T + 1000),
      exposure('v1', 'bold', T), // earlier, arrives later
      goal('v1', T + 5000),
      exposure('v2', 'control', T),
      exposure('v2', 'bold', T),
      exposure('v3', 'bold', T),
      exposure('v4', 'control', T),
    ],
    expected: [counts('bold', 3, 1), counts('control', 1, 0)],
  },
  {
    name: 'counts unique visitors, not events',
    experiment: 'hero',
    goal: 'signup',
    events: [exposure('v1', 'control', T), exposure('v1', 'control', T + 10), exposure('v1', 'bold', T + 20), goal('v1', T + 30), goal('v1', T + 40), exposure('v2', 'bold', T)],
    expected: [counts('bold', 1, 0), counts('control', 1, 1)],
  },
  {
    name: 'goals well before the exposure, of other goals or from unexposed visitors do not convert',
    experiment: 'hero',
    goal: 'signup',
    events: [
      exposure('v1', 'control', T),
      goal('v1', T - ATTRIBUTION_SKEW_MS - 1000, 9),
      goal('v1', T + 1000, 9, 'other'),
      exposure('other_exp', 'x', T, 'pricing'),
      goal('nobody', T + 1000, 9),
      goal('other_exp', T + 1000, 9),
    ],
    expected: [counts('control', 1, 0)],
  },
  {
    name: `a goal up to ${ATTRIBUTION_SKEW_MS / 1000} s before the exposure still counts (server vs browser clock)`,
    experiment: 'hero',
    goal: 'signup',
    events: [
      exposure('v1', 'control', T),
      goal('v1', T - ATTRIBUTION_SKEW_MS, 2),
      exposure('v2', 'bold', T),
      goal('v2', T - 30_000, 3),
      exposure('v3', 'bold', T),
      goal('v3', T - ATTRIBUTION_SKEW_MS - 1, 4),
    ],
    expected: [counts('bold', 2, 1, 3, 9), counts('control', 1, 1, 2, 4)],
  },
  {
    name: `at most ${GOAL_DAILY_CAP} of one goal per visitor and UTC day`,
    experiment: 'hero',
    goal: 'signup',
    events: [
      exposure('v1', 'control', T),
      ...Array.from({ length: GOAL_DAILY_CAP + 10 }, (_, i) => goal('v1', T + 1000 + i, 1)),
      ...Array.from({ length: 3 }, (_, i) => goal('v1', T + DAY + i, 1)),
    ],
    expected: [counts('control', 1, 1, GOAL_DAILY_CAP + 3, (GOAL_DAILY_CAP + 3) ** 2)],
  },
  {
    name: 'revenue is summed per visitor; variants report the sum and the sum of squares',
    experiment: 'hero',
    goal: 'signup',
    events: [
      exposure('v1', 'control', T),
      goal('v1', T + 1000, 10),
      goal('v1', T + 2000, 5),
      exposure('v2', 'control', T),
      goal('v2', T + 1000, 20),
      exposure('v3', 'control', T),
      goal('v3', T + 1000, 'lots'),
      exposure('v4', 'control', T),
      exposure('v5', 'bold', T),
      goal('v5', T + 1000, 2.5),
    ],
    expected: [counts('bold', 1, 1, 2.5, 6.25), counts('control', 4, 3, 35, 625)],
  },
];

/** Sorts by variant and keeps the compared fields, so any store's output can be `toEqual`-ed with `expected`. */
export function sortCounts(rows: StoreVariantCounts[]): AttributedCounts[] {
  return rows
    .map((r) => {
      const revenueSum = r.revenueSum ?? r.revenue ?? 0;
      return { variant: r.variant, exposures: r.exposures, conversions: r.conversions, revenue: revenueSum, revenueSum, revenueSumSq: r.revenueSumSq ?? 0 };
    })
    .sort((a, b) => (a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0));
}
