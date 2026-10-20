// Agent skills installed by `splithub init` / `splithub skills`. One folder per
// topic under .claude/skills/, so an agent loads only what the task needs:
//   splithub        — the library, the config file, the CLI, where things live
//   ab-testing      — what a good test is, metrics, sample size, when to stop
//   splithub-api    — the HTTP API (keys, endpoints, payloads) for scripts and servers
//   splithub-mcp    — the MCP server: tools, how to register it in Claude Code / Cursor
//   splithub-ship   — keep a variant and take the test out (`splithub ship`)
//   splithub-loop   — the whole loop for an agent, tool by tool
//   splithub-analytics — analytics properties: pageviews, events, reports, allowed domains
// Same text goes to .cursor/rules and the AGENTS.md section points here.

export interface Skill {
  dir: string;
  body: string;
}

export const SKILL_SPLITHUB = `---
name: splithub
description: Add, change, run or read experiments in an app that uses SplitHub (@splithub/react, splithub.config.ts, the splithub CLI, SplitHub Cloud). Use when the user asks to A/B test a component, headline, image, price, CTA or page, asks which variant is winning, or wants to start, pause or finish an experiment; also for notes on the charts, alert rules (events used, traffic, goals, winners), short links and allowed domains.
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
- Cloud: \`npx splithub push\` uploads the config. Experiments the cloud has from an earlier push that the file lacks are
  kept (\`kept\` in the answer); only \`npx splithub push --prune\` removes them, and only when the user asked for that.
  \`npx splithub pull\` writes dashboard-created experiments into the file.
- Results: \`npx splithub status --json\` (in the cloud it also has \`properties\`: each analytics property's last 7 days), \`npx splithub results <id> --json\`. Sizing: \`npx splithub plan --baseline 0.05 --mde 0.1\`.
- Closer reads (cloud): \`results <id> --from --to --filter country=DE\` (a slice), \`--by <dimension>\`, \`--timeline\`, \`--engagement\`,
  \`--events\`, \`--export --by <dimension>\` or \`--export --events\` (CSV); \`npx splithub events --experiment <id>\` for the raw tail. See "Read results".
- Code that uses an experiment: \`npx splithub refs <id> --json\`. Keep a variant and remove the experiment: \`npx splithub ship <id> --keep <v>\`.
- \`--json\` prints one line; errors are \`{ error, code, hint }\` with exit code 1. \`INSUFFICIENT_SCOPE\` adds \`scope\`
  (e.g. \`notes:write\`): the API key is limited to some areas; ask the user for a key with that scope. The \`splithub-loop\` skill has the whole flow.
- Everything interactive: \`npx splithub\`, one menu: Experiments, Analytics, Short links, Alerts, Notes, Allowed domains,
  push / pull, local testing, doctor, agent skills. Everything scriptable: subcommands + \`--json\` (\`npx splithub --help\`).
- Web analytics (pageviews, events, sources, pages, funnels) live in analytics properties: \`npx splithub analytics connect\`
  sets one up in the app; the \`splithub-analytics\` skill has the rest.

## Pick the kind

| kind | use it when | create | read in code |
|---|---|---|---|
| \`value\` | only data changes: text, number, image URL, price, JSON. The default choice: no new components. | \`--variants control,bold --value control="Old text" --value bold="New text"\` | \`const text = useValue<string>('<id>')\`; server components: \`getValue\` from \`@splithub/next\`; no SDK: \`sh.value('<id>')\` |
| \`component\` | structure changes: a layout, a section, a flow, a different component per variant | \`--variants control,bold\` (the CLI scaffolds \`splithub/<id>/<Variant>.tsx\` stubs) | \`<Experiment id="<id>"><Variant name="control">…</Variant><Variant name="bold">…</Variant></Experiment>\`, or \`useVariant('<id>')\` in a switch |
| \`redirect\` | a whole page changes: another URL per variant | \`--match / --to control=/ --to v2=/home-v2\` | nothing: \`@splithub/next\` middleware or the drop-in script \`<script src="https://go.splithub.io/sh.js" data-key="pk_…">\` sends visitors there |
| \`mvt\` | several things change at once (headline × button × image) and the user wants to know which of them matters; every combination is tested and each factor is read on its own | \`--factor headline=old:"Old text",new:"New text" --factor button=blue:#2563eb,green:#16a34a\` (no \`--variants\`; first level = control; at most 4 factors × 4 levels, 16 combinations) | \`const { headline, button } = useValue<{ headline: string; button: string }>('<id>')\` |

mvt needs more visitors than a two-variant experiment: every combination must reach the minimum on its own (the results show the
combinations and, below them, each factor summed over its combinations). With little traffic, change one thing with \`value\`.

## Create an experiment

1. \`npx splithub create --kind <value|component|redirect|mvt> --id <key> … --goal <event name> --yes --json\` (see the table).
   The key is the experiment's id for good: never reuse one from an earlier experiment. \`--name "Signup button"\` adds a human
   name (dashboard, CLI) that can change any time. \`push\` fails with \`KEY_CONFLICT\` when a key already belongs to
   another experiment: ask the user, then rename the key, or push with \`--replace <key>\` (new experiment, old numbers cleared)
   or \`--same <key>\` (same experiment). \`KEY_DELETED\`: a deleted experiment used the key; pick a new one.
2. Goal: any event the app sends with \`track('<name>', props?)\`, the one call for every event. Nothing to declare
   first: a name not in \`goals\` becomes an event goal keyed by its slug (\`Video Played\` → \`video-played\`) and \`create\`
   says so. A goal is just an event marked as one; page visits and clicks are goals declared in \`goals\`:
   \`{ type: 'pageview', path: '/thanks' }\`, \`{ type: 'click', selector: '#buy' }\` (tracked automatically by the SDK and the script).
   With an analytics property on the provider, the same \`track()\` and pageviews feed both: one install, one row per action.
3. Wire it in code. \`create\` writes \`status: 'running'\`: the experiment goes live for every visitor, first page view
   included, as soon as this code is deployed. Use \`--status draft\` only when the user asks to hold it.
4. Cloud mode: \`npx splithub push\` after any config change.
5. Hand-off, always: end your reply by saying the experiment is **running in the config** and goes live when the user deploys
   this code; nothing is recorded before that, and local development never sends events to the cloud. Tell them how to
   check it locally (\`?sh_force=<id>:<variant>\`) and that Pause in the dashboard or \`npx splithub pause <id>\` holds it.
   In cloud mode a status set in the dashboard wins over the file for every visitor, first page included.
   For a draft (only if asked): say visitors do not see it and nothing is recorded until \`npx splithub start <id>\`.

A draft is invisible to visitors. To check one before starting: \`runDraftsInDev: true\` at the top level of the config
serves drafts like running experiments in development only (\`NODE_ENV=development\`: \`next dev\`, \`vite\`);
\`?sh_force=<id>:<variant>\` shows one variant on any page, draft or not, without recording an exposure;
\`?sh_debug=1\` (or \`npx splithub dev\`) logs every decision and opens a panel to switch variants.
In development the SDK explains drafts, paused experiments and held-back events in one line each. Vite apps: add \`splithub()\`
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

### Slices, breakdowns, timelines (SplitHub Cloud)

- A slice: \`npx splithub results <id> --from 2026-10-01 --to 2026-10-15 --filter country=DE --filter channel="Paid Search" --json\`.
  \`from\` / \`to\` are first-exposure days (project time zone): the visitors who entered the experiment then, with all their
  later conversions. Filters: country, region, city, device, os, browser, language, host, source, channel, utm_source,
  utm_medium, utm_campaign, utm_term, utm_content, landing or page (the page of the first exposure); comma-separated values,
  \`(none)\` matches empty. The answer carries \`scope\` and its verdict is computed on the slice only: say so and quote
  \`scope.note\`. The decision stays with the unfiltered verdict; a slice carries no \`voice\` (no advice).
- One view at a time, same range and filters (\`--json\` adds \`view\`): \`--by country|device|source|channel|page|landing|utm_campaign|…\`
  gives \`segments[]\` with each variant's cells and its lift against the control inside the segment (\`significant\`, \`better\`,
  \`small\` = too few visitors); \`--timeline\` gives visitors and conversions per day and variant (a day = visitors first seen
  that day); \`--engagement\` gives bounce rate, pages per visit and visit length per variant from the analytics property on
  the same visitors (\`property: null\` = none); \`--events\` gives \`rows[]\` for every goal (the experiment's goal, metrics and
  guardrails first, \`measured\`) and event of these visitors, each with \`perVariant\` visitors and rate and \`comparisons[]\` against
  the control (\`property: null\` = goals only: other events need analytics on the same site). \`--export --by <dimension>\` prints
  the breakdown as CSV, \`--export --events\` the events table.
- \`npx splithub events --experiment <id> [--type exposure|goal] [--limit 50] [--before <nextBefore>]\` lists the raw exposures
  and goals (same filters; 7 days, 30 on Pro). Use it to check the wiring.
- Segments and events are for hypotheses: never call a winner from one segment or one event. With several segments, one will look great by chance.
  A self-hosted endpoint answers none of these (\`NOT_CLOUD\`); its results stay raw counts.

## Finish, and what to do when an experiment is finished

\`npx splithub finish <id>\` stops the experiment (live within a minute in cloud mode). A finished experiment keeps its numbers for as long
as it stays in the config; the code still contains every variant until someone removes it.

Whenever you see an experiment with \`status: finished\` (in \`status\`, \`results\`, the MCP tools, or right after you finished it):
1. Read \`npx splithub results <id> --json\` and tell the user the verdict in one line with its numbers.
2. Ask two questions, do not assume: **which variant to keep** (recommend \`verdict.winner\`; with no significant
   difference, the control or the simpler one) and **whether to remove the experiment from the code now**.
3. On yes, follow the \`splithub-ship\` skill: \`npx splithub ship <id> --keep <variant> --dry-run\`, show the diff, then run it
   without \`--dry-run\`; fix the \`leftovers\`, \`push\` in cloud mode, run \`doctor\` and the project's checks.
4. On no, leave everything: a finished experiment costs nothing and the user may come back to it.

A \`paused\` experiment is not over: say so and ask whether to resume (\`start\`) or finish it.

## Around experiments (SplitHub Cloud)

- **Notes**: what happened on a day, marked on experiment timelines and analytics charts. \`npx splithub notes add "Launched the
  new pricing page" [--kind note|issue|win] [--experiment <key> | --property <id>] [--day 2026-10-05]\` (none = the whole
  project); \`notes\` lists them (\`--experiment\`, \`--property\`, \`--kind\`, \`--days\`), \`notes edit <id> "<text>"\`, \`notes delete <id>\`.
  Add one when you ship something that may move the numbers.
- **Alerts** (they fire on Pro; added on another plan they are saved switched off): \`npx splithub alerts\` lists rules, progress
  and recent alerts; \`alerts add <condition>\`: experiments \`srm\`, \`winner\`, \`loser --lift 10\`, \`exposures --visitors N\`,
  \`conversions --conversions N\`, \`duration --days N\`, \`no_events --hours 24\` (\`--experiment <key>\`, else every running one;
  \`--pause\`, \`--finish\`, \`--drop-loser\` act on it); account \`quota --percent 80\`, \`usage --every 1000\` (each time this month's
  events cross another 1,000); analytics \`traffic_drop|traffic_spike --property <id> --percent 50\`, \`goal_silent --property <id>
  --goal <key> --hours 24\`, \`event_count --property <id> [--event <name>] --count 500 [--repeat]\`. \`alerts enable|disable|delete|test <id>\`
  (\`test\` = what would fire now, nothing sent). Channels (email, Slack, Discord, webhook) are set in the dashboard.
- **Short links**: \`npx splithub links create https://example.com/spring [--slug spring] [--name "Spring"]\`; several URLs with
  \`--weights 70,30\` split visitors between pages. \`links\` lists them with clicks, \`links <slug>\` shows one link's clicks,
  \`links pause|resume|delete <slug>\`.
- **Allowed domains**: \`npx splithub domains set experiment <key> example.com\` (subdomains included), \`domains clear experiment <key>\`,
  \`domains\` lists them. No list = any origin.

## Do not

- Nest an \`<Experiment>\` inside a \`<Variant>\` of the same id; call hooks conditionally.
- Change \`seed\`, weights or variants of a running experiment (reshuffles visitors). Create a new experiment instead.
- Edit in the dashboard what the config file owns: file experiments are read-only there (pause/finish still work).
- Run more than 2-3 experiments on one page of a low-traffic site.
- Put secrets, API keys or database credentials in the config or in the browser. \`pk_\` is public, \`sk_\` is not.
`;

export const SKILL_AB_TESTING = `---
name: ab-testing
description: How to design, run and read an experiment correctly: hypothesis, control, primary metric, sample size, significance, SRM, peeking, when to stop. Use before creating an experiment or when interpreting results, with any tool.
---

# A/B testing, the parts that matter

An experiment splits visitors at random into variants and compares one metric. It answers one question:
"does this change move this metric?" Everything below exists to keep that answer honest.

## Before creating an experiment

1. **One hypothesis, one primary metric.** "A shorter signup form raises signup completion." The metric is a goal
   (event, page visit or click) that happens after the exposure. Pick it before looking at data.
2. **Control first.** The first variant is what exists today. Change one thing per variant; several unrelated changes
   in one variant cannot be attributed.
3. **Traffic reality.** Rough rule: to detect a relative lift L on a baseline rate p you need about
   \`16 · p(1-p) / (p·L)²\` visitors per variant (95% confidence, 80% power).
   Examples: baseline 5%, lift 20% → ~7,600 per variant; baseline 2%, lift 10% → ~78,000 per variant.
   If the site cannot reach that in 2-4 weeks, try a bigger change or a higher-traffic page.
4. **Few experiments per page.** Interactions between simultaneous experiments on the same page muddy both.

## While it runs

- **Do not peek and stop early.** Checking daily and stopping at the first "significant" moment inflates false
  positives several times. Decide the sample or the duration up front; run whole weeks (weekday/weekend cycles).
- **SRM (sample ratio mismatch).** If the split is 50/50 and you see 60/40, the assignment or the tracking is broken
  (bots, caching, redirect loops, a variant that errors). Fix first; results from an SRM run are meaningless.
- **Keep variants frozen.** Changing copy, weights or targeting mid-run reshuffles who saw what. Start a new experiment.
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

- Winner found with the planned sample → ship it, finish the experiment, remove the losing code.
- Planned sample reached, no difference → ship the simpler variant, finish.
- SRM or broken tracking → stop, fix, restart as a new experiment.
- The business moved on → finish; do not leave experiments running forever (they cost events and split traffic).

## Vocabulary

exposure = a visitor saw a variant · conversion = the goal happened after exposure · lift = relative change in rate ·
p-value = chance of seeing this difference by luck · CI = range the true difference likely lies in ·
SRM = the split differs from the configured weights · guardrail = a metric that must not get worse.
`;

export const SKILL_SPLITHUB_API = `---
name: splithub-api
description: Use the SplitHub Cloud HTTP API directly: public key event ingest, API-key endpoints for config, status, results, overrides, analytics reports, notes, short links and alert rules. Use when writing a server, a script, a non-JS client, or when the CLI is not available.
---

# SplitHub Cloud API

Base URL: \`https://go.splithub.io\`. JSON in, JSON out (no envelope under \`/v1/*\`). Two credentials:

- **Public key \`pk_…\`**: identifies the project to browsers and SDKs. Safe to ship. Can only send events and read
  the public overrides JSON.
- **API key \`sk_…\`**: project-scoped secret for servers, CI and the CLI (\`npx splithub login\` mints one through a
  browser approval; or Settings → API keys in the dashboard). Never in client code. It can be limited to some areas:
  see API keys and scopes below.

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

- Analytics properties take two more types: \`{ "type": "page", "prop": "site", "url": "/pricing", "title"?, "ref"?, … }\`
  (\`ref\` = document.referrer) and \`{ "type": "event", "prop": "site", "name": "Video Played", "props"?: { … }, … }\`.
  Both are billed like one exposure each; events of a property that is paused or unknown are dropped.
  An \`event\` row also converts the experiments whose goal is that event, and a \`page\` row the page-visit goals its path
  matches (not billed again): send one row per action, not a goal row next to it (one within 1 s is counted once).
  \`{ "type": "identify", "prop": "site", "uid": "user_42", "traits"?: { "plan": "pro" }, … }\` ties the visitor to your user
  (not billed). Requests from bots are dropped.
- \`id\`: unique per event (8-64 chars, [a-z0-9_-]); duplicates are ignored. \`vid\`: stable visitor id (cookie \`sh_vid\`).
- Reply \`202 { ok, received, inserted, dropped }\`. A project with nothing running or no config yet answers
  \`202 { ok, inserted: 0, idle: 'no_running' | 'no_config' }\`: nothing stored, not an error. \`429\` with \`code\` ∈
  quota_exceeded | deleted: back off for \`Retry-After\` seconds; nothing was stored. Allowed domains are set per experiment and per
  property: events from another origin are dropped, and \`403 origin_not_allowed\` comes back when nothing in the batch was allowed.
- Exposures for experiments that are not running are dropped and not billed. Goals are never billed.

## API keys and scopes

A key can do everything (\`*\`, the default) or only some areas, each with read or write (write includes read).
Pick them in Settings → API keys when creating the key.

| Area | Covers |
|---|---|
| \`experiments\` | status, results, report, config push, overrides, archive, reviews |
| \`analytics\` | properties, their reports, segments, the event catalog |
| \`events\` | read: raw events and \`export.csv?raw=1\`; write: send events from your server with this key |
| \`notes\`, \`links\`, \`alerts\`, \`domains\` | those endpoints |

Scope strings: \`<area>:read\` / \`<area>:write\` (e.g. \`notes:write\`, \`analytics:read\`), \`read\` / \`write\` for every area,
\`*\` for everything. Keys made before scopes existed have \`*\`.

Server-side sending: a key with \`events:write\` can post to \`POST /v1/events\` instead of the public key. It is trusted,
so there is no origin check; keep it on the server.

\`\`\`bash
curl -X POST https://go.splithub.io/v1/events \\
  -H "Authorization: Bearer $SPLITHUB_API_KEY" -H "Content-Type: application/json" \\
  -d '{ "sdk": "server/1.0", "events": [
    { "id": "g_order_1042", "type": "goal", "goal": "purchase", "vid": "v_abc", "ts": 1760000010000, "props": { "revenue": 49 } },
    { "id": "e_order_1042", "type": "event", "prop": "site", "name": "Order Paid", "vid": "v_abc", "ts": 1760000010000 }
  ] }'
\`\`\`

\`vid\` is the visitor's \`sh_vid\` cookie, so the goal lands on the variant they saw. A request the key may not make
answers \`403 { code: 'insufficient_scope', scope: 'notes:write', error, hint }\`: \`scope\` names the missing one, and the CLI
shows it (\`--json\` adds \`scope\`). Ask the user for a key with that scope; don't retry with another key.

## Live config for clients (public key)

\`GET /v1/overrides/<pk>.json\` → \`{ version, experiments: { <id>: { status?, traffic?, weights?, values? } }, added: [ …hosted experiments… ], goals: [...], ctx: { country, region, city } }\`.
Poll it at most once a minute; the SDK caches it in localStorage. \`ctx\` is the visitor's geo for targeting.

## Project endpoints (API key)

\`\`\`http
GET  /v1/status                      every experiment: status, visitors, days, verdict headline
GET  /v1/results/<experiment>        full verdict: sample, comparisons (lift, p-value, CI, P(beat)), srm, winner
                                     ?from=&to= (first-exposure days) &country=DE&channel=…: the verdict on that slice, with scope { filtered, range, filters, note }
GET  /v1/experiments/<experiment>/timeline           ?from=&to=&<filters>: exposures[] and conversions[] per day and variant, notes
GET  /v1/experiments/<experiment>/breakdown/<by>     by country|region|city|device|os|browser|language|host|page (= url)|referrer|source|channel|landing|utm_*:
                                                     order[], segments[] { dim, cells, comparisons { lift, pValue, significant, better }, total, small }
GET  /v1/experiments/<experiment>/engagement         { property, variants[] { visitors, sessions, pagesPerVisit, bounceRate, avgVisit } } (&property=)
GET  /v1/experiments/<experiment>/events-summary     { property, variants[], visitors, rows[] { name, goalKey, isGoal, measured, perVariant, comparisons, small } } (&property=)
GET  /v1/experiments/<experiment>/export.breakdown.csv?by=   the breakdown as CSV, lift per segment
GET  /v1/experiments/<experiment>/export.events-summary.csv   the events table as CSV, lift per event
GET  /v1/experiments/<experiment>/events             ?type=exposure|goal&before=&limit=&<filters>: raw events, nextBefore (needs events:read)
GET  /v1/config                      the config stored in the cloud (file + dashboard experiments)
PUT  /v1/config        { config, prune? }    push a normalized config (what defineConfig returns); answers cloudOnly experiments to adopt and kept ones (from an earlier push, missing from this one; prune: true removes them)
GET  /v1/overrides                   live overrides
PUT  /v1/overrides/<experiment> { status | traffic | weights | values }   pause / resume / reweight without a deploy
DELETE /v1/overrides/<experiment>
GET  /v1/properties                  analytics properties: live status, goals, domains, last 30 days
POST /v1/properties    { key, name?, goals?, domains? }   create one (dashboard-owned)
PATCH /v1/properties/<key> { status: running | paused, name?, goals? }
GET  /v1/properties/<key>/summary    ?from=&to= (YYYY-MM-DD) &<dimension>=a,b[&compare=previous|year|custom&cfrom=&cto=]: totals, days, goals, notes
GET  /v1/properties/<key>/breakdown  ?by=source|channel|page|event|goal|country|…&goal=[&compare=…]: rows
GET  /v1/properties/<key>/funnel     ?steps=page:/,event:Signup,goal:paid&within=visit|7d|30d[&by=]: steps with visitors, conversion, dropoff
GET  /v1/properties/<key>/paths      ?page=/pricing&direction=next|prev: rows { value, visits }
GET  /v1/properties/<key>/retention  ?start=visit|event:<n>|goal:<k>&return=visit|event:<n>&period=day|week: cohorts
GET  /v1/properties/<key>/realtime | /events?type=page|event | /props?name=&key= | /export.csv?by=|day (&raw=1)
GET|POST /v1/segments    { name, filters, propertyKey? }   PATCH|DELETE /v1/segments/<id>
GET  /v1/domains                     every allowed domain and where it applies, observed origins
PUT  /v1/domains/<experiment|property>/<key> { hosts: [...] }   replace one list ([] = any origin)
GET  /v1/notes   ?experiment=&property=&kind=&from=&to=[&exact=1]   newest first; experiment / property also return project-wide notes unless exact=1
POST /v1/notes   { text (≤ 2000), day? (default today, project time zone), kind?: note|issue|win, experimentKey? | propertyKey? (none = whole project) }
PATCH|DELETE /v1/notes/<id>   { text?, day?, kind? }
GET  /v1/links                       short links: shortUrl, destinations [{ id, url, weight }], status, totalClicks
POST /v1/links   { name, destinations: [{ url, weight? }], shortCode?, description?, clickLimit? }
PATCH|DELETE /v1/links/<id>   { name?, shortCode?, status: active|paused, destinations?, description? }   GET /v1/links/<id>/stats: byDay (30 days), byDestination, byCountry, byDevice, byReferrer
GET  /v1/alerts                      rules, channels, digest, history, conditions, plan
POST /v1/alerts/rules   { condition, params, actions?: { notify, pause, finish, dropLoser }, name?, experiment?, enabled?, cooldownHours? }
PATCH|DELETE /v1/alerts/rules/<id>   POST /v1/alerts/rules/<id>/test (dry run: what would fire now)
\`\`\`

Alert conditions and params: experiments \`srm\`, \`winner\` { minVisitors? }, \`loser\` { lift, minVisitors? }, \`exposures\` { visitors },
\`conversions\` { conversions }, \`duration\` { days }, \`no_events\` { hours }; account \`quota\` { percent }, \`usage\` { every } (each time this
month's billed events cross another multiple); analytics \`traffic_drop\` / \`traffic_spike\` { property, percent }, \`goal_silent\`
{ property, goal, hours }, \`event_count\` { property, event? (any event when absent), count, repeat? }. \`params.progress\` { total, fired,
month? } is read-only. Enabled rules need Pro: \`402 pro_required\` otherwise (save it with \`enabled: false\`).

\`Authorization: Bearer sk_live_…\` on each. Status values: draft | running | paused | finished.

## Dashboard-scope endpoints (session, same shapes the dashboard uses)

Under \`/v1/projects/<projectId>/…\` with a user session: \`experiments\` (hosted experiments CRUD incl. \`flow\` targeting),
\`goals\`, \`timeline\`, \`breakdown\`, \`realtime\`, \`events\`, \`export\`, \`notes\`, \`domains\`, \`properties\`, \`links\`, \`alerts\`, \`billing\`, \`ai\`.
Scripts should prefer the API-key endpoints above; the session ones exist for the UI.

## Drop-in script (no SDK)

\`<script src="https://go.splithub.io/sh.js" data-key="pk_live_…"></script>\` in \`<head>\`: redirect experiments, page-visit and
click goals from the cloud config, \`window.splithub.track(name, props)\` for every event (goals included), pageviews
for analytics properties (\`data-property="site"\`). An app with the SDK does not need it: one install per property,
or only the first of the two collects pageviews.
\`<meta name="splithub-experiment" content="<id>">\` on a tested page for an instant decision.

## Errors

\`400\` validation (message in \`error\`), \`401\` bad key, \`403\` forbidden (\`insufficient_scope\` names the missing \`scope\`), \`404\` unknown experiment/project, \`409\` state
(e.g. \`config_not_pushed\`, \`file_owned\`), \`429\` gate or rate limit. Bodies: \`{ error, code?, hint? }\`, auth errors included; \`hint\` is the next step.
`;

export const SKILL_SPLITHUB_MCP = `---
name: splithub-mcp
description: Use or set up the SplitHub MCP server (@splithub/mcp) so an agent can create experiments, read verdicts, start/pause/finish experiments and push config through tools instead of shelling out, plus analytics, notes, alerts and short links. Use when the user asks to connect SplitHub to Claude Code, Cursor, Codex or another MCP client.
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
| \`splithub_results\` | full verdict for one experiment; from / to / filters for a slice, by / timeline / engagement / events for one view (cloud) | report \`verdict.message\` verbatim; \`daysToVerdict\` = when to check again; a slice's verdict is not the experiment's |
| \`splithub_experiment_events\` | the latest raw exposures and goals of an experiment (cloud) | check the wiring |
| \`splithub_review\` | stored AI reviews (Pro): at start, on verdict changes, on finish, on demand | quote them as the analyst's opinion, the verdict stays the source of truth |
| \`splithub_plan\` | visitors per variant for a baseline and a lift; days at an experiment's traffic | before creating |
| \`splithub_experiment_create\` | adds an experiment to splithub.config.ts | kind value / component / redirect / mvt, id, variants (or factors for mvt), goal, values/to, weights, traffic, maxVisitors, start/end; running by default |
| \`splithub_refs\` | files and lines that use an experiment and its goal | check the wiring, find leftovers |
| \`splithub_ship\` | finish, remove from the config, rewrite the code to the kept variant | \`dryRun: true\` first; returns \`diff\` and \`leftovers\` |
| \`splithub_remove\` | removes an experiment from the config (archived in the cloud) | when the code is already clean |
| \`splithub_projects\` | every folder on this machine connected to a cloud project | |
| \`splithub_init\` | sets up the config, framework files and skills | once per project |
| \`splithub_experiment_status\` | start / pause / finish | applies live in cloud mode; after \`finished\`, ask which variant to keep and whether to clean the code (splithub-ship skill) |
| \`splithub_push\` / \`splithub_pull\` | sync the config with the cloud | pull adopts dashboard-created experiments |
| \`splithub_doctor\` | checks the installation | run after wiring code |
| \`splithub_login\` | returns a sign-in link; the human approves it in the browser | show the link, then call \`splithub_whoami\` |
| \`splithub_whoami\` | connected project and keys | |
| \`splithub_analytics\` | analytics properties; one property's totals, goals, top pages and sources; \`by\` a dimension | counts, never verdicts |
| \`splithub_analytics_events\` | the latest raw pageviews and events of a property | check tracking after wiring it |
| \`splithub_analytics_funnel\` / \`_paths\` / \`_retention\` / \`_realtime\` | funnels, next pages, cohorts, visitors now (cloud) | counts, never verdicts |
| \`splithub_analytics_connect\` | picks or creates a property and names it on the app's provider | \`wired.status\` none / many: add the snippet yourself |
| \`splithub_segments\` | saved report filters (cloud) | |
| \`splithub_notes\` | what happened on a day, per experiment, property or project: list / add / edit / delete (cloud) | add one when you ship |
| \`splithub_alerts\` | alert rules: list / add / enable / disable / delete / test (cloud, fire on Pro) | conditions in the splithub skill |
| \`splithub_links\` | short links: list / stats / create / edit / pause / resume / delete (cloud) | several URLs split by weight |
| \`splithub_property_create\` | adds an analytics property to splithub.config.ts and to the cloud | no push needed |
| \`splithub_property_status\` | pause / resume, archive / restore (cloud) or remove a property | live in cloud mode |
| \`splithub_domains\` | allowed domains per experiment and property; set or clear one list | empty = any origin |

Old names still answer for one release: \`splithub_create_experiment\`, \`splithub_set_status\`, \`splithub_create_property\`,
\`splithub_set_property_status\`. Use the names above.

## Working rules

- Create (running by default) → wire in code → \`doctor\` → \`push\` (cloud mode) → tell the user it goes live when they
  deploy this code and that \`set_status paused\` or Pause in the dashboard holds it.
- Results: never call a winner from raw rates; quote the verdict. \`srm_detected\` = fix the setup first.
- Running experiments are frozen: no weight / variant / seed edits; create a new one.
- Errors carry a \`code\`. \`NOT_LOGGED_IN\`: call \`splithub_login\`, show the link to the user, wait for them, then retry.
- The whole loop (plan → create → implement → doctor → push → results → finish → ship) is in the \`splithub-loop\` skill.
- A \`finished\` experiment in \`splithub_status\` or \`splithub_results\` means the experiment is over but its code is still there: report
  the verdict, ask which variant to keep and whether to remove the experiment from the code, then follow the \`splithub-ship\` skill.
`;

export { SKILL_SELF_HOSTED } from './skills-self-hosted';
import { SKILL_SELF_HOSTED } from './skills-self-hosted';
export { SKILL_LOOP, SKILL_SHIP } from './skills-ship';
import { SKILL_LOOP, SKILL_SHIP } from './skills-ship';
export { SKILL_ANALYTICS } from './skills-analytics';
import { SKILL_ANALYTICS } from './skills-analytics';

export const SKILLS: Skill[] = [
  { dir: 'splithub', body: SKILL_SPLITHUB },
  { dir: 'ab-testing', body: SKILL_AB_TESTING },
  { dir: 'splithub-api', body: SKILL_SPLITHUB_API },
  { dir: 'splithub-mcp', body: SKILL_SPLITHUB_MCP },
  { dir: 'splithub-self-hosted', body: SKILL_SELF_HOSTED },
  { dir: 'splithub-ship', body: SKILL_SHIP },
  { dir: 'splithub-loop', body: SKILL_LOOP },
  { dir: 'splithub-analytics', body: SKILL_ANALYTICS },
];

export const MCP_SERVER_ENTRY = { command: 'npx', args: ['-y', '@splithub/mcp'] };
