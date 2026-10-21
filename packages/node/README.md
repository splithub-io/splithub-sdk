# @splithub/node

Self-hosted ingest and results for SplitHub. One fetch-style handler that
works in Next.js route handlers, Remix, Hono, Bun, Deno and plain Node.

```ts
import { createSplitHubHandler, toNodeListener } from '@splithub/node';
import { sqliteStore } from '@splithub/adapter-sqlite';
import config from './splithub.config';

const handler = createSplitHubHandler({
  config,
  store: sqliteStore({ file: './splithub.db' }),
  adminToken: process.env.SPLITHUB_ADMIN_TOKEN, // protects GET endpoints
});

// Next.js app router: export const POST = handler; export const GET = handler;
// Express / Vite / http: app.use('/api/splithub', toNodeListener(handler));
```

Routes relative to the mount path:

| Method | Path | Purpose |
|---|---|---|
| POST | `/` | Ingest an event batch from the SDK |
| GET | `/status` | Every experiment with exposures, visitors and days |
| GET | `/results/:id` | Visitors, conversions, rate (and revenue) per variant |
| GET | `/health` | Liveness |

Reads return raw numbers from your own database:

```json
{
  "experiment": "hero",
  "kind": "component",
  "status": "running",
  "goal": "signup",
  "variants": [
    { "variant": "control", "visitors": 1204, "conversions": 61, "rate": 0.0507 },
    { "variant": "bold", "visitors": 1189, "conversions": 79, "rate": 0.0664 }
  ],
  "metrics": [{ "metric": "refund", "role": "guardrail", "worse": "higher", "variants": [] }],
  "days": 6.2,
  "analysis": { "available": false, "message": "Verdicts, stars and recommendations come with SplitHub Cloud.", "url": "https://splithub.io/cloud" }
}
```

The first variant is the control. `rawResults(config, store, id)` and `rawStatusTable(config, store)`
give the same numbers in code. Verdicts, data-quality stars and recommendations come with SplitHub Cloud.

## Apps

The same handler takes events from apps built with `@splithub/react-native` (React Native, Expo).
An app batch carries the app's info instead of a user agent: every stored event gets `platform`
(`ios`, `android` ...; `web` for websites) and `app_version`, and the device, OS and host come from
the app. Events sent while the app was offline arrive later with their original time.

## Bring your own database

Implement the `Store` interface (three methods) against Postgres, Supabase,
Prisma, Mongo, anything:

```ts
interface Store {
  insertEvents(events: StoredEvent[]): Promise<number>;      // ignore duplicate ids
  variantCounts(experiment: string, goal: string): Promise<StoreVariantCounts[]>;
  summaries(): Promise<ExperimentSummary[]>;
}
```

Attribution rule for `variantCounts`: a visitor converts for a variant when
they sent the goal at or after their first exposure to that variant. Unit is
the unique visitor. `createMemoryStore()` is a reference implementation.
