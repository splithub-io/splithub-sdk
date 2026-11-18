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

## In an app

Outside the browser, give the client a `platform` adapter instead of a page: a
synchronous storage, the app's info and its lifecycle.

```ts
import { createClient, memoryStorage } from '@splithub/core';

const client = createClient(config, {
  platform: {
    storage: memoryStorage(),                 // any sync getItem / setItem / removeItem store
    app: { platform: 'ios', id: 'com.acme.shop', version: '2.4.1' },
    onBackground: (cb) => appState.on('background', cb), // flush when the app hides
    onForeground: (cb) => appState.on('foreground', cb), // new session after 30 minutes away
  },
});
client.screen('Settings');                    // a pageview of /Settings
```

With an adapter the client keeps the visitor in `storage`, sends pageviews only
from `screen()`, and keeps unsent events on the device (up to 1,000) until the
network is back. Experiments can target the app with the `platform` and
`app_version` fields; `app_version` takes `gte` / `lt` and compares part by
part (`2.10.0` is after `2.9`).

Use `@splithub/react` in React apps and `@splithub/react-native` in React
Native and Expo apps. Native apps have their own SDKs for iOS (Swift) and
Android (Kotlin) in the [splithub-sdk repository](https://github.com/splithub-io/splithub-sdk).
Use this package directly for vanilla JS, other frameworks, server-side
assignment, or traffic simulation.
