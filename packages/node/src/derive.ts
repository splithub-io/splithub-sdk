// One install sends one row per action. With an analytics property, `track(name)` sends only the
// `event` row and a page load only the `page` row; the goal rows that convert experiments are
// derived from them here, before attribution. The cloud ingest (splithub-go/routes/v2-ingest.ts)
// and the self-hosted handler both use it, so the rule is the same everywhere:
//
//   - an `event` named N converts the experiments whose goal or metric is goalKeyFor(goals, N);
//   - a `page` converts the experiments whose goal or metric is a pageview goal matching its path;
//   - the derived row keeps the event's ts and props (revenue), so attribution, the daily cap and
//     revenue work exactly as for a goal row;
//   - an SDK from before this rule sends the goal row too: a goal row of the same key and visitor
//     within a second of it in the same batch wins, and nothing is derived.

import { goalKeyFor, matchPath, measuredGoals, type Goal, type SplitHubConfig } from '@splithub/core';
import type { StoredEvent } from './store';

/** A goal an experiment is judged on, as far as deriving it from analytics rows needs. */
export interface DerivableGoal {
  key: string;
  type: Goal['type'];
  /** Event name analytics matches instead of the key. */
  event?: string;
  /** Pageview goals: the path pattern (`/pricing`, `/docs/*`). */
  path?: string | null;
}

/** How close (ms) a goal row sent next to its analytics row must be to count as the same action. */
export const SAME_ACTION_MS = 1000;

/**
 * The goals some experiment (or the holdout) of `config` is judged on, primary or metric:
 * the only ones analytics rows are turned into. A measured key without a declaration counts as an event goal.
 */
export function experimentGoals(config: Pick<SplitHubConfig, 'experiments' | 'holdout' | 'goals'>): DerivableGoal[] {
  const measured = measuredGoals(config);
  const keys = new Set<string>();
  for (const key of Object.values(measured.goals)) if (key) keys.add(key);
  for (const list of Object.values(measured.metrics)) for (const key of list) keys.add(key);
  const out: DerivableGoal[] = [];
  for (const key of keys) {
    const g = config.goals.find((d) => d.key === key);
    out.push(g ? { key, type: g.type, ...(g.event ? { event: g.event } : {}), ...(g.type === 'pageview' && g.path ? { path: g.path } : {}) } : { key, type: 'event' });
  }
  return out;
}

function pathOf(url: string): string {
  let path = url;
  if (/^https?:\/\//i.test(url)) {
    try {
      path = new URL(url).pathname;
    } catch {
      // keep as is
    }
  }
  return path.split(/[?#]/)[0] || '/';
}

/** A derived row: marked, so a store does not count it as dropped when no experiment takes it. */
export type DerivedGoal = StoredEvent & { derived: true };

/** Goal rows derived from the batch's `event` and `page` rows (see the rule above). */
export function goalsFromAnalytics(events: readonly StoredEvent[], goals: readonly DerivableGoal[]): DerivedGoal[] {
  if (goals.length === 0) return [];
  const sent = events.filter((e) => e.type === 'goal');
  const alreadySent = (key: string, e: StoredEvent): boolean => sent.some((g) => g.goal === key && g.visitorId === e.visitorId && Math.abs(g.ts - e.ts) <= SAME_ACTION_MS);
  const out: DerivedGoal[] = [];
  for (const e of events) {
    let keys: string[] = [];
    if (e.type === 'event' && e.goal) {
      const key = goalKeyFor(goals, e.goal);
      if (key && goals.some((g) => g.key === key)) keys = [key];
    } else if (e.type === 'page' && e.url) {
      const path = pathOf(e.url);
      keys = goals.filter((g) => g.type === 'pageview' && g.path && matchPath(g.path, path)).map((g) => g.key);
    }
    keys.forEach((key, i) => {
      if (alreadySent(key, e)) return;
      out.push({ ...e, id: `${e.id.slice(0, 60)}-g${i}`, type: 'goal', experiment: null, variant: null, goal: key, props: e.type === 'event' ? e.props : null, derived: true });
    });
  }
  return out;
}
