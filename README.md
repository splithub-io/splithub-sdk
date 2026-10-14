<p align="center">
  <a href="https://splithub.io"><img src=".github/splithub.jpg" alt="SplitHub" width="640"></a>
</p>

<p align="center">
  <b>A/B testing for web apps, built for teams that ship with coding agents.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/splithub"><img src="https://img.shields.io/npm/v/splithub?label=splithub" alt="npm"></a>
  <a href="https://github.com/splithub-io/splithub-sdk/actions/workflows/test.yml"><img src="https://github.com/splithub-io/splithub-sdk/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://splithub.io">Website</a> ·
  <a href="https://splithub.io/docs">Docs</a> ·
  <a href="https://app.splithub.io">Dashboard</a>
</p>

Declare experiments in `splithub.config.ts`, render variants with React, and read a plain verdict from the CLI, the MCP server or the dashboard. Your coding agent can do all of it for you.

```bash
npx splithub init
```

## Why SplitHub

- **Config in your code.** Experiments live in `splithub.config.ts`, reviewed in pull requests like everything else.
- **No flicker, no network on render.** Who sees which variant is a local hash, decided before the first paint.
- **Made for agents.** The CLI answers in JSON, and the MCP server gives Claude Code, Cursor and Codex the same tools you have.
- **A verdict, not a dashboard to decode.** SplitHub Cloud says when a variant wins, and peeking early never fools it.
- **Your data, if you want it.** Send events to your own database instead, and read the raw numbers per variant.

## Three steps

**1. Describe the test.**

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
  <SplitHubProvider config={config}>
    <Hero />
  </SplitHubProvider>
);
```

**3. Read the result.**

```bash
npx splithub status              # every test with its verdict
npx splithub results hero-title  # lift, chance to beat control, confidence interval
```

Using Next.js? `@splithub/next` adds middleware and server components. No build step? One script tag from `@splithub/browser` runs redirect tests.

## With your coding agent

```bash
claude mcp add splithub -- npx -y @splithub/mcp
```

Or let the CLI write `.mcp.json` for Claude Code and `.cursor/mcp.json` for Cursor:

```bash
npx splithub skills --mcp
```

Then ask in plain words: "test a shorter headline on the pricing page" or "is the new checkout winning?".

## Packages

| Package | npm | What it does |
|---|---|---|
| [`splithub`](packages/cli) | [![npm](https://img.shields.io/npm/v/splithub?label=)](https://www.npmjs.com/package/splithub) | The CLI. Create a test, start it, read a plain verdict. |
| [`@splithub/mcp`](packages/mcp) | [![npm](https://img.shields.io/npm/v/@splithub/mcp?label=)](https://www.npmjs.com/package/@splithub/mcp) | The CLI as MCP tools for Claude Code, Cursor and Codex. |
| [`@splithub/core`](packages/core) | [![npm](https://img.shields.io/npm/v/@splithub/core?label=)](https://www.npmjs.com/package/@splithub/core) | The config, who sees which variant, and the event queue. No dependencies. |
| [`@splithub/react`](packages/react) | [![npm](https://img.shields.io/npm/v/@splithub/react?label=)](https://www.npmjs.com/package/@splithub/react) | `<Experiment>`, `useVariant`, `useValue`. No flicker, nothing fetched on render. |
| [`@splithub/next`](packages/next) | [![npm](https://img.shields.io/npm/v/@splithub/next?label=)](https://www.npmjs.com/package/@splithub/next) | Middleware, server components and redirect tests for Next.js. |
| [`@splithub/browser`](packages/browser) | [![npm](https://img.shields.io/npm/v/@splithub/browser?label=)](https://www.npmjs.com/package/@splithub/browser) | One script tag for sites without a build step. |
| [`@splithub/node`](packages/node) | [![npm](https://img.shields.io/npm/v/@splithub/node?label=)](https://www.npmjs.com/package/@splithub/node) | One handler for events and raw results on your own server. |
| [`@splithub/adapter-sqlite`](packages/adapter-sqlite) | [![npm](https://img.shields.io/npm/v/@splithub/adapter-sqlite?label=)](https://www.npmjs.com/package/@splithub/adapter-sqlite) | SQLite store, on the SQLite built into Node. |
| [`@splithub/adapter-d1`](packages/adapter-d1) | [![npm](https://img.shields.io/npm/v/@splithub/adapter-d1?label=)](https://www.npmjs.com/package/@splithub/adapter-d1) | Cloudflare D1 store. |

Two complete apps live in [`examples/`](examples): Vite + React and Next.js.

## Cloud or your own database

| | SplitHub Cloud | Self-hosted |
|---|---|---|
| Where events go | SplitHub Cloud | Your database: SQLite, D1, Postgres, MySQL |
| What you read | Verdict, lift, data quality, sample size | Visitors, conversions, rate and revenue per variant |
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
