# @splithub/react

Experiments and web analytics for React apps, built for teams that ship with
coding agents. Variants are decided before the first paint (no flicker),
assignment is a local hash (no network call on render), one `track()` feeds
both the analytics reports and your experiments, and events go either to your
own database or to SplitHub Cloud.

## Install

```bash
npm i @splithub/react @splithub/core
```

## 1. Describe experiments in `splithub.config.ts`

```ts
import { defineConfig } from '@splithub/core';

export default defineConfig({
  project: 'my-app',
  storage: { mode: 'self', endpoint: '/api/splithub' }, // or { mode: 'cloud', key: 'pk_...' }
  runDraftsInDev: true,       // drafts run in development (next dev, vite); production ignores them

  goals: {
    signup: { type: 'event' },
    pricing_view: { type: 'pageview', path: '/pricing' },
  },

  experiments: {
    'hero-cta': {
      kind: 'component',          // JSX variants
      status: 'running',          // draft | running | paused | finished
      variants: { control: 50, bold: 50 },
      goal: 'signup',
    },
    'hero-title': {
      kind: 'value',              // data variants, no code per variant
      status: 'running',
      variants: {
        control: { weight: 50, value: 'Ship faster' },
        direct:  { weight: 50, value: 'Know which version wins' },
      },
      goal: 'signup',
    },
  },
});
```

The first variant is always the control. Keys are lowercase `a-z0-9-_`.

## 2. Wrap the app once

```tsx
import { SplitHubProvider } from '@splithub/react';
import config from '../splithub.config';

<SplitHubProvider config={config}>
  <App />
</SplitHubProvider>
```

## 3. Use experiments

```tsx
import { Experiment, Variant, useVariant, useValue, useTrack } from '@splithub/react';

// Component experiment: each variant is JSX
<Experiment id="hero-cta">
  <Variant name="control"><Hero /></Variant>
  <Variant name="bold"><HeroBold /></Variant>
</Experiment>

// Value experiment: a headline, an image URL, a price, any JSON
const title = useValue<string>('hero-title');

// Same experiment in several places → same variant for the visitor
const v = useVariant('hero-cta');          // 'control' | 'bold'

// Events: one call, any name. An experiment's goal can be any of them.
const track = useTrack();
<button onClick={() => track('signup')}>Sign up</button>
<button onClick={() => track('checkout', { revenue: 49 })}>Buy</button>
```

Pageview goals fire automatically on mount. In SPAs call `usePageview(pathname)`
on route change.

## Analytics

Name an analytics property on the provider and every page and `track()` call
is counted too: traffic, sources, pages, events, goals, funnels, paths and
retention in SplitHub Cloud. `npx splithub analytics connect` creates the
property and writes its id here.

```tsx
<SplitHubProvider config={config} property="sh-x1h78w">
  <App />
</SplitHubProvider>

// Client-side navigations count as pageviews on their own.
const identify = useIdentify();
identify('user_42', { plan: 'pro' });   // ties visits to your user; identify(null) on sign-out
```

## 4. Store events

**Self-hosted (your database):** mount the handler from `@splithub/node` in
your API and pick a store adapter. Nothing leaves your infrastructure, and you
read the raw numbers per variant (visitors, conversions, rate).

```ts
// app/api/splithub/route.ts (Next.js) — or any fetch-style server
import { createSplitHubHandler } from '@splithub/node';
import { sqliteStore } from '@splithub/adapter-sqlite';
import config from '../../../splithub.config';

const handler = createSplitHubHandler({ config, store: sqliteStore({ file: './splithub.db' }) });
export const POST = handler;
export const GET = handler;
```

**Cloud:** set `storage: { mode: 'cloud', key: 'pk_...' }` and nothing else.
Verdicts, data-quality stars and recommendations come with SplitHub Cloud.

## 5. Read results

With SplitHub Cloud:

```bash
npx splithub status                 # every experiment with a verdict headline
npx splithub results hero-cta       # lift, p-value, CI, SRM check, recommendation
npx splithub results hero-cta --json
```

## Rules of thumb

- One `id` for things that must change together; different ids for independent tests.
- Keep 1–3 running experiments per page on low traffic. Independent experiments split visitors independently.
- Changing `seed` reshuffles every visitor. Changing `traffic` does not.
- QA a variant with `?sh_force=hero-cta:bold` (no exposure is recorded). With `runDraftsInDev: true`, drafts run in development without being started.
- Never nest `<Experiment>` inside a `<Variant>` of the same experiment.

## SSR / Next.js

Pass the visitor id from the cookie `sh_vid` to `SplitHubProvider` (`visitorId`
prop) so the server and the client compute the same variant. `@splithub/next`
(middleware, redirects, RSC helpers) covers App Router: see its README.

## API

| Export | What it does |
|---|---|
| `SplitHubProvider` | Creates the client synchronously; props: `config`, `property?`, `visitorId?`, `overrides?`, `client?`, `pageviews?` |
| `Experiment` / `Variant` | Render one `<Variant>` by assignment; records an exposure on mount |
| `useVariant(id)` | Variant key, control when not running |
| `useValue(id)` | Payload of a `value` experiment |
| `useTrack()` | `(name, props?) => void`: an event, any name; converts experiments whose goal it is |
| `usePageview(path)` | Fire pageview goals on client-side navigation |
| `useIdentify()` | `(userId \| null, traits?) => void`: ties the visitor to your user for analytics |
| `useSplitHub()` | The underlying `@splithub/core` client |
