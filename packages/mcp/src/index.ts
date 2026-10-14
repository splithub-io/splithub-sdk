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
  INSUFFICIENT_SCOPE: 'This API key can only read. Ask the user for a key with the write scope (dashboard, Settings, API keys) or call splithub_login again.',
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
  .describe('friendly line for humans; quote verdict.message for facts. advice move_on = suggest finishing and starting the next test');
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
  analysis: analysisShape.optional(),
  next: z.string().optional(),
}).passthrough();
const resultsOutput = z.object({
  experiment: z.string(),
  kind: z.string(),
  status: z.string(),
  goal: z.string().nullable(),
  verdict: verdictShape.optional().describe('SplitHub Cloud only'),
  daysToVerdict: z.number().nullable().optional().describe('days until a verdict at the current traffic; schedule the next check then'),
  voice: voiceShape.nullable().optional(),
  display: displayShape.optional(),
  variants: z.array(z.object({ variant: z.string(), visitors: z.number(), conversions: z.number(), rate: z.number() }).passthrough()).optional().describe('self-hosted: raw counts per variant, control first'),
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

const LOOP = 'The loop: splithub_plan → splithub_create_experiment → wire the code → splithub_doctor → splithub_push (cloud) → splithub_results (re-check after daysToVerdict days) → splithub_set_status finished → splithub_ship.';

server.registerTool(
  'splithub_status',
  {
    description: `Every experiment of this project with status, visitors, days, the verdict headline, sample (verdict.sample.quality: small | ok | good), stars (verdict.sample.stars, data quality 0..5) and daysToVerdict (days until a verdict at the current traffic: schedule the next check then, do not poll). verdict guardrail_breached = do not ship that variant. The __holdout row is the project holdout (long-term impact). Start here. A finished experiment is over but its variants are still in the code: report its verdict, ask the user which variant to keep and whether to remove the test, then call splithub_ship. display { label, lines, next } is ready to show; voice.line is the friendly line for humans; voice.advice move_on means suggest finishing the test and starting the next one. If analysis.available is false the project is self-hosted: report the raw numbers as they are, say verdicts come with SplitHub Cloud (analysis.url), and never call a winner from raw rates. ${LOOP}`,
    outputSchema: statusOutput,
  },
  async () => reply(await runCli(['status']), { structured: true })
);

server.registerTool(
  'splithub_results',
  {
    description: 'Results of one experiment. SplitHub Cloud gives the full verdict: sample per variant, lift, P(beat), SRM, winner; mvt adds factors[]. verdict.status guardrail_breached means do not ship: a variant made a guardrail metric worse (verdict.guardrailBreached[]); say what broke. verdict.metrics[] has secondary metrics and guardrails. The experiment __holdout is the project holdout (long-term impact of all tests). Verdicts are sequential (always-valid, safe to check any time) and depend on sample size, not days. verdict.sample.quality is small (below the minimums), ok, or good (every variant has its share of verdict.sample.goodSample, default 5000 visitors): say it next to the verdict; it never changes the decision. verdict.sample.stars (0..5) is a data-quality score from verdict.sample.checks[] (minimum, split, goodSample, power, week; each { met, label }): report the stars and the unmet labels, never as a reason to override the verdict. Quote verdict.message verbatim, use comparisons[].sequential.pValue / sequential.ci (the plain pValue is fixed-horizon, display only: p = 0.01 there can be not significant) and relay verdict.notes[]. daysToVerdict says when to check again. Facts are in verdict.message; voice.line is the friendly line for humans (voice.advice move_on = suggest finishing the test and starting the next one); display { label, lines, next } is ready to show. If analysis.available is false the project is self-hosted: report the raw numbers as they are, say verdicts come with SplitHub Cloud (analysis.url), and never call a winner from raw rates. If finished, ask which variant to keep, then splithub_ship.',
    inputSchema: { experiment: z.string().describe('experiment id (key)') },
    outputSchema: resultsOutput,
  },
  async ({ experiment }) => reply(await runCli(['results', experiment]), { structured: true })
);

server.registerTool(
  'splithub_plan',
  {
    description: 'Before creating a test: visitors per variant (and in all) to detect a relative lift `mde` on a `baseline` conversion rate, sized by SplitHub Cloud for its sequential verdict (no account needed; fails with UNREACHABLE offline). With an experiment id, also the days left at its current traffic when its numbers are readable. If it takes months, suggest a bigger change or a busier page.',
    inputSchema: {
      baseline: z.number().gt(0).lt(1).describe('conversion rate today, e.g. 0.05'),
      mde: z.number().gt(0).describe('smallest relative lift worth finding, e.g. 0.1 for +10%'),
      variants: z.number().int().min(2).optional().describe('number of variants including the control (default 2)'),
      experiment: z.string().optional().describe('experiment id: adds days at its traffic'),
    },
  },
  async ({ baseline, mde, variants, experiment }) => reply(await runCli(['plan', ...(experiment ? [experiment] : []), '--baseline', String(baseline), '--mde', String(mde), ...(variants ? ['--variants', String(variants)] : [])]))
);

server.registerTool(
  'splithub_create_experiment',
  {
    description: `Add an experiment to splithub.config.ts (checked by reloading the file). It is written as running: it goes live when the code is deployed (and pushed in cloud mode). Tell the user that, and that splithub_set_status paused holds it. Pass status draft only when the user asks to hold it. kind: value (text/number/URL read with useValue), component (<Experiment>/<Variant> markup), redirect (match path + per-variant destination), mvt (factors instead of variants, every combination tested, read with useValue as { factor: value }). First variant / first level is the control. goodSample: total visitors at which the sample counts as good (default 5000). minDays: opt-in fewest days before a verdict (default 0 = none). Then wire the returned snippet, call splithub_doctor and splithub_refs. ${LOOP}`,
    inputSchema: {
      id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).describe('experiment key, lowercase'),
      kind: z.enum(['value', 'component', 'redirect', 'mvt']),
      variants: z.array(z.string()).min(2).optional().describe('variant keys, first = control (not for mvt)'),
      factors: z.record(z.record(z.string())).optional().describe('mvt only: factor → level → value, e.g. { headline: { old: "Old", new: "New" }, button: { blue: "#2563eb", green: "#16a34a" } }; first level = control; at most 4 factors × 4 levels'),
      weights: z.array(z.number().min(0)).optional().describe('relative weights, same order as variants (not for mvt)'),
      goal: z.string().optional().describe('goal key from the config'),
      values: z.record(z.string()).optional().describe('value experiments: variant → value'),
      match: z.string().optional().describe('redirect experiments: path to test, e.g. /'),
      to: z.record(z.string()).optional().describe('redirect experiments: variant → destination path'),
      status: z.enum(['draft', 'running']).optional(),
      description: z.string().optional(),
      traffic: z.number().gt(0).max(100).optional().describe('percent of visitors in the test (default 100)'),
      maxVisitors: z.number().int().positive().optional().describe('stop counting after this many visitors'),
      minDays: z.number().int().min(0).max(30).optional().describe('opt-in fewest days before a verdict (default 0 = none); verdicts otherwise depend on sample size'),
      goodSample: z.number().int().min(100).max(10_000_000).optional().describe('total visitors at which verdict.sample.quality turns good (default 5000); informational, never changes the verdict'),
      start: z.string().optional().describe('ISO date the test starts'),
      end: z.string().optional().describe('ISO date the test ends'),
      secondary: z.array(z.string()).optional().describe('goals to watch next to the primary goal'),
      guardrails: z.array(z.union([z.string(), z.object({ goal: z.string(), worse: z.enum(['lower', 'higher']) })])).optional().describe('goals that must not get worse; { goal, worse: "higher" } when a rise is bad (refunds, errors). A breach makes the verdict guardrail_breached: do not ship'),
      layer: z.object({ key: z.string(), start: z.number().int().min(0).max(99), end: z.number().int().min(1).max(100) }).optional().describe('mutual exclusion: tests in one layer never share a visitor; bucket ranges [start, end) must not overlap'),
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

server.registerTool(
  'splithub_set_status',
  {
    description: 'Start, pause or finish an experiment. The config file is updated (and checked); in cloud mode it applies live within a minute. After finishing, the variants are still in the code: ask the user which variant to keep, then call splithub_ship.',
    inputSchema: { experiment: z.string(), status: z.enum(['running', 'paused', 'finished']) },
  },
  async ({ experiment, status }) => {
    const cmd = status === 'running' ? 'start' : status === 'paused' ? 'pause' : 'finish';
    return reply(await runCli([cmd, experiment]));
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
    description: 'Keep one variant and take the test out: archives it in the cloud (numbers stay readable), removes it from splithub.config.ts and rewrites the code (<Experiment> → the kept <Variant>, useValue → the kept literal, useVariant branches folded, unused imports dropped). Ask the user which variant to keep first (recommend verdict.winner; never a variant listed in verdict.guardrailBreached). Call with dryRun: true, show the diff, then without. Fix leftovers[] by hand, then follow next[] (push, doctor, tests).',
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

server.registerTool('splithub_push', { description: 'Upload splithub.config.ts to SplitHub Cloud (cloud mode). Returns experiments created in the dashboard that were written into the file. dryRun: only check the config and show what would change.', inputSchema: { dryRun: z.boolean().optional() } }, async ({ dryRun }) => reply(await runCli(dryRun ? ['push', '--dry-run'] : ['push'])));
server.registerTool('splithub_pull', { description: 'Fetch the cloud config and write dashboard-created experiments into splithub.config.ts.' }, async () => reply(await runCli(['pull'])));
server.registerTool('splithub_doctor', { description: 'Check the installation: config, provider, middleware, routes, code references, endpoint. Run after wiring code; ok: false lists what to fix.' }, async () => reply(await runCli(['doctor'])));
server.registerTool('splithub_whoami', { description: 'Which cloud project this folder is connected to, and its public key.' }, async () => reply(await runCli(['whoami'])));
server.registerTool('splithub_projects', { description: 'Every folder on this machine connected to a SplitHub Cloud project, the current one marked (current).' }, async () => reply(await runCli(['projects'])));

server.registerTool('splithub_login', { description: 'Connect this folder to SplitHub Cloud. Returns a sign-in link and a code: show them to the user, who approves in the browser (and can create a project there). The CLI then stores a project API key for this folder. Call splithub_whoami afterwards.' }, async () => {
  const r = await startLogin();
  if ('error' in r) return { content: [{ type: 'text' as const, text: JSON.stringify(r) }], isError: r.error !== 'already logged in' };
  return { content: [{ type: 'text' as const, text: `Open this link to connect: ${r.verifyUrl}\nCode: ${r.userCode} (expires in ${Math.round(r.expiresIn / 60)} min)\nWaiting for the approval in the background; call splithub_whoami to check.` }] };
});

server.registerTool(
  'splithub_init',
  { description: 'Set up SplitHub in this project: config file, framework files, agent skills; in cloud mode see splithub_login to connect. Use once per project. githubAction: also write a GitHub workflow (checks on PRs, results comment on a schedule).', inputSchema: { mode: z.enum(['cloud', 'self']).default('cloud'), key: z.string().optional().describe('public key pk_… when known'), githubAction: z.boolean().optional() } },
  async ({ mode, key, githubAction }) => {
    const args = ['init', '--mode', mode, '--yes', '--no-install', '--no-login'];
    if (key) args.push('--key', key);
    if (githubAction) args.push('--github-action');
    return reply(await runCli(args, { timeoutMs: 120_000 }));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
