# @splithub/next

SplitHub for Next.js (App Router, 14+). Three entry points:

| Import | Runs | What it gives you |
|---|---|---|
| `@splithub/next` | edge (middleware) | `splithubMiddleware(config)`: visitor cookie, header for RSC, invisible rewrites for `redirect` experiments, edge exposures |
| `@splithub/next/server` | Server Components, Route Handlers | `getVisitorId(config)`, `getSplitHub(config)` → `.variant(id)`, `.value(id)` |
| `@splithub/next/client` | Client Components | `SplitHubNextProvider`, `Experiment`, `Variant`, `useVariant`, `useValue`, `useTrack`, `Exposure` |

## Setup (what `npx splithub init` does)

```ts
// middleware.ts
import { splithubMiddleware } from '@splithub/next';
import config from './splithub.config';
export default splithubMiddleware(config);
export const config = { matcher: ['/((?!_next|api|.*\\..*).*)'] };
```

```ts
// app/api/splithub/[[...path]]/route.ts   (self-hosted mode)
import { createSplitHubHandler } from '@splithub/node';
import { sqliteStore } from '@splithub/adapter-sqlite';
import config from '../../../../splithub.config';
const handler = createSplitHubHandler({ config, store: sqliteStore(), adminToken: process.env.SPLITHUB_ADMIN_TOKEN });
export const POST = handler;
export const GET = handler;
export const runtime = 'nodejs';
```

```tsx
// app/layout.tsx (Server Component)
import { SplitHubNextProvider } from '@splithub/next/client';
import { getSplitHub } from '@splithub/next/server';
import config from '../splithub.config';

export default async function RootLayout({ children }) {
  const sh = await getSplitHub(config);
  return (
    <html><body>
      <SplitHubNextProvider config={config} visitorId={sh.visitorId ?? undefined} remoteOverrides={sh.overrides}>
        {children}
      </SplitHubNextProvider>
    </body></html>
  );
}
```

## Live overrides (cloud mode)

`npx splithub pause <id>` (or the dashboard) pauses an experiment, changes
traffic/weights or swaps `value` payloads without a deploy. The middleware and
`getSplitHub` fetch `GET /v1/overrides/<pk>.json` at most once per 60 s per
isolate and apply it on top of the config file; the layout passes the same
overrides to the client provider so hydration agrees. Opt out with
`splithubMiddleware(config, { remote: false })`.

## Using experiments

Client Components: same API as `@splithub/react`, imported from `@splithub/next/client`.

Server Components:

```tsx
import { getSplitHub } from '@splithub/next/server';
import { Exposure } from '@splithub/next/client';

export default async function Page() {
  const sh = await getSplitHub(config);
  const title = sh.value<string>('hero-title');
  return (
    <>
      <h1>{title}</h1>
      <Exposure id="hero-title" />   {/* records the exposure once on the client */}
    </>
  );
}
```

Redirect experiments need no code: declare `kind: 'redirect'` with `match` and
per-variant `to`, and the middleware rewrites the request. The URL in the
address bar does not change and the visitor sees no flash.

## Why no flicker

The middleware decides the visitor id before anything renders, Server
Components compute the same deterministic assignment as the client, and the
client provider receives that id as a prop. Both sides agree on the first byte.
