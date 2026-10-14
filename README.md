# SplitHub SDK

[![npm](https://img.shields.io/npm/v/splithub?label=splithub)](https://www.npmjs.com/package/splithub) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A/B testing for web apps, built for teams that ship with coding agents.

Declare experiments in `splithub.config.ts`, render variants with React, and read a plain verdict from the CLI, the MCP server or the [dashboard](https://app.splithub.io). Events go to SplitHub Cloud, which reads the verdict, or to your own database, where you get the raw numbers per variant.

```bash
npx splithub init
```

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

Two complete apps live in [`examples/`](examples).

## Develop

```bash
pnpm install
pnpm build
pnpm test
```

Node 22.13 or newer, pnpm 10.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
