import { attributeVariants, type AttributedCounts } from './attribution';

/** One row in the events table, whatever the backing database. */
export interface StoredEvent {
  id: string;
  type: 'exposure' | 'goal';
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
  close?(): Promise<void> | void;
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
