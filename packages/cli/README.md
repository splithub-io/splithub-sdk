# splithub

Experiments and web analytics for your app, from one command. Run it without arguments and it walks you through; add flags and `--json` when a coding agent runs it.

```bash
npx splithub                             # menu: set up, connect, create, results, start/pause, push — step by step
npx splithub init                        # config, framework files (Next.js middleware + ingest route), agent skills
npx splithub init --mode self --db postgres   # events in your Postgres: writes splithub/store.ts (also mysql | custom | sqlite)
npx splithub create                      # wizard; or flags:
npx splithub create --kind value --id hero-title --variants control,direct \
  --value "control=Old headline" --value "direct=New headline" --goal signup --yes --json
npx splithub start hero-title            # also: pause, finish
npx splithub status                      # all experiments, verdict headline
npx splithub results hero-title          # cloud: verdict, lift, P(beat), p-value, CI; self-hosted: raw numbers
npx splithub plan --baseline 0.05 --mde 0.1   # visitors a test needs (asks SplitHub Cloud, no account needed)
npx splithub report                      # Markdown for a PR comment (the `ci init` workflow posts it)
npx splithub doctor                      # checks config, provider, middleware, route, code references, endpoint
npx splithub ship hero-title --keep direct    # keep the winner in your code, remove the experiment
npx splithub ci init                     # GitHub workflow: checks on PRs, results as a PR comment
```

Results go deeper in SplitHub Cloud: `--by country` (lift per segment), `--timeline`, `--events` (every event
per variant), `--filter device=mobile --from 2026-10-01` (a slice), `--export` for CSV.

## Analytics

One `track()` feeds both: the analytics reports and every experiment that measures that event.

```bash
npx splithub analytics connect           # pick or create a property and name it on your provider (or get the sh.js tag)
npx splithub analytics                   # every property, last 30 days
npx splithub analytics sh-x1h78w --by source --compare      # also page, channel, country, device, event, goal, variant…
npx splithub analytics funnel sh-x1h78w --steps "page:/,event:Signup,goal:paid" --within 7d
npx splithub analytics funnels sh-x1h78w --save Signup --steps "page:/,goal:signup"   # saved for the team
npx splithub analytics funnel sh-x1h78w --funnel Signup     # run a saved funnel
npx splithub analytics paths sh-x1h78w --page /pricing      # where visitors go next (--prev: where they came from)
npx splithub analytics retention sh-x1h78w                  # who comes back, per weekly cohort
npx splithub analytics realtime sh-x1h78w                   # who is on the site now
npx splithub analytics segments --save "Paid" channel="Paid Search"   # saved filters; any report takes --segment Paid
npx splithub analytics export sh-x1h78w --by page > pages.csv
```

Every report takes `--days 7` or `--from --to`, `--filter country=DE` and `--json`.

## Notes, links, alerts

```bash
npx splithub notes add "Launched the new pricing page" --kind win   # shows on every chart
npx splithub links create https://example.com/spring --slug spring  # short link with click counts
npx splithub alerts add winner --experiment hero-title              # also srm, traffic_drop, goal_silent, usage…
npx splithub domains set property sh-x1h78w example.com             # only these sites may send events
```

## Where results come from

| Config `storage.mode` | `status` / `results` read from | Auth |
|---|---|---|
| `self` | your app's endpoint on the local dev server (`localhost:3000` for Next.js, `5173` for Vite) or `--url` / `SPLITHUB_URL` | `--token` / `SPLITHUB_ADMIN_TOKEN` when the handler has `adminToken` |
| `cloud` | `https://go.splithub.io/v1` (or `--api` / `SPLITHUB_API`) | project API key: `--token sk_...`, `SPLITHUB_API_KEY`, or the key saved by `splithub login` |

Self-hosted reads are raw numbers: visitors, conversions, rate and revenue per variant, and counts of
pages and events per property. Verdicts, data-quality stars, recommendations, sample-size planning and the
analytics reports (funnels, paths, retention, segments) run in SplitHub Cloud.

`init` and `skills` fetch the latest agent skills from SplitHub Cloud and fall back to the copies
bundled with the CLI when it can't be reached.

## SplitHub Cloud

```bash
npx splithub login                       # prints a code + URL; approve in the dashboard, pick the project
npx splithub push                        # uploads splithub.config.ts; first push returns the public key
                                         # and writes it into storage.key
npx splithub status
npx splithub pull                        # show what the cloud has
npx splithub whoami                      # which project this directory talks to
npx splithub logout
```

`login` never asks you to paste a secret: the dashboard mints a project API key
for this terminal and the CLI stores it per directory in
`~/.config/splithub/credentials.json` (`%APPDATA%\splithub` on Windows).
CI and agents without a browser can still use `SPLITHUB_API_KEY=sk_...`
(dashboard → project → Settings → API keys); env and `--token` win over the
saved key.

The public key (`pk_...`) is safe in the browser: it only allows sending
events. The API key (`sk_...`) reads results and pushes config; keep it out of git.

## Updates

When you run a command in a terminal, the CLI asks npm once whether a newer `splithub` is out and offers to update after the command finishes. It updates the way you installed it: your project's `splithub` and `@splithub/*` packages with your package manager, or the global install with `npm i -g`; with `npx`, run `npx splithub@latest`.

```bash
npx splithub update          # check now and update (--yes skips the question)
npx splithub update --json   # { current, latest, outdated, command }, installs nothing
```

The check never runs with `--json`, in CI, under the MCP server or outside a terminal. Turn it off with `SPLITHUB_NO_UPDATE_CHECK=1`. `splithub doctor` also lists your installed versions against npm.

Planned: `watch` (live verdicts).
