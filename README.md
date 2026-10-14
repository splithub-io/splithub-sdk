# SplitHub SDK

A/B testing for web apps, built for teams that ship with coding agents.

Declare experiments in `splithub.config.ts`, render variants with React, and read a plain verdict from the CLI, the MCP server or the [dashboard](https://app.splithub.io). Events go to SplitHub Cloud, which reads the verdict, or to your own database, where you get the raw numbers per variant.

```bash
npx splithub init
```

## Packages

| Package | What it does |
|---|---|
| [`splithub`](packages/cli) | The CLI. Create a test, start it, read a plain verdict. |
| [`@splithub/mcp`](packages/mcp) | The CLI as MCP tools for Claude Code, Cursor and Codex. |
| [`@splithub/core`](packages/core) | The config, who sees which variant, and the event queue. No dependencies. |
| [`@splithub/react`](packages/react) | `<Experiment>`, `useVariant`, `useValue`. No flicker, nothing fetched on render. |
| [`@splithub/next`](packages/next) | Middleware, server components and redirect tests for Next.js. |
| [`@splithub/browser`](packages/browser) | One script tag for sites without a build step. |
| [`@splithub/node`](packages/node) | One handler for events and raw results on your own server. |
| [`@splithub/adapter-sqlite`](packages/adapter-sqlite) | SQLite store, on the SQLite built into Node. |
| [`@splithub/adapter-d1`](packages/adapter-d1) | Cloudflare D1 store. |

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
