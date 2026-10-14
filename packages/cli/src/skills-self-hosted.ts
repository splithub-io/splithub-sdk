// Skill: SplitHub with the user's own database (self mode) and reporting from the cloud.
// Bundled fallback; SplitHub Cloud serves the current text at GET /v1/skills.
export const SKILL_SELF_HOSTED = `---
name: splithub-self-hosted
description: Keep SplitHub events in your own database (self mode): which tables, how to write a Store for Postgres, MySQL, Prisma, Drizzle, Supabase or anything else, where the ingest route lives, how the CLI reads results from it, and how to get cloud data into your own database for reports. Use when the user wants data in their infra or asks about tables, schema or reporting.
---

# SplitHub with your own database

Two ways to own the data:

1. **Self mode** — the app hosts the ingest route and the store; nothing leaves your infra.
   \`splithub.config.ts\`: \`storage: { mode: 'self', endpoint: '/api/splithub' }\`.
2. **Cloud + export** — events go to SplitHub Cloud; you pull summaries into your warehouse for reports.

## Self mode: the pieces

- Route: \`app/api/splithub/[[...path]]/route.ts\` (Next.js) or any fetch-style handler from
  \`createSplitHubHandler({ config, store, adminToken })\` in \`@splithub/node\`. It accepts
  \`POST /events\` from the SDK and answers \`GET /status\`, \`GET /results/<id>\` for the CLI
  (\`npx splithub status\` talks to the local dev server, or \`--url https://your.app/api/splithub\`).
  Self-hosted reads are raw numbers per variant (\`variants[]\`: visitors, conversions, rate, revenue)
  with \`analysis: { available: false }\`. Verdicts, data-quality stars and recommendations come with SplitHub Cloud.
- Store: an object with three methods (below). Ready-made: \`@splithub/adapter-sqlite\`
  (Node 22.13+, \`node:sqlite\`, zero setup) and \`@splithub/adapter-d1\` (Cloudflare D1).
  \`npx splithub init --mode self --db postgres|mysql|custom\` writes \`splithub/store.ts\` with a
  working Postgres (pg) or MySQL (mysql2) store, or a documented stub for anything else.
- Admin token: set \`SPLITHUB_ADMIN_TOKEN\` in the app and \`--token\` / \`SPLITHUB_ADMIN_TOKEN\` for
  the CLI, so results are not public.

## The events table

One table, one row per event. Column names are yours; the templates use these:

| column | type | meaning |
|---|---|---|
| id | text, primary key | client-generated, unique; dedupe on it (retries resend batches) |
| type | text | \`exposure\` or \`goal\` |
| experiment, variant | text | for exposures |
| goal | text | for goals |
| visitor_id, session_id | text | \`sh_vid\` cookie / session |
| ts | bigint | client time, unix ms |
| url | text | page |
| props | json | goal payload, e.g. \`{ "revenue": 49 }\` |
| received_at | bigint | server time, unix ms |
| host, country, device, browser | text | request metadata (fill from headers if you want breakdowns) |

Indexes: \`(type, experiment, visitor_id, ts)\` and \`(type, goal, visitor_id, ts)\`.

## The Store interface (\`@splithub/node\`)

\`\`\`ts
interface Store {
  insertEvents(events: StoredEvent[]): Promise<number>;                      // skip existing ids, return inserted count
  variantCounts(experiment: string, goal: string): Promise<VariantCounts[]>;  // per variant: exposures, conversions, revenue
  summaries(): Promise<ExperimentSummary[]>;                                 // per experiment: exposures, visitors, first/last ts
  close?(): Promise<void> | void;
}
\`\`\`

Attribution rule — keep it exactly, so self-hosted results equal the cloud's:
**a visitor converts for a variant when they sent the goal at or after their first exposure to
that variant; exposures and conversions count unique visitors.** The SQL in the generated
\`splithub/store.ts\` implements it (CTE \`first_exposure\`, then goals joined with \`ts >= first_ts\`).

Prisma / Drizzle: map the table in your schema and write the three methods with the ORM, or run the
one raw query for \`variantCounts\`. Supabase: the same SQL as a Postgres function called through
\`rpc\`. Mongo: \`$group\` by variant and visitor with \`$min ts\`, then \`$lookup\` goals.

## Reports from the cloud into your database

- CSV: dashboard → experiment → Export (summary, daily timeline, raw events up to 50k rows).
- Webhook channel for alerts and the digest: POST JSON to your endpoint when something happens.
- Scheduled pull: a cron in your app calls \`GET /v1/status\` and \`GET /v1/results/<id>\` with the
  API key (\`sk_…\`) and stores the verdicts. Raw events live 30–90 days in the cloud (plan dependent),
  aggregates a year: pull summaries, not raw rows, for long-term reporting.
- Need every raw event forever in your infra? Use self mode; one store per project.

## Do not

- Put database credentials in \`splithub.config.ts\` (it ships to the browser). They belong in the route's env.
- Call a winner from raw rates: a higher rate is often noise. Say the numbers as they are; verdicts come with SplitHub Cloud.
`;
