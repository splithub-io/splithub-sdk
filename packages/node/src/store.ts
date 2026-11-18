import { attributeVariants, type AttributedCounts } from './attribution';

/** Row types of an analytics property (`experiment` holds the property key). */
export const ANALYTICS_TYPES: ReadonlySet<StoredEvent['type']> = new Set(['page', 'event', 'engage', 'identify']);

/**
 * One row in the events table, whatever the backing database. Analytics rows reuse
 * the columns: for `page`, `event`, `engage` and `identify`, `experiment` holds the
 * property key and `goal` the event name (null for the others); a page's title and
 * referrer, an engage's `{ ms, scroll }` and an identify's `{ uid, traits }` sit in `props`.
 */
export interface StoredEvent {
  id: string;
  type: 'exposure' | 'goal' | 'page' | 'event' | 'engage' | 'identify';
  experiment: string | null;
  variant: string | null;
  goal: string | null;
  visitorId: string;
  sessionId: string;
  /** Unix ms, as reported by the client. */
  ts: number;
  url: string | null;
  props: Record<string, unknown> | null;
  /** Unix ms, server clock. */
  receivedAt: number;
  /** Request metadata filled by the ingest endpoint (origin host, GeoIP country, UA device/browser). */
  host?: string | null;
  country?: string | null;
  device?: string | null;
  browser?: string | null;
  /** Extra dimensions (SplitHub Cloud, `d1Store({ meta: 'extended' })`): OS, language, geo, referrer, UTM. */
  os?: string | null;
  language?: string | null;
  city?: string | null;
  region?: string | null;
  referrer?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_term?: string | null;
  utm_content?: string | null;
  /** `web` for website batches, else the app's platform (`ios`, `android`, `macos`, `windows`, `linux`). */
  platform?: string | null;
  /** The app's version (`2.4.1`); null on websites. */
  app_version?: string | null;
}

export interface ExperimentSummary {
  experiment: string;
  exposures: number;
  visitors: number;
  firstExposureAt: number | null;
  lastExposureAt: number | null;
}

/** What `variantCounts` returns. Older custom stores may omit the revenue fields; `revenue` then stands for the sum. */
export type StoreVariantCounts = Omit<AttributedCounts, 'revenue' | 'revenueSum' | 'revenueSumSq'> &
  Partial<Pick<AttributedCounts, 'revenue' | 'revenueSum' | 'revenueSumSq'>>;

/**
 * Storage adapter. Implement this against your database to keep all data in
 * your own infrastructure. `variantCounts` follows the rule in `./attribution`
 * (first exposure decides the variant, goals count from 60 s before it, at most
 * 50 of one goal per visitor and day); SQL databases can run `variantCountsSql`.
 */
export interface Store {
  /** Insert events, ignoring ids already present. Returns the number inserted. */
  insertEvents(events: StoredEvent[]): Promise<number>;
  /** Unique exposed and converted visitors per variant (any order), with per-visitor revenue sum and sum of squares. */
  variantCounts(experiment: string, goal: string): Promise<StoreVariantCounts[]>;
  summaries(): Promise<ExperimentSummary[]>;
  /**
   * Raw counts of an analytics property from `since` up to `until` (unix ms, exclusive; open-ended
   * when missing): pageviews, events by name, unique visitors and sessions. Optional: stores
   * without it answer 501 on `{base}/properties/:key`. SQL stores can run `propertyCountsSql`.
   */
  propertyCounts?(property: string, since: number, until?: number): Promise<PropertyCounts>;
  /** The latest raw rows of an analytics property, newest first. Optional. */
  propertyEvents?(property: string, options: { before: number; limit: number }): Promise<StoredEvent[]>;
  close?(): Promise<void> | void;
}

/** Raw counts of one analytics property; aggregated reports are SplitHub Cloud's. */
export interface PropertyCounts {
  pageviews: number;
  visitors: number;
  sessions: number;
  /** Distinct user ids sent with identify. */
  users: number;
  /** Custom events (goals included) by name, most frequent first. */
  events: Array<{ name: string; count: number; visitors: number }>;
}

/** Shared by the memory store and the tests: the counts over rows already in memory. */
export function countProperty(events: Iterable<StoredEvent>, property: string, since: number, until = Number.POSITIVE_INFINITY): PropertyCounts {
  let pageviews = 0;
  const visitors = new Set<string>();
  const sessions = new Set<string>();
  const users = new Set<string>();
  const byName = new Map<string, { count: number; visitors: Set<string> }>();
  for (const e of events) {
    if (!ANALYTICS_TYPES.has(e.type) || e.experiment !== property || e.ts < since || e.ts >= until) continue;
    if (e.type === 'identify') {
      if (typeof e.props?.uid === 'string') users.add(e.props.uid);
      continue;
    }
    if (e.type === 'engage') continue;
    visitors.add(e.visitorId);
    sessions.add(e.sessionId);
    if (e.type === 'page') pageviews++;
    else if (e.goal) {
      const n = byName.get(e.goal) ?? { count: 0, visitors: new Set<string>() };
      n.count++;
      n.visitors.add(e.visitorId);
      byName.set(e.goal, n);
    }
  }
  const list = [...byName].map(([name, n]) => ({ name, count: n.count, visitors: n.visitors.size }));
  list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { pageviews, visitors: visitors.size, sessions: sessions.size, users: users.size, events: list };
}

/** In-memory store for tests and quick local runs. Not persistent. */
export function createMemoryStore(): Store & { events: StoredEvent[] } {
  const events: StoredEvent[] = [];
  const ids = new Set<string>();
  return {
    events,
    async insertEvents(batch) {
      let n = 0;
      for (const e of batch) {
        if (ids.has(e.id)) continue;
        ids.add(e.id);
        events.push(e);
        n++;
      }
      return n;
    },
    async variantCounts(experiment, goal) {
      return attributeVariants(events, experiment, goal);
    },
    async propertyCounts(property, since, until) {
      return countProperty(events, property, since, until);
    },
    async propertyEvents(property, { before, limit }) {
      return events
        .filter((e) => ANALYTICS_TYPES.has(e.type) && e.experiment === property && e.ts < before)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit);
    },
    async summaries() {
      const map = new Map<string, ExperimentSummary & { visitorSet: Set<string> }>();
      for (const e of events) {
        if (e.type !== 'exposure' || !e.experiment) continue;
        const s = map.get(e.experiment) ?? {
          experiment: e.experiment,
          exposures: 0,
          visitors: 0,
          firstExposureAt: null,
          lastExposureAt: null,
          visitorSet: new Set<string>(),
        };
        s.exposures++;
        s.visitorSet.add(e.visitorId);
        s.firstExposureAt = s.firstExposureAt === null ? e.ts : Math.min(s.firstExposureAt, e.ts);
        s.lastExposureAt = s.lastExposureAt === null ? e.ts : Math.max(s.lastExposureAt, e.ts);
        map.set(e.experiment, s);
      }
      return [...map.values()].map(({ visitorSet, ...s }) => ({ ...s, visitors: visitorSet.size }));
    },
  };
}
