<p align="center">
  <a href="https://splithub.io"><img src=".github/splithub.jpg" alt="SplitHub" width="640"></a>
</p>

<p align="center">
  <b>Experiments and web analytics for apps you build with a coding agent.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/splithub"><img src="https://img.shields.io/npm/v/splithub?label=splithub" alt="npm"></a>
  <a href="https://github.com/splithub-io/splithub-sdk/actions/workflows/test.yml"><img src="https://github.com/splithub-io/splithub-sdk/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://splithub.io">Website</a> ·
  <a href="https://splithub.io/docs">Docs</a> ·
  <a href="https://app.splithub.io">Dashboard</a> ·
  <a href="https://app.splithub.io/demo">Live demo</a>
</p>

One install gives you both: A/B experiments with a plain verdict, and analytics for every page and event, with funnels, paths and retention. Declare experiments in `splithub.config.ts`, render variants with React, call `track()` for anything that matters, and read the numbers from the CLI, the MCP server or the dashboard. Your coding agent can do all of it for you.

```bash
npx splithub init
```

## Why SplitHub

- **Config in your code.** Experiments live in `splithub.config.ts`, reviewed in pull requests like everything else.
- **No flicker, no network on render.** Who sees which variant is a local hash, decided before the first paint.
- **One `track()` for everything.** Any event you send feeds the analytics reports and converts every experiment that measures it. No second tracking setup.
- **A verdict, not a chart to decode.** SplitHub Cloud says when a variant wins, and peeking early never fools it.
- **Made for agents.** The CLI answers in JSON, and the MCP server gives Claude Code, Cursor and Codex the same tools you have.
- **Your data, if you want it.** Send events to your own database instead (SQLite, D1, Postgres, MySQL) and read the raw numbers.

## Experiments in three steps

**1. Describe the experiment.**

```ts
// splithub.config.ts
import { defineConfig } from '@splithub/core';

export default defineConfig({
  project: 'my-app',
  storage: { mode: 'cloud', key: 'pk_...' }, // or { mode: 'self', endpoint: '/api/splithub' }
  goals: { signup: { type: 'event' } },
  experiments: {
    'hero-title': {
      kind: 'value',
      status: 'running',
      variants: {
        control: { weight: 50, value: 'Ship faster' },
        direct: { weight: 50, value: 'Know which version wins' },
      },
      goal: 'signup',
    },
  },
});
```

**2. Show the variant and count the goal.**

```tsx
import { SplitHubProvider, useValue, useTrack } from '@splithub/react';
import config from './splithub.config';

function Hero() {
  const title = useValue<string>('hero-title');
  const track = useTrack();
  return (
    <>
      <h1>{title}</h1>
      <button onClick={() => track('signup')}>Sign up</button>
    </>
  );
}

export const App = () => (
  <SplitHubProvider config={config} property="sh-x1h78w">
    <Hero />
  </SplitHubProvider>
);
```

**3. Read the result.**

```bash
npx splithub status              # every experiment with its verdict
npx splithub results hero-title  # lift, chance to beat control, confidence interval
```

### What experiments can do

- **Four kinds:** `value` (data per variant), `component` (JSX per variant), `redirect` (a page per variant) and `mvt` (every combination of a few factors, with the effect of each one).
- **Targeting:** show an experiment only to some visitors, by country, device, browser, UTM tags or cookies.
- **Layers and a holdout:** run experiments side by side without overlap, and keep a share of visitors out of all of them to measure the long-term effect.
- **Guardrails and secondary metrics:** a variant that hurts a metric you protect is never called the winner.
- **Sample size up front:** `npx splithub plan` says how many visitors an experiment needs, no account required.
- **Slices and breakdowns:** results by country, device, source, landing page or day; every event per variant.
- **Ship the winner:** `npx splithub ship <id> --keep <variant>` rewrites your code to the kept variant and removes the experiment.
- **In your pull requests:** `npx splithub ci init` posts the results as a PR comment.

## Analytics

Name an analytics property on the provider (or on the script tag) and every page and `track()` call is counted. `npx splithub analytics connect` sets it up.

```tsx
<SplitHubProvider config={config} property="sh-x1h78w">
```

```ts
const track = useTrack();
track('Video Played', { id: 3 });       // any event name, with props
track('checkout', { revenue: 49 });     // revenue counts too

const identify = useIdentify();
identify('user_42', { plan: 'pro' });   // tie visits to your user and their traits
```

What you get, in the dashboard, the CLI and the MCP server:

- **Traffic:** visitors, visits, pageviews, bounce rate and time on site, against any earlier period.
- **Sources:** channels, referrers and UTM tags; pages, landing and exit pages, with page groups like `/blog/*`.
- **Audience:** country, region, city, device, browser, OS, language, user traits, and the variant each visitor saw.
- **Events and goals:** every event with its props; mark any event or page as a goal to count conversions and revenue.
- **Funnels:** visitors through up to 8 steps in one visit or within 7 or 30 days, split by any dimension. Save them for the whole team.
- **Paths and retention:** where visitors go next, and who comes back week after week.
- **Realtime, segments and export:** who is on the site now, saved filters for any report, CSV of any table or the raw events.

```bash
npx splithub analytics sh-x1h78w --by source --compare
npx splithub analytics funnel sh-x1h78w --steps "page:/,event:Signup,goal:paid"
npx splithub analytics funnels sh-x1h78w --save Signup --steps "page:/,goal:signup"
```

No build step? One script tag counts pages and events and runs redirect experiments:

```html
<script src="https://go.splithub.io/sh.js" data-key="pk_..." data-property="sh-x1h78w"></script>
```

## Also in SplitHub Cloud

- **Notes:** mark launches, outages and campaigns; they show on every chart.
- **Short links:** links with click counts, and split links that send traffic to several pages.
- **Alerts:** a winner, a broken split, a traffic drop or spike, a goal gone silent, by email, Slack, Discord or webhook.
- **Allowed domains, API keys with scopes, and team roles** per area or per experiment.
- **AI reviews** of an experiment at start, on a verdict change and at the end (Pro).

## With your coding agent

```bash
claude mcp add splithub -- npx -y @splithub/mcp
```

Or let the CLI write `.mcp.json` for Claude Code and `.cursor/mcp.json` for Cursor:

```bash
npx splithub skills --mcp
```

Then ask in plain words: "test a shorter headline on the pricing page", "is the new checkout winning?" or "where do visitors drop off between pricing and signup?".

## Packages

| Package | npm | What it does |
|---|---|---|
| [`splithub`](packages/cli) | [![npm](https://img.shields.io/npm/v/splithub?label=)](https://www.npmjs.com/package/splithub) | The CLI: experiments, verdicts, analytics reports, funnels, notes, links and alerts. |
| [`@splithub/mcp`](packages/mcp) | [![npm](https://img.shields.io/npm/v/@splithub/mcp?label=)](https://www.npmjs.com/package/@splithub/mcp) | The CLI as MCP tools for Claude Code, Cursor and Codex. |
| [`@splithub/core`](packages/core) | [![npm](https://img.shields.io/npm/v/@splithub/core?label=)](https://www.npmjs.com/package/@splithub/core) | The config, who sees which variant, and the event queue. No dependencies. |
| [`@splithub/react`](packages/react) | [![npm](https://img.shields.io/npm/v/@splithub/react?label=)](https://www.npmjs.com/package/@splithub/react) | `<Experiment>`, `useValue`, `useTrack`, `useIdentify`. No flicker, nothing fetched on render. |
| [`@splithub/next`](packages/next) | [![npm](https://img.shields.io/npm/v/@splithub/next?label=)](https://www.npmjs.com/package/@splithub/next) | Middleware, server components and redirect experiments for Next.js. |
| [`@splithub/browser`](packages/browser) | [![npm](https://img.shields.io/npm/v/@splithub/browser?label=)](https://www.npmjs.com/package/@splithub/browser) | One script tag: analytics and redirect experiments for sites without a build step. |
| [`@splithub/node`](packages/node) | [![npm](https://img.shields.io/npm/v/@splithub/node?label=)](https://www.npmjs.com/package/@splithub/node) | One handler for events and raw results on your own server. |
| [`@splithub/adapter-sqlite`](packages/adapter-sqlite) | [![npm](https://img.shields.io/npm/v/@splithub/adapter-sqlite?label=)](https://www.npmjs.com/package/@splithub/adapter-sqlite) | SQLite store, on the SQLite built into Node. |
| [`@splithub/adapter-d1`](packages/adapter-d1) | [![npm](https://img.shields.io/npm/v/@splithub/adapter-d1?label=)](https://www.npmjs.com/package/@splithub/adapter-d1) | Cloudflare D1 store. |

Two complete apps live in [`examples/`](examples): Vite + React and Next.js.

## Cloud or your own database

| | SplitHub Cloud | Self-hosted |
|---|---|---|
| Where events go | SplitHub Cloud | Your database: SQLite, D1, Postgres, MySQL |
| Experiments | Verdict, lift, data quality, sample size, slices | Visitors, conversions, rate and revenue per variant |
| Analytics | Every report above | Raw counts of pages and events |
| Setup | `npx splithub login` | `npx splithub init --mode self` |

## Develop

```bash
pnpm install
pnpm build
pnpm test
```

Node 22.13 or newer, pnpm 10.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Found a security problem? See [SECURITY.md](SECURITY.md).

## License

MIT
