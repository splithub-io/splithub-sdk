// @splithub/mcp — stdio MCP server exposing the splithub CLI as tools.
//
//   { "mcpServers": { "splithub": { "command": "npx", "args": ["-y", "@splithub/mcp"] } } }
//
// Every tool runs `splithub <command> --json` in SPLITHUB_PROJECT_DIR (default:
// the client's working directory), so the agent sees exactly what a human
// would get from the terminal, with the same config file and credentials.
// Errors come back with the CLI's stable `code` (NOT_LOGGED_IN, NO_CONFIG, ...).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { errorBody, runCli, startLogin, type CliResult } from './cli.js';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
const server = new McpServer({ name: 'splithub', version: pkg.version });

type ToolReply = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

/** What to do next for each CLI error code. */
const NEXT_BY_CODE: Record<string, string> = {
  NOT_LOGGED_IN: 'This folder is not connected to SplitHub Cloud: call splithub_login, show the link to the user, wait for their approval, then retry.',
  NO_CONFIG: 'No splithub.config.ts here: call splithub_init first (or set SPLITHUB_PROJECT_DIR to the app folder).',
  EXPERIMENT_NOT_FOUND: 'Call splithub_status for the experiment ids.',
  CONFIG_UNSAFE: 'Edit splithub.config.ts by hand where the experiment is defined, then call splithub_doctor.',
  CONFIG_WRITE: 'The config file was restored as it was. Make the change by hand, then call splithub_doctor.',
  CONFIG_PARSE: 'Fix the error in splithub.config.ts, then call splithub_doctor.',
  KEY_CONFLICT: 'The key already belongs to another experiment in the cloud. Ask the user whether this is a new experiment (rename the key, or splithub_push with replace: the old numbers are cleared) or the same experiment (splithub_push with same). Never pick for them.',
  KEY_DELETED: 'A deleted experiment used this key. Rename the experiment key in splithub.config.ts (and in the code), then call splithub_push again.',
  NOT_CLOUD: 'This project stores events in its own database (self-hosted). Experiment slices, breakdowns, timelines, engagement, events by variant and raw events, push, funnels, paths, retention, realtime, segments, notes, links and alerts come with SplitHub Cloud: tell the user; splithub_analytics still reads raw counts.',
  PRO_REQUIRED: 'Alert rules fire on Pro. Tell the user; they upgrade in the dashboard (Billing), then the rule can be turned on.',
  NOT_FOUND: 'Call the same tool with action list for the ids.',
  INSUFFICIENT_SCOPE: 'This API key lacks the scope named in `scope` (e.g. notes:write). Ask the user for a key with it (dashboard, Settings, API keys) or call splithub_login again.',
};

function reply(r: CliResult, options: { structured?: boolean } = {}): ToolReply {
  const err = errorBody(r.json);
  if (r.code !== 0 || err) {
    const body = err ?? { error: (r.stderr || r.stdout || 'the splithub CLI failed').trim(), code: 'INTERNAL' };
    const next = NEXT_BY_CODE[body.code];
    return { content: [{ type: 'text', text: JSON.stringify({ ...body, ...(next ? { next } : {}) }) }], isError: true };
  }
  const text = r.json ? JSON.stringify(r.json, null, 2) : r.stdout.trim();
  const structured = options.structured && r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? (r.json as Record<string, unknown>) : undefined;
  return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) };
}

// Output schemas mirror the CLI --json shapes (key fields; the rest passes through).
// SplitHub Cloud sends verdicts with ready-to-print words; a self-hosted endpoint sends raw counts and
// `analysis: { available: false }`.
const voiceShape = z
  .object({ scenario: z.string(), line: z.string(), advice: z.enum(['wait', 'ship', 'keep_control', 'move_on', 'fix_setup', 'hold']) })
  .passthrough()
  .describe('friendly line for humans; quote verdict.message for facts. advice move_on = suggest finishing and starting the next experiment');
const displayShape = z
  .object({ label: z.string(), lines: z.array(z.string()), next: z.string().optional() })
  .passthrough()
  .describe('ready-to-print label (WINNER, TOO EARLY, ...), lines and next step, for showing the result');
const analysisShape = z
  .object({ available: z.literal(false), message: z.string(), url: z.string() })
  .passthrough()
  .describe('self-hosted: raw numbers only. Tell the user verdicts come with SplitHub Cloud; never invent one');
const verdictShape = z.object({ status: z.string(), message: z.string(), winner: z.string().nullable().optional(), notes: z.array(z.string()).optional() }).passthrough();
const statusOutput = z.object({
  project: z.string(),
  experiments: z.array(z.object({ experiment: z.string(), kind: z.string(), status: z.string(), visitors: z.number(), days: z.number(), verdict: z.string().nullable().optional(), headline: z.string().nullable().optional(), sample: z.enum(['small', 'ok', 'good']).nullable().optional(), stars: z.number().nullable().optional(), daysToVerdict: z.number().nullable().optional(), voice: voiceShape.nullable().optional(), display: displayShape.optional() }).passthrough()),
  properties: z
    .array(z.object({ property: z.string(), name: z.string(), status: z.string(), visitors: z.number(), previousVisitors: z.number(), change: z.number().nullable(), conversions: z.array(z.object({ goal: z.string(), conversions: z.number(), change: z.number().nullable() }).passthrough()) }).passthrough())
    .optional()
    .describe('SplitHub Cloud: analytics properties, last 7 days (propertiesRange) against the 7 before; change is relative, null = no visitors before'),
  propertiesRange: z.object({ from: z.string(), to: z.string() }).optional(),
  analysis: analysisShape.optional(),
  next: z.string().optional(),
}).passthrough();
const scopeShape = z
  .object({ filtered: z.boolean(), range: z.object({ from: z.string(), to: z.string() }).nullable(), filters: z.record(z.union([z.string(), z.array(z.string())])), note: z.string().optional() })
  .passthrough()
  .describe('present on a slice (from / to / filters): the verdict is computed on that slice only; quote note');
const resultsOutput = z.object({
  experiment: z.string(),
  view: z.enum(['breakdown', 'timeline', 'engagement', 'events']).optional().describe('set when by, timeline, engagement or events was asked: the shape is that view, not a verdict'),
  kind: z.string().optional(),
  status: z.string().optional(),
  goal: z.string().nullable().optional(),
  scope: scopeShape.optional(),
  verdict: verdictShape.optional().describe('SplitHub Cloud only'),
  daysToVerdict: z.number().nullable().optional().describe('days until a verdict at the current traffic; schedule the next check then'),
  voice: voiceShape.nullable().optional(),
  display: displayShape.optional(),
  variants: z
    .array(z.union([z.string(), z.object({ variant: z.string(), visitors: z.number() }).passthrough()]))
    .optional()
    .describe('self-hosted: raw counts per variant (conversions, rate), control first; view engagement: sessions, pagesPerVisit, bounceRate, avgVisit (ms) per variant; view events: the variant keys, control first'),
  rows: z
    .array(z.object({ name: z.string(), goalKey: z.string().nullable(), isGoal: z.boolean(), measured: z.enum(['goal', 'metric', 'guardrail']).nullable() }).passthrough())
    .optional()
    .describe('view events: every goal and event of these visitors; perVariant { visitors, count, rate, revenue } and comparisons[] against the control (lift, pValue, significant); small = too few visitors'),
  analysis: analysisShape.optional(),
  next: z.string().optional(),
}).passthrough();
const refsOutput = z.object({
  experiment: z.string(),
  goal: z.string().nullable(),
  goalShared: z.boolean(),
  inConfig: z.boolean(),
  count: z.number(),
  refs: z.array(z.object({ file: z.string(), line: z.number(), column: z.number(), text: z.string(), match: z.enum(['experiment', 'goal']) }).passthrough()),
}).passthrough();
const shipOutput = z.object({
  experiment: z.string(),
  kept: z.string(),
  kind: z.string(),
  dryRun: z.boolean(),
  live: z.string(),
  configFile: z.string(),
  files: z.array(z.string()),
  diff: z.string().describe('unified diff of the config and the source files'),
  leftovers: z.array(z.object({ file: z.string(), line: z.number(), text: z.string(), reason: z.string() }).passthrough()),
  next: z.array(z.string()),
}).passthrough();

/** Visitor columns experiment reports filter by, and the dimensions a breakdown splits by (the CLI checks the same lists). `page` is analytics' word: landing as a filter, url as a breakdown. */
const EXPERIMENT_FILTERS = ['country', 'region', 'city', 'device', 'os', 'browser', 'language', 'host', 'platform', 'app_version', 'source', 'channel', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'landing', 'page'] as const;
const EXPERIMENT_BY = ['country', 'region', 'city', 'device', 'os', 'browser', 'language', 'host', 'platform', 'app_version', 'page', 'url', 'referrer', 'source', 'channel', 'landing', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
function experimentArgs(a: { from?: string; to?: string; filters?: Partial<Record<string, string>> }): string[] {
  const args: string[] = [];
  if (a.from) args.push('--from', a.from);
  if (a.to) args.push('--to', a.to);
  for (const [k, v] of Object.entries(a.filters ?? {})) if (v) args.push('--filter', `${k}=${v}`);
  return args;
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const LOOP = 'The loop: splithub_plan → splithub_experiment_create → wire the code → splithub_doctor → splithub_push (cloud) → splithub_results (re-check after daysToVerdict days) → splithub_experiment_status finished → splithub_ship.';

server.registerTool(
  'splithub_status',
  {
    description: `Every experiment of this project with status, visitors, days, the verdict headline, sample (verdict.sample.quality: small | ok | good), stars (verdict.sample.stars, data quality 0..5) and daysToVerdict (days until a verdict at the current traffic: schedule the next check then, do not poll). verdict guardrail_breached = do not ship that variant. The __holdout row is the project holdout (long-term impact). properties[] (SplitHub Cloud) is each analytics property's last 7 days against the 7 before (visitors, change, goal conversions): mention a big move; splithub_analytics has the details. Start here. A finished experiment is over but its variants are still in the code: report its verdict, ask the user which variant to keep and whether to remove the experiment, then call splithub_ship. display { label, lines, next } is ready to show; voice.line is the friendly line for humans; voice.advice move_on means suggest finishing the experiment and starting the next one. If analysis.available is false the project is self-hosted: report the raw numbers as they are, say verdicts come with SplitHub Cloud (analysis.url), and never call a winner from raw rates. ${LOOP}`,
    outputSchema: statusOutput,
  },
  async () => reply(await runCli(['status']), { structured: true })
);

server.registerTool(
  'splithub_results',
  {
    description: 'Results of one experiment. SplitHub Cloud gives the full verdict: sample per variant, lift, P(beat), SRM, winner; mvt adds factors[]. verdict.status guardrail_breached means do not ship: a variant made a guardrail metric worse (verdict.guardrailBreached[]); say what broke. verdict.metrics[] has secondary metrics and guardrails. The experiment __holdout is the project holdout (long-term impact of all experiments). Verdicts are sequential (always-valid, safe to check any time) and depend on sample size, not days. verdict.sample.quality is small (below the minimums), ok, or good (every variant has its share of verdict.sample.goodSample, default 5000 visitors): say it next to the verdict; it never changes the decision. verdict.sample.stars (0..5) is a data-quality score from verdict.sample.checks[] (minimum, split, goodSample, power, week; each { met, label }): report the stars and the unmet labels, never as a reason to override the verdict. Quote verdict.message verbatim, use comparisons[].sequential.pValue / sequential.ci (the plain pValue is fixed-horizon, display only: p = 0.01 there can be not significant) and relay verdict.notes[]. daysToVerdict says when to check again. Facts are in verdict.message; voice.line is the friendly line for humans (voice.advice move_on = suggest finishing the experiment and starting the next one); display { label, lines, next } is ready to show. If analysis.available is false the project is self-hosted: report the raw numbers as they are, say verdicts come with SplitHub Cloud (analysis.url), and never call a winner from raw rates. If finished, ask which variant to keep, then splithub_ship. SLICE (SplitHub Cloud): from / to (YYYY-MM-DD, project time zone) keep the visitors first exposed on those days, filters keep visitors by country, device, platform (ios, android, web…), app_version, source, channel, landing page, UTM…; the answer carries scope and the verdict is computed on that slice only: say so and quote scope.note, the decision stays with the unfiltered verdict. A slice carries no voice and no advice (numbers only): never suggest shipping or finishing from one. VIEWS (one at a time, same from / to / filters; the answer has view set): by splits visitors by a dimension, segments[] each with cells per variant (order[] = variants, control first) and comparisons[] (lift vs the control inside the segment, pValue, significant, better; small = too few visitors); timeline gives exposures[] and conversions[] per day and variant (a day = visitors first seen that day, conversions whenever they happened); engagement gives bounce rate, pages per visit and avgVisit (ms) per variant from the analytics property on the same visitors (property null = no analytics there); events gives rows[] for every goal (measured goal / metric / guardrail first) and event of these visitors, each with perVariant visitors and rate and comparisons[] against the control (property null = goals only, other events need analytics on the same site). Segments, engagement and events are for exploring: never call a winner from one segment or one event.',
    inputSchema: {
      experiment: z.string().describe('experiment id (key)'),
      from: z.string().regex(DAY).optional().describe('first-exposure day, from (inclusive)'),
      to: z.string().regex(DAY).optional().describe('first-exposure day, to (inclusive)'),
      filters: z.record(z.enum(EXPERIMENT_FILTERS), z.string()).optional().describe('visitor column → comma-separated values, e.g. { country: "DE,FR", channel: "Paid Search" }; "(none)" matches empty'),
      by: z.enum(EXPERIMENT_BY).optional().describe('view: lift per segment of this dimension'),
      timeline: z.boolean().optional().describe('view: visitors and conversions per day and variant'),
      engagement: z.boolean().optional().describe('view: bounce rate, pages per visit, visit length per variant'),
      events: z.boolean().optional().describe('view: every goal and event per variant, with lift against the control'),
    },
    outputSchema: resultsOutput,
  },
  async (a) => reply(await runCli(['results', a.experiment, ...experimentArgs(a), ...(a.by ? ['--by', a.by] : []), ...(a.timeline ? ['--timeline'] : []), ...(a.engagement ? ['--engagement'] : []), ...(a.events ? ['--events'] : [])]), { structured: true })
);

server.registerTool(
  'splithub_experiment_events',
  {
    description: 'The latest raw events of one experiment (SplitHub Cloud, newest first): exposures (type exposure, the variant a visitor saw) and goals (type goal) with time, visitor, url, country. Same from / to / filters as splithub_results; type keeps one kind; nextBefore pages to older ones (pass it as before). Raw events stay 7 days (30 on Pro); the key needs events:read. Use to check that exposures and goals arrive after wiring code.',
    inputSchema: {
      experiment: z.string().describe('experiment id (key)'),
      type: z.enum(['exposure', 'goal']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      before: z.number().int().positive().optional().describe('nextBefore of the previous page (unix ms)'),
      from: z.string().regex(DAY).optional(),
      to: z.string().regex(DAY).optional(),
      filters: z.record(z.enum(EXPERIMENT_FILTERS), z.string()).optional().describe('visitor column → comma-separated values'),
    },
  },
  async (a) => reply(await runCli(['events', '--experiment', a.experiment, ...experimentArgs(a), ...(a.type ? ['--type', a.type] : []), ...(a.limit ? ['--limit', String(a.limit)] : []), ...(a.before ? ['--before', String(a.before)] : [])]))
);

server.registerTool(
  'splithub_plan',
  {
    description: 'Before creating an experiment: visitors per variant (and in all) to detect a relative lift `mde` on a `baseline` conversion rate, sized by SplitHub Cloud for its sequential verdict (no account needed; fails with UNREACHABLE offline). With an experiment id, also the days left at its current traffic when its numbers are readable. If it takes months, suggest a bigger change or a busier page.',
    inputSchema: {
      baseline: z.number().gt(0).lt(1).describe('conversion rate today, e.g. 0.05'),
      mde: z.number().gt(0).describe('smallest relative lift worth finding, e.g. 0.1 for +10%'),
      variants: z.number().int().min(2).optional().describe('number of variants including the control (default 2)'),
      experiment: z.string().optional().describe('experiment id: adds days at its traffic'),
    },
  },
  async ({ baseline, mde, variants, experiment }) => reply(await runCli(['plan', ...(experiment ? [experiment] : []), '--baseline', String(baseline), '--mde', String(mde), ...(variants ? ['--variants', String(variants)] : [])]))
);

/** Old tool names (before `splithub_<noun>_<verb>`), still registered for one release. */
const oldName = (name: string) => `Old name of ${name}, kept for one release: call ${name} instead.`;

for (const [name, old] of [['splithub_experiment_create', false], ['splithub_create_experiment', true]] as const)
  server.registerTool(
    name,
    {
      description: old ? oldName('splithub_experiment_create') : `Add an experiment to splithub.config.ts (checked by reloading the file). It is written as running: it goes live when the code is deployed (and pushed in cloud mode). Tell the user that, and that splithub_experiment_status paused holds it. Pass status draft only when the user asks to hold it. kind: value (text/number/URL read with useValue), component (<Experiment>/<Variant> markup), redirect (match path + per-variant destination), mvt (factors instead of variants, every combination compared, read with useValue as { factor: value }). First variant / first level is the control. In an app (React Native, Expo) redirect does nothing, and the config ships inside the build: the variants' code needs a release, then starting, pausing and weights apply live from the cloud; target new builds with an app_version gte condition in the flow. goodSample: total visitors at which the sample counts as good (default 5000). minDays: opt-in fewest days before a verdict (default 0 = none). Then wire the returned snippet, call splithub_doctor and splithub_refs. ${LOOP}`,
      inputSchema: {
        id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).describe('experiment key, lowercase'),
        kind: z.enum(['value', 'component', 'redirect', 'mvt']),
        variants: z.array(z.string()).min(2).optional().describe('variant keys, first = control (not for mvt)'),
        factors: z.record(z.record(z.string())).optional().describe('mvt only: factor → level → value, e.g. { headline: { old: "Old", new: "New" }, button: { blue: "#2563eb", green: "#16a34a" } }; first level = control; at most 4 factors × 4 levels'),
        weights: z.array(z.number().min(0)).optional().describe('relative weights, same order as variants (not for mvt)'),
        goal: z.string().optional().describe('the goal: any event name the app sends with track() (signup, Video Played) or a goal key from the config; an event not in goals becomes a goal, nothing to declare first'),
        values: z.record(z.string()).optional().describe('value experiments: variant → value'),
        match: z.string().optional().describe('redirect experiments: the path it runs on, e.g. /'),
        to: z.record(z.string()).optional().describe('redirect experiments: variant → destination path'),
        status: z.enum(['draft', 'running']).optional(),
        name: z.string().max(80).optional().describe('human name shown instead of the key; can be renamed later, the key stays'),
        description: z.string().optional(),
        traffic: z.number().gt(0).max(100).optional().describe('percent of visitors in the experiment (default 100)'),
        maxVisitors: z.number().int().positive().optional().describe('stop counting after this many visitors'),
        minDays: z.number().int().min(0).max(30).optional().describe('opt-in fewest days before a verdict (default 0 = none); verdicts otherwise depend on sample size'),
        goodSample: z.number().int().min(100).max(10_000_000).optional().describe('total visitors at which verdict.sample.quality turns good (default 5000); informational, never changes the verdict'),
        start: z.string().optional().describe('ISO date the experiment starts'),
        end: z.string().optional().describe('ISO date the experiment ends'),
        secondary: z.array(z.string()).optional().describe('goals (event names or goal keys) to watch next to the primary goal'),
        guardrails: z.array(z.union([z.string(), z.object({ goal: z.string(), worse: z.enum(['lower', 'higher']) })])).optional().describe('goals (event names or goal keys) that must not get worse; { goal, worse: "higher" } when a rise is bad (refunds, errors). A breach makes the verdict guardrail_breached: do not ship'),
        layer: z.object({ key: z.string(), start: z.number().int().min(0).max(99), end: z.number().int().min(1).max(100) }).optional().describe('mutual exclusion: experiments in one layer never share a visitor; bucket ranges [start, end) must not overlap'),
      },
    },
    async (a) => {
      const args = ['create', '--kind', a.kind, '--id', a.id, '--yes'];
      if (a.kind === 'mvt') {
        for (const [factor, levels] of Object.entries(a.factors ?? {})) args.push('--factor', `${factor}=${Object.entries(levels).map(([l, v]) => `${l}:${v}`).join(',')}`);
      } else args.push('--variants', (a.variants ?? ['control', 'b']).join(','));
      if (a.weights) args.push('--weights', a.weights.join(','));
      if (a.goal) args.push('--goal', a.goal);
      if (a.values) for (const [k, v] of Object.entries(a.values)) args.push('--value', `${k}=${v}`);
      if (a.match) args.push('--match', a.match);
      if (a.to) for (const [k, v] of Object.entries(a.to)) args.push('--to', `${k}=${v}`);
      if (a.status) args.push('--status', a.status);
      if (a.name) args.push('--name', a.name);
      if (a.description) args.push('--description', a.description);
      if (a.traffic !== undefined) args.push('--traffic', String(a.traffic));
      if (a.maxVisitors !== undefined) args.push('--max-visitors', String(a.maxVisitors));
      if (a.minDays !== undefined) args.push('--min-days', String(a.minDays));
      if (a.goodSample !== undefined) args.push('--good-sample', String(a.goodSample));
      if (a.start) args.push('--start', a.start);
      if (a.end) args.push('--end', a.end);
      if (a.secondary?.length) args.push('--secondary', a.secondary.join(','));
      if (a.guardrails?.length) args.push('--guardrail', a.guardrails.map((g) => (typeof g === 'string' ? g : `${g.goal}:${g.worse}`)).join(','));
      if (a.layer) args.push('--layer', `${a.layer.key}:${a.layer.start}-${a.layer.end}`);
      return reply(await runCli(args));
    }
  );

for (const [name, old] of [['splithub_experiment_status', false], ['splithub_set_status', true]] as const)
  server.registerTool(
    name,
    {
      description: old ? oldName('splithub_experiment_status') : 'Start, pause or finish an experiment. The config file is updated (and checked); in cloud mode it applies live within a minute. After finishing, the variants are still in the code: ask the user which variant to keep, then call splithub_ship.',
      inputSchema: { experiment: z.string(), status: z.enum(['running', 'paused', 'finished']) },
    },
    async ({ experiment, status }) => {
      const cmd = status === 'running' ? 'start' : status === 'paused' ? 'pause' : 'finish';
      return reply(await runCli([cmd, experiment]));
    }
  );

/** Visit dimensions a funnel can be split by. */
const SESSION_BY = ['source', 'referrer', 'channel', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'country', 'region', 'city', 'device', 'os', 'browser', 'language', 'host', 'platform', 'app_version', 'entry', 'exit'] as const;
/** Range, filters and a saved segment: every analytics report takes them. */
const RANGE = {
  days: z.number().int().min(1).max(400).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  filters: z.record(z.string()).optional().describe('dimension → comma-separated values'),
  segment: z.string().optional().describe('saved segment name or id'),
};
function rangeArgs(a: { days?: number; from?: string; to?: string; filters?: Record<string, string>; segment?: string }): string[] {
  const args: string[] = [];
  if (a.days) args.push('--days', String(a.days));
  if (a.from) args.push('--from', a.from);
  if (a.to) args.push('--to', a.to);
  if (a.segment) args.push('--segment', a.segment);
  for (const [k, v] of Object.entries(a.filters ?? {})) args.push('--filter', `${k}=${v}`);
  return args;
}

const BY = ['source', 'referrer', 'channel', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'country', 'region', 'city', 'device', 'os', 'browser', 'language', 'host', 'platform', 'app_version', 'entry', 'exit', 'page', 'event', 'goal', 'variant', 'trait'] as const;

server.registerTool(
  'splithub_analytics',
  {
    description: `Analytics properties (pageviews or app screens, and custom events, no variants). A property is kind site or app; in an app a screen is a page (url /ScreenName) and platform / app_version are dimensions for by and filters. Without property: every property with visitors, visits, pageviews and bounce for the last 30 days. With property: totals (visitors, newVisitors, sessions = visits, pageviews, events, bounces, duration in ms; bounce rate = bounces / sessions), goals (conversions = unique visitors who reached it in the range, completions = how many times, revenue), topPages and topSources (value "(none)" = direct). With by: rows grouped by a visit dimension, page, event or goal; goal adds that goal's conversions per row; variant (needs experiment) splits visits by the variant each visitor saw, trait (needs key) by an identify() trait. Range: days (last N days) or from / to (YYYY-MM-DD, project time zone). filters narrow the visits, e.g. { country: "DE,FR", source: "(none)" }. Self-hosted projects get raw counts only (analysis.available false): report them as they are and say full reports come with SplitHub Cloud. compare adds previous (the compared range, with its dates in previous.range) for change against it: 'previous' (the same-length range right before), 'year' (the same days a year earlier) or 'YYYY-MM-DD..YYYY-MM-DD'. segment applies a saved segment (splithub_segments) by name or id. These are counts, not experiments: no verdicts, never call a winner from them.`,
    inputSchema: {
      property: z.string().optional().describe('property id; omit to list every property'),
      by: z.enum(BY).optional(),
      goal: z.string().optional().describe('with by: also count this goal per row'),
      experiment: z.string().optional().describe('by variant: the experiment key'),
      key: z.string().optional().describe('by trait: the trait name, e.g. plan'),
      days: z.number().int().min(1).max(400).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      filters: z.record(z.string()).optional().describe('dimension → comma-separated values'),
      segment: z.string().optional().describe('saved segment name or id'),
      compare: z.union([z.enum(['previous', 'year']), z.string().regex(/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/)]).optional().describe("also read another period: 'previous' (right before), 'year' (a year earlier) or 'YYYY-MM-DD..YYYY-MM-DD'"),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  async (a) => {
    const args = ['analytics', ...(a.property ? [a.property] : [])];
    if (a.by) args.push('--by', a.by);
    if (a.goal) args.push('--goal', a.goal);
    if (a.experiment) args.push('--experiment', a.experiment);
    if (a.key) args.push('--key', a.key);
    if (a.compare) args.push('--compare', a.compare);
    if (a.limit) args.push('--limit', String(a.limit));
    return reply(await runCli([...args, ...rangeArgs(a)]));
  }
);

server.registerTool(
  'splithub_analytics_funnel',
  {
    description: `Funnel of an analytics property (SplitHub Cloud): visitors who reached each step in order. Steps: page:/path (patterns like page:/blog/* work), event:<name>, goal:<key>; 2 to 8. Or funnel: a saved funnel's name or id (splithub_analytics_funnels), which brings its steps and within. within: visit (same visit, default), 7d or 30d (from the first step). Answers steps[] with visitors, conversion (share of the first step) and dropoff (share lost since the step before); by splits it by a visit dimension. rolledUp: days older than 90 count nothing. Counts, not an experiment: never call a winner from it.`,
    inputSchema: {
      property: z.string(),
      steps: z.array(z.string()).min(2).max(8).optional().describe('e.g. ["page:/", "event:Signup", "goal:paid"]; omit with funnel'),
      funnel: z.string().optional().describe('a saved funnel name or id'),
      within: z.enum(['visit', '7d', '30d']).optional(),
      by: z.enum(SESSION_BY).optional(),
      ...RANGE,
    },
  },
  async (a) => reply(await runCli(['analytics', 'funnel', a.property, ...(a.steps ? ['--steps', a.steps.join(',')] : []), ...(a.funnel ? ['--funnel', a.funnel] : []), ...(a.within ? ['--within', a.within] : []), ...(a.by ? ['--by', a.by] : []), ...rangeArgs(a)]))
);

server.registerTool(
  'splithub_analytics_funnels',
  {
    description: 'Saved funnels of an analytics property (SplitHub Cloud), shown on its Funnels tab for the whole team. Without save or delete: the list (id, name, steps, within). save + steps: save one under that name (a name already saved updates it; steps and within as in splithub_analytics_funnel). delete: remove one by id or name. Run one with splithub_analytics_funnel { funnel }.',
    inputSchema: {
      property: z.string(),
      save: z.string().max(60).optional().describe('name of the funnel to save or update'),
      steps: z.array(z.string()).min(2).max(8).optional().describe('e.g. ["page:/", "event:Signup", "goal:paid"]'),
      within: z.enum(['visit', '7d', '30d']).optional(),
      delete: z.string().optional().describe('id or name to delete'),
    },
  },
  async (a) => {
    if (a.delete) return reply(await runCli(['analytics', 'funnels', a.property, '--delete', a.delete]));
    if (a.save) return reply(await runCli(['analytics', 'funnels', a.property, '--save', a.save, ...(a.steps ? ['--steps', a.steps.join(',')] : []), ...(a.within ? ['--within', a.within] : [])]));
    return reply(await runCli(['analytics', 'funnels', a.property]));
  }
);

server.registerTool(
  'splithub_analytics_paths',
  {
    description: 'Where visits went right after a page (or, with direction prev, where they came from), within the visit (SplitHub Cloud). rows[] { value, visits }; (exit) = left the site, (entrance) = landed on the page.',
    inputSchema: { property: z.string(), page: z.string().describe('a path like /pricing or /blog/*'), direction: z.enum(['next', 'prev']).optional(), ...RANGE },
  },
  async (a) => reply(await runCli(['analytics', 'paths', a.property, '--page', a.page, ...(a.direction === 'prev' ? ['--prev'] : []), ...rangeArgs(a)]))
);

server.registerTool(
  'splithub_analytics_retention',
  {
    description: 'Retention cohorts of an analytics property (SplitHub Cloud), the key report for apps: users grouped by the day or week they started (start: visit, event:<name> or goal:<key>), and how many came back (return: visit or event:<name>) in period 0, 1, 2… cohorts[] { start, users, retained[] }; retained[0] is the cohort period itself, retained[i] / users is the share. Ranges longer than 90 days / 26 weeks are cut (clamped: true). Default: start visit, return visit, period week. filters take platform (ios, android, web…) and app_version too. Counts, not an experiment.',
    inputSchema: {
      property: z.string(),
      start: z.string().optional().describe('visit | event:<name> | goal:<key>'),
      return: z.string().optional().describe('visit | event:<name>'),
      period: z.enum(['day', 'week']).optional(),
      ...RANGE,
    },
  },
  async (a) => reply(await runCli(['analytics', 'retention', a.property, ...(a.start ? ['--start', a.start] : []), ...(a.return ? ['--return', a.return] : []), ...(a.period ? ['--period', a.period] : []), ...rangeArgs(a)]))
);

server.registerTool(
  'splithub_analytics_realtime',
  {
    description: 'Who is on an analytics property right now (SplitHub Cloud): activeVisitors5m, pageviews and events per minute over the last 30 minutes, top pages and sources. Use to confirm tracking works after a deploy.',
    inputSchema: { property: z.string() },
  },
  async ({ property }) => reply(await runCli(['analytics', 'realtime', property]))
);

server.registerTool(
  'splithub_segments',
  {
    description: 'Saved segments: named report filters every report can apply (segment on splithub_analytics, funnel, paths, retention). Without arguments: the list. save + filters: save one (filters like { country: "DE,FR", channel: "Paid Search" }; property limits it to one property). delete: remove one by id or name. SplitHub Cloud.',
    inputSchema: {
      save: z.string().max(60).optional().describe('name of the segment to save'),
      filters: z.record(z.string()).optional().describe('dimension → comma-separated values'),
      property: z.string().optional(),
      delete: z.string().optional().describe('id or name to delete'),
    },
  },
  async (a) => {
    if (a.delete) return reply(await runCli(['analytics', 'segments', '--delete', a.delete]));
    const scope = a.property ? ['--property', a.property] : [];
    if (a.save) return reply(await runCli(['analytics', 'segments', '--save', a.save, ...Object.entries(a.filters ?? {}).map(([k, v]) => `${k}=${v}`), ...scope]));
    return reply(await runCli(['analytics', 'segments', ...scope]));
  }
);

server.registerTool(
  'splithub_notes',
  {
    description:
      'Notes: what happened on a day (a launch, an outage, a campaign), shown on experiment timelines and analytics charts (SplitHub Cloud). action list (default): newest first; experiment or property narrows it (project-wide notes come too), kind filters, days / from / to set the range. add: text (day defaults to today in the project time zone; kind note | issue | win; experiment or property ties it to one, none = the whole project). edit: id + text / kind / day. delete: id. Add one when you ship something that may move the numbers.',
    inputSchema: {
      action: z.enum(['list', 'add', 'edit', 'delete']).optional(),
      id: z.string().optional().describe('note id (edit, delete)'),
      text: z.string().max(2000).optional(),
      kind: z.enum(['note', 'issue', 'win']).optional(),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      experiment: z.string().optional().describe('experiment key'),
      property: z.string().optional().describe('analytics property id'),
      days: RANGE.days,
      from: RANGE.from,
      to: RANGE.to,
    },
  },
  async (a) => {
    const action = a.action ?? (a.text && !a.id ? 'add' : 'list');
    const opt = [...(a.kind ? ['--kind', a.kind] : []), ...(a.day ? ['--day', a.day] : [])];
    const scope = a.experiment ? ['--experiment', a.experiment] : a.property ? ['--property', a.property] : [];
    if (action === 'add') return reply(await runCli(['notes', 'add', a.text ?? '', ...opt, ...scope]));
    if (action === 'edit') return reply(await runCli(['notes', 'edit', a.id ?? '', ...(a.text ? [a.text] : []), ...opt]));
    if (action === 'delete') return reply(await runCli(['notes', 'delete', a.id ?? '']));
    return reply(await runCli(['notes', ...(a.kind ? ['--kind', a.kind] : []), ...scope, ...rangeArgs(a)]));
  }
);

server.registerTool(
  'splithub_links',
  {
    description:
      'Short links (SplitHub Cloud): one short URL that redirects to one or more destinations split by weight (split visitors between landing pages without code), clicks counted. action list (default): every link with totalClicks. stats: one link (id or slug): clicks per day (30 days), per destination, country, device, referrer, unique visitors. create: urls (one or more full http(s) URLs), slug (3-32 letters, digits, - _; random when omitted), name, weights (one per URL). edit: name / slug / description. pause, resume, delete: by id or slug. Targeting by country, device or a flow is done in the dashboard.',
    inputSchema: {
      action: z.enum(['list', 'stats', 'create', 'edit', 'pause', 'resume', 'delete']).optional(),
      link: z.string().optional().describe('link id or slug (stats, edit, pause, resume, delete)'),
      urls: z.array(z.string()).min(1).optional().describe('create: destinations'),
      weights: z.array(z.number().min(0)).optional().describe('create: one weight per URL (default equal)'),
      slug: z.string().optional(),
      name: z.string().max(80).optional(),
      description: z.string().max(500).optional(),
    },
  },
  async (a) => {
    const action = a.action ?? 'list';
    if (action === 'list') return reply(await runCli(['links']));
    const opt = [...(a.slug ? ['--slug', a.slug] : []), ...(a.name ? ['--name', a.name] : []), ...(a.description !== undefined ? ['--description', a.description] : [])];
    if (action === 'create') return reply(await runCli(['links', 'create', ...(a.urls ?? []), ...opt, ...(a.weights ? ['--weights', a.weights.join(',')] : [])]));
    if (action === 'stats') return reply(await runCli(['links', a.link ?? '']));
    return reply(await runCli(['links', action, a.link ?? '', ...(action === 'edit' ? opt : [])]));
  }
);

server.registerTool(
  'splithub_alerts',
  {
    description:
      "Alert rules (SplitHub Cloud; they fire on Pro, a rule added on another plan is saved switched off). action list (default): rules with condition, params (params.progress { total, fired, month? } on usage and event_count is read-only), enabled; channels; history (recent alerts). add: condition + params. Experiment conditions (experiment = one key, omit for every running one): srm (broken split), winner (minVisitors?), loser (lift %, minVisitors?), exposures (visitors), conversions (conversions), duration (days), no_events (hours). Account: quota (percent of the monthly allowance), usage (every: alert each time this month's billed events cross another multiple, e.g. 1000). Analytics (property required): traffic_drop / traffic_spike (percent vs the same 24 hours a week before), goal_silent (goal, hours), event_count (event, any event when omitted; count; repeat = every count instead of once). Experiment rules may also pause, finish or dropLoser (winner / loser). enable, disable, delete, test (dry run: what would fire now, nothing sent): rule = id, the start of it, or the name. Where alerts go (email, Slack, Discord, webhook) is set in the dashboard.",
    inputSchema: {
      action: z.enum(['list', 'add', 'enable', 'disable', 'delete', 'test']).optional(),
      rule: z.string().optional().describe('rule id, id prefix or name (enable, disable, delete, test)'),
      condition: z.enum(['srm', 'winner', 'loser', 'exposures', 'conversions', 'duration', 'no_events', 'quota', 'usage', 'traffic_drop', 'traffic_spike', 'goal_silent', 'event_count']).optional(),
      experiment: z.string().optional(),
      property: z.string().optional(),
      goal: z.string().optional(),
      event: z.string().optional(),
      every: z.number().int().min(100).optional(),
      count: z.number().int().min(1).optional(),
      repeat: z.boolean().optional(),
      percent: z.number().min(1).optional(),
      hours: z.number().min(1).optional(),
      days: z.number().int().min(1).optional(),
      visitors: z.number().int().min(1).optional(),
      conversions: z.number().int().min(1).optional(),
      lift: z.number().min(0).max(100).optional(),
      minVisitors: z.number().int().min(0).optional(),
      name: z.string().max(80).optional(),
      cooldownHours: z.number().min(1).optional(),
      enabled: z.boolean().optional().describe('add: false saves it switched off'),
      pause: z.boolean().optional(),
      finish: z.boolean().optional(),
      dropLoser: z.boolean().optional(),
    },
  },
  async (a) => {
    const action = a.action ?? (a.condition ? 'add' : 'list');
    if (action === 'list') return reply(await runCli(['alerts']));
    if (action !== 'add') return reply(await runCli(['alerts', action, a.rule ?? '']));
    const args = ['alerts', 'add', a.condition ?? ''];
    const text: Array<[string, string | undefined]> = [
      ['--experiment', a.experiment],
      ['--property', a.property],
      ['--goal', a.goal],
      ['--event', a.event],
      ['--name', a.name],
    ];
    for (const [flag, v] of text) if (v) args.push(flag, v);
    const nums: Array<[string, number | undefined]> = [
      ['--every', a.every],
      ['--count', a.count],
      ['--percent', a.percent],
      ['--hours', a.hours],
      ['--days', a.days],
      ['--visitors', a.visitors],
      ['--conversions', a.conversions],
      ['--lift', a.lift],
      ['--min-visitors', a.minVisitors],
      ['--cooldown', a.cooldownHours],
    ];
    for (const [flag, v] of nums) if (v !== undefined) args.push(flag, String(v));
    if (a.repeat) args.push('--repeat');
    if (a.enabled === false) args.push('--disabled');
    if (a.pause) args.push('--pause');
    if (a.finish) args.push('--finish');
    if (a.dropLoser) args.push('--drop-loser');
    return reply(await runCli(args));
  }
);

server.registerTool(
  'splithub_analytics_connect',
  {
    description:
      'Set up analytics in this app: use a property (id), create one (name, or nothing when the project has none), then name it on the one <SplitHubProvider> / <SplitHubNextProvider> in the code (property="sh-…"). Answers property, created, wired { status: added | already | other | none | many, file, line }, snippets { provider, script (sh.js tag with data-property), track, identify } and next. status none or many: add the provider snippet yourself (or the sh.js tag on a site without React). other: the provider names another property; ask before calling again with force. Pageviews are sent for you; events are track(name, props). In an app, script is empty and snippets.screen shows useScreen for screens the navigation tracker does not see. In cloud mode a new property is created in the cloud at once (live: applied), so no push: deploy.',
    inputSchema: {
      property: z.string().optional().describe('property id to use (added to the config when new)'),
      name: z.string().max(80).optional().describe('create a new property with this name'),
      force: z.boolean().optional().describe('replace another property already named on the provider'),
    },
  },
  async (a) => reply(await runCli(['analytics', 'connect', ...(a.property ? [a.property] : []), ...(a.name ? ['--name', a.name] : []), ...(a.force ? ['--force'] : [])]))
);

server.registerTool(
  'splithub_analytics_events',
  {
    description: `The latest raw pageviews and custom events of an analytics property (cloud: the raw tail, 7 days free / 30 Pro; self-hosted: the user's database). Use to check that tracking works after wiring track() or sh.js.`,
    inputSchema: { property: z.string(), limit: z.number().int().min(1).max(200).optional() },
  },
  async ({ property, limit }) => reply(await runCli(['analytics', 'events', property, ...(limit ? ['--limit', String(limit)] : [])]))
);

for (const [name, old] of [['splithub_property_create', false], ['splithub_create_property', true]] as const)
  server.registerTool(
    name,
    {
      description: old ? oldName('splithub_property_create') : 'Add an analytics property to splithub.config.ts, checked by reloading the file. Its id is generated (sh-x1h78w) unless given; it comes back as property. Events go only to a property named explicitly: wire <SplitHubProvider config={config} property="<id>"> (pageviews on load and every route change, and every track() call) or data-property="<id>" on the sh.js script tag. Every goal of the project counts as a conversion unless goals narrows them. In cloud mode it is created in the cloud at once (live: applied), so no push is needed: tell the user to deploy. If live names a missing API key, log in and call again (or push). In an app (React Native, Expo) screens are page events: the screen tracker or useScreen(name) sends them.',
      inputSchema: {
        id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional().describe('omit to get a generated id'),
        name: z.string().max(80).optional(),
        goals: z.array(z.string()).optional(),
        description: z.string().optional(),
        status: z.enum(['running', 'paused']).optional(),
        kind: z.enum(['site', 'app']).optional().describe('app: a mobile or desktop app (screens, versions, retention); default: app in an app project, else site'),
      },
    },
    async (a) => reply(await runCli(['analytics', 'create', ...(a.kind ? ['--kind', a.kind] : []), ...(a.id ? [a.id] : []), ...(a.name ? ['--name', a.name] : []), ...(a.goals?.length ? ['--goals', a.goals.join(',')] : []), ...(a.description ? ['--description', a.description] : []), ...(a.status ? ['--status', a.status] : [])]))
  );

const PROPERTY_STATUS_CMD = { running: 'resume', paused: 'pause', archived: 'archive', restored: 'restore', removed: 'remove' } as const;
for (const [name, old] of [['splithub_property_status', false], ['splithub_set_property_status', true]] as const)
  server.registerTool(
    name,
    {
      description: old
        ? oldName('splithub_property_status')
        : 'Pause or resume an analytics property (paused: its pageviews and events are dropped and not billed). Updates splithub.config.ts; in cloud mode it applies live within a minute. archived (SplitHub Cloud) stops collecting and hides it like the dashboard Archive, numbers kept; restored brings it back paused. removed takes it out of the config (a dashboard-made property is deleted in the cloud with its numbers).',
      inputSchema: { property: z.string(), status: z.enum(['running', 'paused', 'archived', 'restored', 'removed']) },
    },
    async ({ property, status }) => reply(await runCli(['analytics', PROPERTY_STATUS_CMD[status], property]))
  );

server.registerTool(
  'splithub_domains',
  {
    description: `Allowed domains, per experiment and per analytics property (SplitHub Cloud). Without arguments: every allowed domain with where it applies, which experiments / properties accept any origin, and the origins seen sending events. With kind + id + hosts: replace that experiment's or property's list (subdomains included; an empty list accepts any origin again). Events from an origin outside the list are dropped (403 when nothing in the batch is allowed).`,
    inputSchema: {
      kind: z.enum(['experiment', 'property', 'test']).optional().describe('experiment or property (test is an old name for experiment)'),
      id: z.string().optional(),
      hosts: z.array(z.string()).optional().describe('e.g. ["example.com"]; [] clears the list'),
    },
  },
  async ({ kind, id, hosts }) => {
    if (!kind || !id || !hosts) return reply(await runCli(['domains']));
    return reply(await runCli(hosts.length ? ['domains', 'set', kind, id, ...hosts] : ['domains', 'clear', kind, id]));
  }
);

server.registerTool(
  'splithub_refs',
  {
    description: 'Files and lines that use an experiment id or its goal. Use after wiring code (is it referenced?) and after splithub_ship (count should be 0 for the experiment).',
    inputSchema: { experiment: z.string() },
    outputSchema: refsOutput,
  },
  async ({ experiment }) => reply(await runCli(['refs', experiment]), { structured: true })
);

server.registerTool(
  'splithub_ship',
  {
    description: 'Keep one variant and take the experiment out: archives it in the cloud (numbers stay readable), removes it from splithub.config.ts and rewrites the code (<Experiment> → the kept <Variant>, useValue → the kept literal, useVariant branches folded, unused imports dropped). Ask the user which variant to keep first (recommend verdict.winner; never a variant listed in verdict.guardrailBreached). Call with dryRun: true, show the diff, then without. Fix leftovers[] by hand, then follow next[] (push, doctor, tests).',
    inputSchema: { experiment: z.string(), keep: z.string().describe('variant key to keep'), dryRun: z.boolean().optional().describe('only return the diff') },
    outputSchema: shipOutput,
  },
  async ({ experiment, keep, dryRun }) => reply(await runCli(['ship', experiment, '--keep', keep, ...(dryRun ? ['--dry-run'] : [])]), { structured: true })
);

server.registerTool(
  'splithub_remove',
  {
    description: 'Remove an experiment from splithub.config.ts (and archive it in the cloud when connected) without touching the code. Prefer splithub_ship, which also cleans the code. Returns refs still in the code.',
    inputSchema: { experiment: z.string() },
  },
  async ({ experiment }) => reply(await runCli(['remove', experiment]))
);

server.registerTool(
  'splithub_review',
  { description: 'AI reviews of an experiment stored in SplitHub Cloud (Pro): written at the start, when the verdict changes while it runs, when it finishes, or on demand in the dashboard. Newest first. Quote them as an opinion; the verdict stays the source of truth.', inputSchema: { experiment: z.string().optional().describe('experiment id; omit for every experiment of the project') } },
  async ({ experiment }) => reply(await runCli(experiment ? ['review', experiment] : ['review']))
);

server.registerTool(
  'splithub_push',
  {
    description: 'Upload splithub.config.ts to SplitHub Cloud (cloud mode). Also returns kept: experiments the cloud has from an earlier push that this file lacks, left as they are. prune removes those: only when the user asked for it. Returns experiments created in the dashboard that were written into the file. dryRun: only check the config and show what would change. A key that already belonged to another experiment fails with KEY_CONFLICT: ask the user, then push with replace (new experiment, old numbers cleared) or same (same experiment, numbers stay).',
    inputSchema: {
      dryRun: z.boolean().optional(),
      replace: z.array(z.string()).optional().describe('keys that are new experiments: the old numbers under them are cleared'),
      same: z.array(z.string()).optional().describe('keys that are the same experiment as before: the numbers stay'),
      prune: z.boolean().optional().describe('also remove experiments the cloud has that the file lacks (ask the user first)'),
    },
  },
  async ({ dryRun, replace, same, prune }) => {
    if (dryRun) return reply(await runCli(['push', '--dry-run', ...(prune ? ['--prune'] : [])]));
    const args = ['push'];
    if (replace?.length) args.push('--replace', replace.join(','));
    if (same?.length) args.push('--same', same.join(','));
    if (prune) args.push('--prune');
    return reply(await runCli(args));
  }
);
server.registerTool('splithub_pull', { description: 'Fetch the cloud config and write dashboard-created experiments into splithub.config.ts.' }, async () => reply(await runCli(['pull'])));
server.registerTool('splithub_doctor', { description: 'Check the installation: config, provider, middleware, routes, code references, endpoint; in a React Native / Expo app also the package, its storage module and redirect experiments; in a native iOS / Android project the SDK in the build files. Run after wiring code; ok: false lists what to fix.' }, async () => reply(await runCli(['doctor'])));
server.registerTool('splithub_whoami', { description: 'Which cloud project this folder is connected to, and its public key.' }, async () => reply(await runCli(['whoami'])));
server.registerTool('splithub_projects', { description: 'Every folder on this machine connected to a SplitHub Cloud project, the current one marked (current).' }, async () => reply(await runCli(['projects'])));

server.registerTool('splithub_login', { description: 'Connect this folder to SplitHub Cloud. Returns a sign-in link and a code: show them to the user, who approves in the browser (and can create a project there). The CLI then stores a project API key for this folder. Call splithub_whoami afterwards.' }, async () => {
  const r = await startLogin();
  if ('error' in r) return { content: [{ type: 'text' as const, text: JSON.stringify(r) }], isError: r.error !== 'already logged in' };
  return { content: [{ type: 'text' as const, text: `Open this link to connect: ${r.verifyUrl}\nCode: ${r.userCode} (expires in ${Math.round(r.expiresIn / 60)} min)\nWaiting for the approval in the background; call splithub_whoami to check.` }] };
});

server.registerTool(
  'splithub_init',
  { description: 'Set up SplitHub in this project: config file, framework files, agent skills; React Native / Expo apps also get @splithub/react-native and their entry (App.tsx, app/_layout.tsx) wrapped in <SplitHubProvider> with screen tracking (app.entry.status added | already | manual: wire nextStep by hand); native iOS / Android get install lines and a quick start (app.install, app.quickStart) and no config file; in cloud mode see splithub_login to connect. Use once per project. githubAction: also write a GitHub workflow (checks on PRs, results comment on a schedule).', inputSchema: { mode: z.enum(['cloud', 'self']).default('cloud'), key: z.string().optional().describe('public key pk_… when known'), githubAction: z.boolean().optional() } },
  async ({ mode, key, githubAction }) => {
    const args = ['init', '--mode', mode, '--yes', '--no-install', '--no-login'];
    if (key) args.push('--key', key);
    if (githubAction) args.push('--github-action');
    return reply(await runCli(args, { timeoutMs: 120_000 }));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
