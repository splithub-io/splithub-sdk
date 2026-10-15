// Agent skills installed by `splithub init` / `splithub skills`. One folder per
// topic under .claude/skills/, so an agent loads only what the task needs:
//   splithub        — the library, the config file, the CLI, where things live
//   ab-testing      — what a good test is, metrics, sample size, when to stop
//   splithub-api    — the HTTP API (keys, endpoints, payloads) for scripts and servers
//   splithub-mcp    — the MCP server: tools, how to register it in Claude Code / Cursor
//   splithub-ship   — keep a variant and take the test out (`splithub ship`)
//   splithub-loop   — the whole loop for an agent, tool by tool
// Same text goes to .cursor/rules and the AGENTS.md section points here.

export interface Skill {
  dir: string;
  body: string;
}

export const SKILL_SPLITHUB = `---
name: splithub
description: Add, change, run or read A/B experiments in an app that uses SplitHub (@splithub/react, splithub.config.ts, the splithub CLI, SplitHub Cloud). Use when the user asks to A/B test a component, headline, image, price, CTA or page, asks which variant is winning, or wants to start, pause or finish a test.
---

# SplitHub for coding agents

Three pieces: \`splithub.config.ts\` (the experiments; source of truth when it exists),
\`@splithub/react\` (renders variants), the \`splithub\` CLI (creates, pushes, reads results).
Events go to the app's own database (self mode) or to SplitHub Cloud (cloud mode).

## Where things live

- Config: \`splithub.config.ts\` in the project root. Experiments and goals. Ships to the browser: never put secrets in it.
- Credentials: \`npx splithub login\` (or \`init --mode cloud\`) prints a link; the human approves it in the browser; the CLI
  stores a project API key for this folder. Never ask the user to paste keys. CI uses \`SPLITHUB_API_KEY\`.
- The public key (\`pk_\`) ends up in \`storage.key\` of the config from any of: \`login\` (saved credentials), the first
  \`push\`, \`init --key\`, or \`SPLITHUB_API_KEY\` in the environment (init asks the cloud). Missing key = events go nowhere.
- Cloud: \`npx splithub push\` uploads the config; \`npx splithub pull\` writes dashboard-created experiments into the file.
- Results: \`npx splithub status --json\`, \`npx splithub results <id> --json\`. Sizing: \`npx splithub plan --baseline 0.05 --mde 0.1\`.
- Code that uses a test: \`npx splithub refs <id> --json\`. Keep a variant and remove the test: \`npx splithub ship <id> --keep <v>\`.
- \`--json\` prints one line; errors are \`{ error, code, hint }\` with exit code 1. The \`splithub-loop\` skill has the whole flow.
- Everything interactive: \`npx splithub\` (menu). Everything scriptable: subcommands + \`--json\`.

## Pick the kind

| kind | use it when | create | read in code |
|---|---|---|---|
| \`value\` | only data changes: text, number, image URL, price, JSON. The default choice: no new components. | \`--variants control,bold --value control="Old text" --value bold="New text"\` | \`const text = useValue<string>('<id>')\`; server components: \`getValue\` from \`@splithub/next\`; no SDK: \`sh.value('<id>')\` |
| \`component\` | structure changes: a layout, a section, a flow, a different component per variant | \`--variants control,bold\` (the CLI scaffolds \`splithub/<id>/<Variant>.tsx\` stubs) | \`<Experiment id="<id>"><Variant name="control">…</Variant><Variant name="bold">…</Variant></Experiment>\`, or \`useVariant('<id>')\` in a switch |
| \`redirect\` | a whole page changes: another URL per variant | \`--match / --to control=/ --to v2=/home-v2\` | nothing: \`@splithub/next\` middleware or the drop-in script \`<script src="https://go.splithub.io/sh.js" data-key="pk_…">\` sends visitors there |
| \`mvt\` | several things change at once (headline × button × image) and the user wants to know which of them matters; every combination is tested and each factor is read on its own | \`--factor headline=old:"Old text",new:"New text" --factor button=blue:#2563eb,green:#16a34a\` (no \`--variants\`; first level = control; at most 4 factors × 4 levels, 16 combinations) | \`const { headline, button } = useValue<{ headline: string; button: string }>('<id>')\` |

mvt needs more visitors than an A/B test: every combination must reach the minimum on its own (the results show the
combinations and, below them, each factor summed over its combinations). With little traffic, test one thing with \`value\`.

## Create an experiment

1. \`npx splithub create --kind <value|component|redirect|mvt> --id <key> … --goal <goal> --yes --json\` (see the table).
   The key is the test's id for good: never reuse one from an earlier test. \`--name "Signup button"\` adds a human
   name (dashboard, CLI) that can change any time. \`push\` fails with \`KEY_CONFLICT\` when a key already belongs to
   another test: ask the user, then rename the key, or push with \`--replace <key>\` (new test, old numbers cleared)
   or \`--same <key>\` (same test). \`KEY_DELETED\`: a deleted test used the key; pick a new one.
2. Goal: pick an existing key or add one to \`goals\`:
   \`{ type: 'event' }\` + \`track('<goal>')\` where the conversion happens; \`{ type: 'pageview', path: '/thanks' }\`;
   \`{ type: 'click', selector: '#buy' }\` (tracked automatically by the SDK and the script).
3. Wire it in code. \`create\` writes \`status: 'running'\`: the test goes live for every visitor, first page view
   included, as soon as this code is deployed. Use \`--status draft\` only when the user asks to hold it.
4. Cloud mode: \`npx splithub push\` after any config change.
5. Hand-off, always: end your reply by saying the test is **running in the config** and goes live when the user deploys
   this code; nothing is recorded before that, and local development never sends events to the cloud. Tell them how to
   check it locally (\`?sh_force=<id>:<variant>\`) and that Pause in the dashboard or \`npx splithub pause <id>\` holds it.
   In cloud mode a status set in the dashboard wins over the file for every visitor, first page included.
   For a draft (only if asked): say visitors do not see it and nothing is recorded until \`npx splithub start <id>\`.

A draft is invisible to visitors. To check one before starting: \`runDraftsInDev: true\` at the top level of the config
serves drafts like running tests in development only (\`NODE_ENV=development\`: \`next dev\`, \`vite\`);
\`?sh_force=<id>:<variant>\` shows one variant on any page, draft or not, without recording an exposure;
\`?sh_debug=1\` (or \`npx splithub dev\`) logs every decision and opens a panel to switch variants.
In development the SDK explains drafts, paused tests and held-back events in one line each. Vite apps: add \`splithub()\`
from \`@splithub/core/vite\` to the plugins in vite.config so these lines and a summary of every experiment appear in the
terminal that runs \`vite\`; Next.js server code prints them in its terminal anyway.

Keys: lowercase a-z 0-9 - _, max 64 chars. First variant = control. Weights are relative (50/50, 1/1, 90/10).
Targeting (country, device, UTM, cookie, time) is a \`flow\` graph on the experiment, edited in the dashboard; \`pull\` brings it into the file.

## Read results

\`verdict.status\` ∈ no_data | insufficient_sample | srm_detected | winner_found | no_significant_difference.
Report \`verdict.message\` verbatim and the numbers behind it (visitors per variant, lift, the always-valid
\`comparisons[].sequential.pValue\` and \`sequential.ci\`; the plain \`pValue\` is fixed-horizon, for display only) and relay
\`verdict.notes[]\`. Verdicts are sequential and depend on sample size, not days: safe to check any time. \`verdict.sample.quality\` is
small (below 100 visitors per variant or 50 conversions), ok, or good (every variant has its share of \`goodSample\`, default 5000
visitors; \`create --good-sample\`); say it next to the verdict. \`verdict.sample.stars\` (0..5) scores data quality from
\`verdict.sample.checks[]\`: report the stars and the unmet labels; they never override the verdict. \`daysToVerdict\` says when to look again.
Never declare a winner from raw rates. \`srm_detected\` means the split is broken: fix the setup before anything else.

## Finish, and what to do when a test is finished

\`npx splithub finish <id>\` stops the test (live within a minute in cloud mode). A finished test keeps its numbers for as long
as it stays in the config; the code still contains every variant until someone removes it.

Whenever you see a test with \`status: finished\` (in \`status\`, \`results\`, the MCP tools, or right after you finished it):
1. Read \`npx splithub results <id> --json\` and tell the user the verdict in one line with its numbers.
2. Ask two questions, do not assume: **which variant to keep** (recommend \`verdict.winner\`; with no significant
   difference, the control or the simpler one) and **whether to remove the test from the code now**.
3. On yes, follow the \`splithub-ship\` skill: \`npx splithub ship <id> --keep <variant> --dry-run\`, show the diff, then run it
   without \`--dry-run\`; fix the \`leftovers\`, \`push\` in cloud mode, run \`doctor\` and the project's checks.
4. On no, leave everything: a finished test costs nothing and the user may come back to it.

A \`paused\` test is not over: say so and ask whether to resume (\`start\`) or finish it.

## Do not

- Nest an \`<Experiment>\` inside a \`<Variant>\` of the same id; call hooks conditionally.
- Change \`seed\`, weights or variants of a running experiment (reshuffles visitors). Create a new experiment instead.
- Edit in the dashboard what the config file owns: file experiments are read-only there (pause/finish still work).
- Run more than 2-3 experiments on one page of a low-traffic site.
- Put secrets, API keys or database credentials in the config or in the browser. \`pk_\` is public, \`sk_\` is not.
`;

export const SKILL_AB_TESTING = `---
name: ab-testing
description: How to design, run and read an A/B test correctly: hypothesis, control, primary metric, sample size, significance, SRM, peeking, when to stop. Use before creating an experiment or when interpreting results, with any tool.
---

# A/B testing, the parts that matter

An A/B test splits visitors at random into variants and compares one metric. It answers one question:
"does this change move this metric?" Everything below exists to keep that answer honest.

## Before creating a test

1. **One hypothesis, one primary metric.** "A shorter signup form raises signup completion." The metric is a goal
   (event, page visit or click) that happens after the exposure. Pick it before looking at data.
2. **Control first.** The first variant is what exists today. Change one thing per variant; several unrelated changes
   in one variant cannot be attributed.
3. **Traffic reality.** Rough rule: to detect a relative lift L on a baseline rate p you need about
   \`16 · p(1-p) / (p·L)²\` visitors per variant (95% confidence, 80% power).
   Examples: baseline 5%, lift 20% → ~7,600 per variant; baseline 2%, lift 10% → ~78,000 per variant.
   If the site cannot reach that in 2-4 weeks, test a bigger change or a higher-traffic page.
4. **Few tests per page.** Interactions between simultaneous tests on the same page muddy both.

## While it runs

- **Do not peek and stop early.** Checking daily and stopping at the first "significant" moment inflates false
  positives several times. Decide the sample or the duration up front; run whole weeks (weekday/weekend cycles).
- **SRM (sample ratio mismatch).** If the split is 50/50 and you see 60/40, the assignment or the tracking is broken
  (bots, caching, redirect loops, a variant that errors). Fix first; results from an SRM run are meaningless.
- **Keep variants frozen.** Changing copy, weights or targeting mid-run reshuffles who saw what. Start a new test.
- **Watch the guardrails.** A variant that wins the primary metric but breaks revenue, errors or latency is not a win.

## Reading results

- Significance (p < 0.05 after correction for several variants) says the difference is unlikely to be noise;
  the confidence interval says how big it plausibly is. A "winner" with a CI that touches 0 is a weak win.
- "No significant difference" with a sample smaller than needed means **keep running**, not "no effect".
  With enough sample it means the change does not matter: ship whichever is cheaper or cleaner.
- Relative lift is on the baseline rate: 5% → 6% is +20% relative, +1 point absolute. Report both.
- Attribution: conversions count only after the visitor's first exposure, per unique visitor.
- Segments (country, device) are for hypotheses, not verdicts: slicing after the fact finds noise.

## When to stop

- Winner found with the planned sample → ship it, finish the test, remove the losing code.
- Planned sample reached, no difference → ship the simpler variant, finish.
- SRM or broken tracking → stop, fix, restart as a new test.
- The business moved on → finish; do not leave tests running forever (they cost events and split traffic).

## Vocabulary

exposure = a visitor saw a variant · conversion = the goal happened after exposure · lift = relative change in rate ·
p-value = chance of seeing this difference by luck · CI = range the true difference likely lies in ·
SRM = the split differs from the configured weights · guardrail = a metric that must not get worse.
`;

export const SKILL_SPLITHUB_API = `---
name: splithub-api
description: Use the SplitHub Cloud HTTP API directly: public key event ingest, API-key endpoints for config, status, results and overrides, hosted experiments. Use when writing a server, a script, a non-JS client, or when the CLI is not available.
---

# SplitHub Cloud API

Base URL: \`https://go.splithub.io\`. JSON in, JSON out (no envelope under \`/v1/*\`). Two credentials:

- **Public key \`pk_…\`**: identifies the project to browsers and SDKs. Safe to ship. Can only send events and read
  the public overrides JSON.
- **API key \`sk_…\`**: project-scoped secret for servers, CI and the CLI (\`npx splithub login\` mints one through a
  browser approval; or Settings → API keys in the dashboard). Never in client code.

## Send events (public key)

\`\`\`http
POST /v1/events
Authorization: Bearer pk_live_…
Content-Type: application/json

{ "project": "my-app", "sdk": "custom/1.0", "events": [
  { "id": "e_01h…", "type": "exposure", "exp": "hero-cta", "var": "bold", "vid": "v_abc", "sid": "s_1", "ts": 1760000000000, "url": "/" },
  { "id": "g_01h…", "type": "goal", "goal": "signup", "vid": "v_abc", "sid": "s_1", "ts": 1760000010000, "props": { "revenue": 49 } }
] }
\`\`\`

- \`id\`: unique per event (8-64 chars, [a-z0-9_-]); duplicates are ignored. \`vid\`: stable visitor id (cookie \`sh_vid\`).
- Reply \`202 { ok, received, inserted, dropped }\`. A project with nothing running or no config yet answers
  \`202 { ok, inserted: 0, idle: 'no_running' | 'no_config' }\`: nothing stored, not an error. \`429\` with \`code\` ∈
  quota_exceeded | deleted: back off for \`Retry-After\` seconds; nothing was stored. \`403 origin_not_allowed\` when the project restricts domains.
- Exposures for experiments that are not running are dropped and not billed. Goals are never billed.

## Live config for clients (public key)

\`GET /v1/overrides/<pk>.json\` → \`{ version, experiments: { <id>: { status?, traffic?, weights?, values? } }, added: [ …hosted experiments… ], goals: [...], ctx: { country, region, city } }\`.
Poll it at most once a minute; the SDK caches it in localStorage. \`ctx\` is the visitor's geo for targeting.

## Project endpoints (API key)

\`\`\`http
GET  /v1/status                      every experiment: status, visitors, days, verdict headline
GET  /v1/results/<experiment>        full verdict: sample, comparisons (lift, p-value, CI, P(beat)), srm, winner
GET  /v1/config                      the config stored in the cloud (file + dashboard experiments)
PUT  /v1/config        { config }    push a normalized config (what defineConfig returns); answers cloudOnly experiments to adopt
GET  /v1/overrides                   live overrides
PUT  /v1/overrides/<experiment> { status | traffic | weights | values }   pause / resume / reweight without a deploy
DELETE /v1/overrides/<experiment>
\`\`\`

\`Authorization: Bearer sk_live_…\` on each. Status values: draft | running | paused | finished.

## Dashboard-scope endpoints (session, same shapes the dashboard uses)

Under \`/v1/projects/<projectId>/…\` with a user session: \`experiments\` (hosted experiments CRUD incl. \`flow\` targeting),
\`goals\`, \`timeline\`, \`breakdown\`, \`realtime\`, \`events\`, \`export\`, \`notes\`, \`domains\`, \`links\`, \`alerts\`, \`billing\`, \`ai\`.
Scripts should prefer the API-key endpoints above; the session ones exist for the UI.

## Drop-in script (no SDK)

\`<script src="https://go.splithub.io/sh.js" data-key="pk_live_…"></script>\` in \`<head>\`: redirect experiments, page-visit and
click goals from the cloud config, \`window.splithub.track('goal')\` for custom events,
\`<meta name="splithub-experiment" content="<id>">\` on a tested page for an instant decision.

## Errors

\`400\` validation (message in \`error\`), \`401\` bad key, \`403\` forbidden, \`404\` unknown experiment/project, \`409\` state
(e.g. \`config_not_pushed\`, \`file_owned\`), \`429\` gate or rate limit. Bodies: \`{ error, code? }\`.
`;

export const SKILL_SPLITHUB_MCP = `---
name: splithub-mcp
description: Use or set up the SplitHub MCP server (@splithub/mcp) so an agent can create experiments, read verdicts, start/pause/finish tests and push config through tools instead of shelling out. Use when the user asks to connect SplitHub to Claude Code, Cursor, Codex or another MCP client.
---

# SplitHub MCP server

\`@splithub/mcp\` is a stdio MCP server that wraps the \`splithub\` CLI for the current project folder.
Same credentials and config file as the CLI; nothing extra to configure.

## Register it

Claude Code (project scope, committed in \`.mcp.json\`):

\`\`\`json
{ "mcpServers": { "splithub": { "command": "npx", "args": ["-y", "@splithub/mcp"] } } }
\`\`\`

or \`claude mcp add splithub -- npx -y @splithub/mcp\`. Cursor: the same object in \`.cursor/mcp.json\`.
Codex / other clients: command \`npx\`, args \`-y @splithub/mcp\`. \`npx splithub skills --mcp\` writes both files.
Env: \`SPLITHUB_PROJECT_DIR\` (defaults to the MCP client's working directory), \`SPLITHUB_API\` (staging or self-hosted cloud), \`SPLITHUB_API_KEY\` (CI).

## Tools

| tool | does | notes |
|---|---|---|
| \`splithub_status\` | all experiments with verdict headline | start here |
| \`splithub_results\` | full verdict for one experiment | report \`verdict.message\` verbatim; \`daysToVerdict\` = when to check again |
| \`splithub_review\` | stored AI reviews (Pro): at start, on verdict changes, on finish, on demand | quote them as the analyst's opinion, the verdict stays the source of truth |
| \`splithub_plan\` | visitors per variant for a baseline and a lift; days at an experiment's traffic | before creating |
| \`splithub_create_experiment\` | adds an experiment to splithub.config.ts | kind value / component / redirect / mvt, id, variants (or factors for mvt), goal, values/to, weights, traffic, maxVisitors, start/end; running by default |
| \`splithub_refs\` | files and lines that use an experiment and its goal | check the wiring, find leftovers |
| \`splithub_ship\` | finish, remove from the config, rewrite the code to the kept variant | \`dryRun: true\` first; returns \`diff\` and \`leftovers\` |
| \`splithub_remove\` | removes an experiment from the config (finished in the cloud) | when the code is already clean |
| \`splithub_projects\` | every folder on this machine connected to a cloud project | |
| \`splithub_set_status\` | start / pause / finish | applies live in cloud mode; after \`finished\`, ask which variant to keep and whether to clean the code (splithub-ship skill) |
| \`splithub_push\` / \`splithub_pull\` | sync the config with the cloud | pull adopts dashboard-created experiments |
| \`splithub_doctor\` | checks the installation | run after wiring code |
| \`splithub_login\` | returns a sign-in link; the human approves it in the browser | show the link, then call \`splithub_whoami\` |
| \`splithub_whoami\` | connected project and keys | |

## Working rules

- Create (running by default) → wire in code → \`doctor\` → \`push\` (cloud mode) → tell the user it goes live when they
  deploy this code and that \`set_status paused\` or Pause in the dashboard holds it.
- Results: never call a winner from raw rates; quote the verdict. \`srm_detected\` = fix the setup first.
- Running experiments are frozen: no weight / variant / seed edits; create a new one.
- Errors carry a \`code\`. \`NOT_LOGGED_IN\`: call \`splithub_login\`, show the link to the user, wait for them, then retry.
- The whole loop (plan → create → implement → doctor → push → results → finish → ship) is in the \`splithub-loop\` skill.
- A \`finished\` experiment in \`splithub_status\` or \`splithub_results\` means the test is over but its code is still there: report
  the verdict, ask which variant to keep and whether to remove the test from the code, then follow the \`splithub-ship\` skill.
`;

export { SKILL_SELF_HOSTED } from './skills-self-hosted';
import { SKILL_SELF_HOSTED } from './skills-self-hosted';
export { SKILL_LOOP, SKILL_SHIP } from './skills-ship';
import { SKILL_LOOP, SKILL_SHIP } from './skills-ship';

export const SKILLS: Skill[] = [
  { dir: 'splithub', body: SKILL_SPLITHUB },
  { dir: 'ab-testing', body: SKILL_AB_TESTING },
  { dir: 'splithub-api', body: SKILL_SPLITHUB_API },
  { dir: 'splithub-mcp', body: SKILL_SPLITHUB_MCP },
  { dir: 'splithub-self-hosted', body: SKILL_SELF_HOSTED },
  { dir: 'splithub-ship', body: SKILL_SHIP },
  { dir: 'splithub-loop', body: SKILL_LOOP },
];

export const MCP_SERVER_ENTRY = { command: 'npx', args: ['-y', '@splithub/mcp'] };
