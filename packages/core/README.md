# @splithub/core

Framework-agnostic core of SplitHub: `defineConfig`, deterministic assignment
(MurmurHash3), visitor id, event queue and a tiny client.

```ts
import { defineConfig, createClient } from '@splithub/core';

const config = defineConfig({ project: 'app', storage: { mode: 'self', endpoint: '/api/splithub' }, experiments: { ... } });
const client = createClient(config);           // browser: reads/writes the sh_vid cookie
client.variant('hero-cta');                    // 'control' | 'bold', records an exposure
client.value<string>('hero-title');
client.track('signup', { revenue: 49 });        // an event, any name; converts experiments whose goal it is
```

In cloud mode the client also applies **remote overrides** (pause, traffic,
weights, `value` payloads changed without a deploy): the cached copy from
localStorage is applied synchronously on page load, a fresh copy is fetched in
the background for the next load. Assignments never change mid-page.

Use `@splithub/react` in React apps. Use this package directly for vanilla JS,
other frameworks, server-side assignment, or traffic simulation.
