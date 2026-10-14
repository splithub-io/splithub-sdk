# @splithub/adapter-d1

`Store` implementation on Cloudflare D1. Used by SplitHub Cloud and by
self-hosters running the ingest handler on Workers.

```ts
import { d1Store, d1Schema } from '@splithub/adapter-d1';
const store = d1Store(env.DB, { project: projectId });
// apply d1Schema() once as a migration
```

`@splithub/adapter-d1/testing` exports `sqliteD1()`, a D1-shaped shim over
Node's built-in SQLite for unit tests.
