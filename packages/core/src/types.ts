/**
 * SplitHub configuration types. `splithub.config.ts` is the single source of
 * truth for experiments: the SDK, the CLI, the self-hosted handler and the
 * cloud all read the same object.
 */

export type ExperimentStatus = 'draft' | 'running' | 'paused' | 'finished';

export type ExperimentKind = 'component' | 'value' | 'redirect' | 'mvt';

/** Weight shorthand (`{ control: 50, bold: 50 }`) or a full variant object. */
export type ComponentVariantInput = number | { weight: number };
export type ValueVariantInput = { weight: number; value: unknown };
export type RedirectVariantInput = { weight: number; to: string };

// ---------------------------------------------------------------------------
// Targeting (optional per experiment): who enters and which branch they take
// ---------------------------------------------------------------------------

export type TargetField =
  | 'country'
  | 'region'
  | 'city'
  | 'device'
  | 'browser'
  | 'os'
  | 'language'
  | 'referrer'
  | 'url'
  | 'path'
  | 'query'
  | 'utm_source'
  | 'utm_medium'
  | 'utm_campaign'
  | 'utm_term'
  | 'utm_content'
  | 'cookie'
  | 'visitor'
  | 'hour'
  | 'weekday'
  /** `web`, `ios`, `android`, `macos`, `windows`, `linux` (apps report theirs; the browser is `web`). */
  | 'platform'
  /** The app's version (`2.4.1`); compare with `gte` / `lt`. Absent on websites. */
  | 'app_version';

export type TargetOp = 'is' | 'is_not' | 'contains' | 'not_contains' | 'starts_with' | 'in' | 'not_in' | 'matches' | 'exists' | 'not_exists' | 'gte' | 'lt';

export interface TargetCondition {
  field: TargetField;
  op: TargetOp;
  /** Parameter / cookie name for `query` and `cookie`. */
  key?: string;
  /** Comparison value; comma-separated list for `in` / `not_in`; regex for `matches`; a version or number for `gte` / `lt` (dotted versions compare part by part). */
  value?: string;
}

export type FlowNode =
  | { type: 'condition'; conditions: TargetCondition[]; match?: 'all' | 'any'; then: string; else?: string | null }
  | { type: 'split'; outputs: Array<{ weight: number; to: string }> }
  | { type: 'variant'; variant: string }
  | { type: 'skip' };

/** Node graph edited in the dashboard: start -> conditions / splits -> variant or skip. */
export interface Flow {
  start: string;
  nodes: Record<string, FlowNode>;
  /** Editor positions, ignored by the SDK. */
  layout?: Record<string, { x: number; y: number }>;
}

/** What the SDK knows about the visitor when assigning. Everything is optional. */
export interface TargetingContext {
  country?: string;
  region?: string;
  city?: string;
  device?: string;
  browser?: string;
  os?: string;
  /** Accept-Language / navigator.language. */
  language?: string;
  referrer?: string;
  /** Full URL (query included) of the current page / request. */
  url?: string;
  cookies?: Record<string, string>;
  /** `new` on the visit that created the visitor id, `returning` afterwards. */
  visitor?: 'new' | 'returning';
  /** Clock for `hour` / `weekday`, defaults to now. */
  now?: number;
  /**
   * IANA time zone of the visitor (`Europe/Berlin`) for `hour` / `weekday`. The browser
   * fills it from the device; on the server it comes from geo headers. Without it, UTC.
   */
  timezone?: string;
  /** `web` in the browser; an app reports its platform (`ios`, `android` ...). */
  platform?: AppPlatform;
  /** The app's version, for `app_version` conditions. */
  appVersion?: string;
}

export type AppPlatform = 'web' | 'ios' | 'android' | 'macos' | 'windows' | 'linux';

export interface ExperimentBase {
  status: ExperimentStatus;
  /** Targeting / branching graph. Omit to use plain weights for everyone. */
  flow?: Flow;
  /** Share of visitors entering the experiment, 0..1. Defaults to 1. The rest see the control without an exposure. */
  traffic?: number;
  /** Stop accepting new visitors after this many exposures (the cloud finishes the experiment). */
  maxExposures?: number;
  /** Only run between these moments (ISO 8601). Outside the window the experiment behaves as not running. */
  schedule?: { startAt?: string; endAt?: string };
  /**
   * The goal the verdict is judged on: a key from `goals` or any event name (`'signup'`,
   * `'Video Played'`). A name not declared in `goals` becomes an event goal keyed by its slug.
   */
  goal?: string;
  /** Hash seed. Change it to reshuffle every visitor. Defaults to the experiment key. */
  seed?: string;
  /** Free-form note shown in the dashboard and CLI. */
  description?: string;
  /**
   * Human name shown in the dashboard and CLI instead of the key (up to 80 characters). Rename
   * freely: the key stays, and with it the assignment and the collected data.
   */
  name?: string;
  /**
   * Opt-in runtime minimum: days of data (24-hour periods since the first exposure) before a
   * verdict, integer 0..30. Default 0: verdicts depend on sample size, not runtime.
   */
  minDays?: number;
  /**
   * Total visitors at which the sample counts as good (`verdict.sample.quality`), integer
   * 100..10,000,000. Default 5000. Informational; it does not change the verdict.
   */
  goodSample?: number;
  /**
   * Goals (keys or event names) read beside the primary `goal`. `secondary`: informational, compared the same way.
   * `guardrails`: must not get significantly worse; a variant that hurts one is never called the winner.
   * A guardrail is worse when its conversion rate drops; pass `{ goal, worse: 'higher' }` for goals
   * where more is bad (refunds, errors).
   */
  metrics?: { secondary?: string[]; guardrails?: Array<string | GuardrailInput> };
  /**
   * Mutual exclusion: experiments in the same layer never share a visitor. Each visitor
   * falls in one bucket 0..99 per layer; the experiment enrolls only buckets in
   * `range: [start, end)`. Ranges of experiments in one layer must not overlap, and are
   * explicit so adding an experiment never moves visitors of the others.
   */
  layer?: { key: string; range: [number, number] };
}

export interface GuardrailInput {
  goal: string;
  /** Which direction is bad. Default `lower` (fewer conversions is worse). */
  worse?: 'lower' | 'higher';
}

export interface ComponentExperimentInput extends ExperimentBase {
  kind: 'component';
  variants: Record<string, ComponentVariantInput>;
}

export interface ValueExperimentInput extends ExperimentBase {
  kind: 'value';
  variants: Record<string, ValueVariantInput>;
}

export interface RedirectExperimentInput extends ExperimentBase {
  kind: 'redirect';
  /** Path (or path prefix with trailing `*`) the redirect applies to. */
  match: string;
  variants: Record<string, RedirectVariantInput>;
}

/**
 * Multivariate: several factors change at once and every combination is a
 * variant. `{ headline: { old: 'Old', new: 'New' }, button: { red: '#f00', green: '#0f0' } }`
 * gives four variants; the first level of every factor is the control. Besides
 * the verdict over combinations, each factor is read on its own (main effects).
 * Keep it small: at most 4 factors, 4 levels each, 16 combinations.
 */
export interface MvtExperimentInput extends ExperimentBase {
  kind: 'mvt';
  factors: Record<string, Record<string, unknown>>;
}

export type ExperimentInput =
  | ComponentExperimentInput
  | ValueExperimentInput
  | RedirectExperimentInput
  | MvtExperimentInput;

/** Shared by every goal: a label for people, and a fixed value per conversion for analytics. */
export interface GoalLabels {
  /** Human name ("Sign up"); the key stays what the code sends. */
  name?: string;
  description?: string;
  /** Value of one conversion in analytics reports when the event carries no `revenue` prop. */
  value?: number;
}

export type GoalInput =
  | (GoalLabels & {
      type: 'event';
      revenue?: boolean;
      /** The event name analytics matches when it differs from the key (`'Video Played'` for key `video-played`). */
      event?: string;
    })
  | (GoalLabels & { type: 'pageview'; path: string })
  /** Counted when a visitor clicks an element matching the CSS selector (auto-tracked by the SDK and the drop-in script). */
  | (GoalLabels & { type: 'click'; selector: string });

export type StorageInput =
  | {
      mode: 'cloud';
      /** Public project key (`pk_...`). Safe to ship to the browser. */
      key?: string;
      /** Override the cloud ingest URL (staging, self-hosted cloud). */
      endpoint?: string;
    }
  | {
      mode: 'self';
      /** URL of your own ingest route, e.g. `/api/splithub`. */
      endpoint: string;
    };

/**
 * An analytics property: a stream of pageviews and custom events, read as reports
 * (visitors, pages, sources, events, goal conversions). Declared like experiments;
 * `paused` drops its events at ingest.
 */
export interface PropertyInput {
  /** Default `running`. */
  status?: PropertyStatus;
  /** Human name shown in the dashboard and CLI (up to 80 characters). */
  name?: string;
  description?: string;
  /** Goal keys from `goals` reported as conversions of this property. Default: every goal of the project. */
  goals?: string[];
  /** What the property measures: a website (default) or an app (screens instead of pages, versions, retention). */
  kind?: PropertyKind;
}

export type PropertyKind = 'site' | 'app';

export type PropertyStatus = 'running' | 'paused';

export interface SplitHubConfigInput {
  project: string;
  storage: StorageInput;
  /** Goals by key: events you mark as goals, page visits or clicks. */
  goals?: Record<string, GoalInput>;
  experiments: Record<string, ExperimentInput>;
  /** Analytics properties by key: pageviews and custom events, no variants. */
  properties?: Record<string, PropertyInput>;
  /** Cookie / localStorage key for the visitor id. Defaults to `sh_vid`. */
  visitorKey?: string;
  /**
   * Treat `status: 'draft'` experiments as running while the app runs in
   * development (`NODE_ENV === 'development'`: `next dev`, `vite`). Lets you
   * see a test before you start it. Production builds ignore drafts as usual.
   */
  runDraftsInDev?: boolean;
  /** Mutual exclusion layers by key. `seed` reshuffles the layer's buckets (default: the layer key). */
  layers?: Record<string, { seed?: string }>;
  /**
   * Holdout: this share of visitors (`percent`, 0..50) sees the control in every experiment and
   * is compared with everyone else as the reserved experiment `__holdout` (variants `holdout`,
   * `enrolled`) for the long-term effect of all your tests together. `goal` is its primary goal
   * (any event name; default: the first declared goal); the other goals are read as secondary metrics.
   */
  holdout?: { percent: number; seed?: string; goal?: string };
}

// ---------------------------------------------------------------------------
// Normalized shapes (what the SDK works with after defineConfig)
// ---------------------------------------------------------------------------

export interface Variant {
  key: string;
  /** Weight normalized to a share in 0..1. */
  weight: number;
  value?: unknown;
  to?: string;
  /** Multivariate: which level of each factor this combination uses. */
  levels?: Record<string, string>;
}

/** Multivariate factor: its levels in declared order (the first is the control level). */
export interface Factor {
  key: string;
  levels: string[];
}

export interface Experiment {
  key: string;
  kind: ExperimentKind;
  status: ExperimentStatus;
  traffic: number;
  /** Exposure cap; null = unlimited. */
  maxExposures?: number | null;
  /** Run window; null = always. */
  schedule?: { startAt?: string | null; endAt?: string | null } | null;
  goal: string | null;
  seed: string;
  description: string | null;
  /** Human name; absent = show the key. */
  name?: string;
  match: string | null;
  /** Ordered: the first variant is the control. */
  variants: Variant[];
  /** Where the experiment was defined: the config file (default) or the cloud dashboard. */
  origin?: 'config' | 'dashboard';
  /** Targeting / branching graph; null or absent = plain weights. */
  flow?: Flow | null;
  /** Multivariate: the factors whose combinations the variants are. */
  factors?: Factor[];
  /** Goals read beside the primary one; absent = none. */
  metrics?: ExperimentMetrics;
  /** Mutual exclusion layer and the bucket range `[start, end)` (0..100) this experiment enrolls. */
  layer?: { key: string; range: [number, number] };
  /** Minimum runtime in days before a verdict; absent = the stats default (0, none). */
  minDays?: number;
  /** Total visitors for a good sample; absent = the stats default (5000). */
  goodSample?: number;
}

export interface ExperimentMetrics {
  secondary: string[];
  guardrails: Array<{ goal: string; worse: 'lower' | 'higher' }>;
}

export interface Holdout {
  /** Share of visitors held out, 0..50 (percent). */
  percent: number;
  seed: string;
  /** Primary goal of the `__holdout` comparison; null when no goal is declared. */
  goal: string | null;
}

export interface Goal {
  key: string;
  type: 'event' | 'pageview' | 'click';
  path: string | null;
  /** CSS selector for click goals. */
  selector?: string | null;
  revenue: boolean;
  description: string | null;
  /** Human name; absent = show the key. */
  name?: string;
  /** Fixed value of one conversion in analytics; absent = none. */
  value?: number;
  /** Event name analytics matches instead of the key. */
  event?: string;
}

export interface Property {
  key: string;
  status: PropertyStatus;
  /** Human name; absent = show the key. */
  name?: string;
  description: string | null;
  /** Goal keys reported as conversions; empty = every goal of the project. */
  goals: string[];
  /** Where the property was defined: the config file (default) or the cloud dashboard. */
  origin?: 'config' | 'dashboard';
  /** Default `site`. */
  kind?: PropertyKind;
}

export interface SplitHubConfig {
  project: string;
  storage: StorageInput;
  visitorKey: string;
  runDraftsInDev: boolean;
  goals: Goal[];
  experiments: Experiment[];
  /** Analytics properties; absent = none. */
  properties?: Property[];
  /** Layer seeds by key; a layer missing here uses its key as the seed. */
  layers?: Record<string, { seed: string }>;
  holdout?: Holdout | null;
  /** Branded marker so plain objects are rejected by the SDK. */
  readonly __splithub: 2;
}

// ---------------------------------------------------------------------------
// Events (wire format)
// ---------------------------------------------------------------------------

export interface ExposureEvent {
  id: string;
  type: 'exposure';
  exp: string;
  var: string;
  vid: string;
  sid: string;
  /** Unix ms. */
  ts: number;
  url?: string;
  /**
   * Where the visit came from: the referrer's origin (no path, no query), `''` for a direct
   * visit; absent when unknown. The cloud derives the visitor's channel and source from it.
   */
  ref?: string;
}

export interface GoalEvent {
  id: string;
  type: 'goal';
  goal: string;
  vid: string;
  sid: string;
  ts: number;
  url?: string;
  props?: Record<string, unknown>;
}

/** A page view of an analytics property. `ref` is the document referrer, `title` the page title. */
export interface PageEvent {
  id: string;
  type: 'page';
  prop: string;
  vid: string;
  sid: string;
  ts: number;
  url: string;
  title?: string;
  ref?: string;
}

/** A custom event of an analytics property (`signup`, `Video Played`), with optional props. */
export interface TrackEvent {
  id: string;
  type: 'event';
  prop: string;
  name: string;
  vid: string;
  sid: string;
  ts: number;
  url?: string;
  props?: Record<string, unknown>;
}

/**
 * Time on page and scroll depth for the page just left, sent on route change and page hide.
 * `ms`: visible time on that page (0..3,600,000); `scroll`: deepest scroll, percent (0..100). Not billed.
 */
export interface EngageEvent {
  id: string;
  type: 'engage';
  prop: string;
  vid: string;
  sid: string;
  ts: number;
  url: string;
  ms: number;
  scroll: number;
}

/** Ties the anonymous visitor to the app's user id (1..128 characters), with flat traits up to 4 KB. Not billed. */
export interface IdentifyEvent {
  id: string;
  type: 'identify';
  prop: string;
  vid: string;
  sid: string;
  ts: number;
  uid: string;
  traits?: Record<string, string | number | boolean>;
}

export type SplitHubEvent = ExposureEvent | GoalEvent | PageEvent | TrackEvent | EngageEvent | IdentifyEvent;

/**
 * Who sends a batch from an app (absent from websites). The cloud takes the device, OS and
 * platform from here instead of the user agent, and `id` stands in for the origin: an allowed
 * domain list may name the app's bundle id / package name.
 */
export interface AppInfo {
  platform: Exclude<AppPlatform, 'web'>;
  /** Bundle id / application id (`com.acme.shop`), up to 128 characters. */
  id?: string;
  /** Marketing version (`2.4.1`), up to 32 characters. */
  version?: string;
  /** Build number (`412`), up to 32 characters. */
  build?: string;
  /** OS version (`18.1`), up to 32 characters. */
  os?: string;
  /** Device model (`iPhone15,2`, `Pixel 8`), up to 64 characters. */
  model?: string;
  device?: 'mobile' | 'tablet' | 'desktop';
}

export interface EventBatch {
  project: string;
  sdk: string;
  events: SplitHubEvent[];
  app?: AppInfo;
}

export interface Assignment {
  experiment: string;
  /** Null when the visitor is outside the traffic share or the experiment is not running. */
  variant: Variant | null;
  /**
   * Why the variant was (not) assigned. Useful for `splithub doctor`. `dev`: a draft served because of `runDraftsInDev`.
   * `holdout`: the visitor is in the project's holdout. `layer`: another experiment of the same layer owns the visitor's bucket.
   * `pending`: a first visit waiting for the dashboard's overrides (control meanwhile).
   */
  reason: 'assigned' | 'dev' | 'not_running' | 'outside_traffic' | 'unknown_experiment' | 'override' | 'targeting' | 'bot' | 'no_visitor' | 'layer' | 'holdout' | 'pending';
}
