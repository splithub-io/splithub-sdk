# splithub

A/B testing for your app in one command. Run it without arguments and it walks you through; add flags and `--json` when a coding agent runs it.

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
```

## Where results come from

| Config `storage.mode` | `status` / `results` read from | Auth |
|---|---|---|
| `self` | your app's endpoint on the local dev server (`localhost:3000` for Next.js, `5173` for Vite) or `--url` / `SPLITHUB_URL` | `--token` / `SPLITHUB_ADMIN_TOKEN` when the handler has `adminToken` |
| `cloud` | `https://go.splithub.io/v1` (or `--api` / `SPLITHUB_API`) | project API key: `--token sk_...`, `SPLITHUB_API_KEY`, or the key saved by `splithub login` |

Self-hosted reads are raw numbers per variant: visitors, conversions, rate, revenue. Verdicts,
data-quality stars, recommendations and sample-size planning run in SplitHub Cloud.

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
