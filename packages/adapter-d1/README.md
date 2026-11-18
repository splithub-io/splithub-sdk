# @splithub/adapter-d1

`Store` implementation on Cloudflare D1. Used by SplitHub Cloud and by
self-hosters running the ingest handler on Workers.

```ts
import { d1Store, d1Schema } from '@splithub/adapter-d1';
const store = d1Store(env.DB, { project: projectId });
// apply d1Schema() once as a migration
```

Events from apps keep their `platform` (`ios`, `android` ...; `web` for websites) and
`app_version`. A table made by an older `d1Schema()` gets the two columns on the first insert;
`d1Migrations()` returns the same `ALTER` statements if you prefer a migration.

`@splithub/adapter-d1/testing` exports `sqliteD1()`, a D1-shaped shim over
Node's built-in SQLite for unit tests.
