# @splithub/adapter-sqlite

SQLite `Store` for `@splithub/node` using Node's built-in `node:sqlite`.
No native build step. Requires Node 22.13+.

```ts
import { sqliteStore } from '@splithub/adapter-sqlite';
const store = sqliteStore({ file: './splithub.db' });   // or ':memory:'
```

Creates one table (`splithub_events`) with two indexes on first use. Events from apps keep their `platform` (`ios`, `android` ...; `web` for websites) and `app_version`; a database made by an older version gets those columns on open.
