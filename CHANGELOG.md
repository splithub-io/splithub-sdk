# Changelog

Every package in this repository is released together under one version.

## 0.5.1

Security fixes. Update when you can; nothing in your code needs to change.

### CLI (`npx splithub`)

- **`splithub pull` and `push` keep cloud data as data.** Names, values and numbers from the cloud are escaped or checked before they are written into `splithub.config.ts`, so an experiment edited by someone else in your project can no longer put code into the file.
- **`splithub push` says when analytics properties were left alone.** A key without `analytics:write` now pushes experiments only, and the CLI prints a warning instead of changing properties.

### MCP (`@splithub/mcp`)

- **Tool arguments stay arguments.** A value that looks like an option (`--api`, `--url=…`) is refused instead of being passed to the CLI, so a tool call can no longer send your API key to another server.

### Self-hosted (`@splithub/node`)

- **The ingest body is capped at 1 MiB** (`MAX_BODY_BYTES`) before it is read, in the fetch handler and in `toNodeListener`. A larger body gets 413, and the Node adapter closes the connection.

## 0.5.0

SplitHub now works in apps, next to websites. The same experiments, the same `track()` and the same reports, for React Native, Expo, iOS and Android.

### Apps

- **`@splithub/react-native`** (new). `SplitHubProvider`, `<Experiment>` / `<Variant>` and the hooks you know from `@splithub/react` (`useVariant`, `useValue`, `useTrack`, `useIdentify`, `useScreen`), for React Native 0.72+ and Expo. Variants are decided on the device before the first render. Storage is MMKV when installed, else AsyncStorage (call `prepare()` before the splash screen hides). Development builds send nothing.
- **Screens.** `<ExpoRouterScreens />` and `<NavigationScreens />` (or `useExpoRouterTracking()` / `useNavigationTracking(ref)`) count every screen as a page of your analytics property: the route is the url, the screen name the title.
- **Offline.** Events wait on the device (up to 1,000) and go out later with their original time. A new session starts after 30 minutes in the background.
- **Experiments from the cloud.** An app can't redeploy in minutes, so start, pause, weights, values and new `value` experiments made in the dashboard reach installed apps on the next launch. The first launch waits up to 400 ms for them and shows the control meanwhile.
- **Native SDKs** in `sdks/`: `SplitHub` for iOS 14+ and macOS 11+ (Swift package, SwiftUI helpers; add this repository's URL in Xcode) and `io.splithub:splithub` for Android (Kotlin, min SDK 21, with `io.splithub:splithub-compose` for Jetpack Compose). Same hash as `@splithub/core`, checked against shared test vectors, so a visitor gets the same variant on every platform.
- **`examples/expo-app`**: Expo Router, an experiment, screens and an event.

### Core (`@splithub/core`)

- `createClient(config, { platform })` takes a `PlatformAdapter` (synchronous storage, app info, background / foreground) for apps. With it the client keeps the visitor in that storage, sends pageviews only from `client.screen(name)` and persists unsent events. `memoryStorage()` is a ready storage for tests.
- **Targeting by platform and app version.** New flow fields `platform` (`web`, `ios`, `android`, `macos`, `windows`, `linux`) and `app_version`, and the ops `gte` / `lt`. Versions compare part by part (`2.10.0` is after `2.9`).

### React (`@splithub/react`)

- `useScreen(name)`, and `SplitHubProvider` takes a ready `client` without a `config`. Nothing touches `document` in React Native.

### CLI (`npx splithub`)

- **`splithub init` knows apps.** In a React Native or Expo project it installs `@splithub/react-native` with its storage module and wraps the app entry (`App.tsx` or `app/_layout.tsx`) with screen tracking. In a native iOS or Android project it prints the install lines and a quick start.
- **`splithub doctor`** checks the app package and its storage module, warns about redirect experiments (they do nothing in an app), and finds the SDK in native build files.
- **`splithub analytics create --kind app`**: a property for an app (the default in an app project).
- **`splithub analytics retention`** takes `--period day|week` and `--from --to`, and shows users per cohort.
- `--by platform` / `--by app_version` and the same filters on analytics reports and experiment results.
- New agent skill `splithub-apps`.

### MCP (`@splithub/mcp`)

- `splithub_init` and `splithub_doctor` cover apps; `splithub_property_create` takes `kind: site | app`.
- `platform` and `app_version` as a filter and a `by` dimension on results, breakdowns and analytics reports; `splithub_analytics_retention` answers `cohorts[] { start, users, retained[] }`.

### Self-hosted

- `@splithub/node` accepts app batches and stores `platform` and `app_version` with every event (`web` for websites). `@splithub/adapter-sqlite`, `@splithub/adapter-d1` and the Postgres / MySQL stores written by `splithub init` add the two columns to existing tables on their own (`d1Migrations()` lists the D1 statements).

### SplitHub Cloud

- Analytics properties have a kind, site or app. App properties show screens, platforms and app versions, and a retention report by day or week.
- Results, breakdowns and every analytics report can be split or filtered by platform and app version.
- Allowed domains of an experiment or a property can name an app id (`com.acme.shop`); a list of websites only still refuses apps.

## 0.4.3

- READMEs and npm descriptions cover what SplitHub does today: web analytics (pageviews, events, sources, funnels, paths, retention, segments), the analytics commands and MCP tools, notes, short links and alerts. `@splithub/browser` gets its own README. No code changes.

## 0.4.2

### CLI (`npx splithub`)

- **Saved funnels.** `splithub analytics funnels <id>` lists the funnels saved on a property; `--save <name> --steps "page:/,goal:paid" [--within 7d]` saves one (a saved name updates it) and `--delete <id|name>` removes one. `splithub analytics funnel <id> --funnel <name>` runs a saved funnel.

### MCP (`@splithub/mcp`)

- New `splithub_analytics_funnels` (list, save, delete); `splithub_analytics_funnel` takes `funnel` to run a saved one.

### SplitHub Cloud

- Funnels are saved per property and listed on its Funnels tab. Long funnels no longer answer "busy, retry shortly".
- Report pages have a Segments menu: pick a saved segment, save the current filters, or clear them.

## 0.4.1

### CLI (`npx splithub`)

- **`splithub push` keeps what the file lacks.** Experiments the cloud has from an earlier push (another checkout, an older file) stay as they are and come back as `kept`; `--dry-run` lists them with `=`. `splithub push --prune` removes them, as every push did before. `splithub remove` and `splithub ship` say which one to run.
- **Adding analytics needs no push.** In cloud mode, `splithub analytics create` and `splithub analytics connect` create the property in the cloud right away (`live: applied`) and write it into `splithub.config.ts`; only without an API key do they still ask for `npx splithub push`. Adding analytics never asks for a push now.

### MCP (`@splithub/mcp`)

- `splithub_push` takes `prune` and answers `kept`.
- `splithub_property_create` and `splithub_analytics_connect` say so too: deploy, no push.

### SplitHub Cloud

- An analytics property converts a goal by the same rule experiments use: the goal's key, its display name or the slug of the name (`track('video-played')` and `track('Video Played')` both count for `video-played`).

## 0.4.0

Analytics joins experiments. One install covers both: name an analytics property and the same SDK, the same `track()` and the same visitor feed your reports and your experiments.

### Analytics

- **Properties.** Add `properties: { site: {} }` to `splithub.config.ts`, or make one in the dashboard (ids look like `sh-x1h78w`). Pass it as `property` on `SplitHubProvider` / `createClient`, or as `data-property` on `sh.js`.
- **Pageviews** on load and on every client-side navigation (history and hash routes), with time on page and scroll depth.
- **`track(name, props?)` is the one call** for events: any name, no need to declare it first. React: `useTrack()`. `sh.js`: `splithub.track()`.
- **`identify(uid, traits?)`** ties a visitor to your user id. React: `useIdentify()`. `sh.js`: `splithub.identify()`.
- **Goals are events you mark.** Any event can be an experiment's goal, secondary metric or guardrail; a name that is not declared becomes a goal automatically (`Video Played` → `video-played`). New helpers in `@splithub/core`: `eventKey(name)` and `goalKeyFor(goals, name)`.
- **One row per action.** With a property on, `track()` and page loads send one row each; SplitHub Cloud and `@splithub/node` count it toward the experiments that measure it. Without a property, goal rows go out as before.
- **One collector per page.** If `sh.js` and the SDK both name the same property, only the first one collects pageviews; `track()` works from both.
- **Self-hosted:** stores keep the rows in your database and answer raw counts (`propertyCounts`, `GET {base}/properties`) for the last `?days=` or a `?from=&to=` range of UTC days (`propertyCounts(property, since, until?)`; stores generated earlier keep working). Reports with pages, sources, funnels and retention come with SplitHub Cloud.

### Experiments

- **Where a visitor came from.** Exposures carry the landing page's referrer (origin only, read once per visit), so SplitHub Cloud can break an experiment down by channel and source even without analytics. The Next middleware sends the incoming request's referrer.
- **Slices.** Results, timelines, breakdowns and raw events can be narrowed by country, device, channel, source, landing page, UTM and more, and by a range of first-exposure days. A slice is marked as one and carries no advice: the verdict belongs to the whole experiment.
- **Events per variant** and engagement per variant (visits, bounce, time) when an analytics property runs on the same site.

### CLI (`npx splithub`)

- **One menu for everything:** experiments, analytics, short links, alerts, notes and allowed domains.
- **`splithub analytics connect`** picks or creates a property and adds it to your provider.
- **`splithub analytics`**: reports by page, source, channel, country, device, UTM, trait, event prop or experiment variant, with `--compare`, `--segment` and `--filter`; also `funnel`, `paths`, `retention`, `realtime`, `props`, `segments` and `export` (CSV).
- **New commands:** `splithub notes`, `splithub links`, `splithub alerts` (including "every N events used" and "an event reaches N"), and `splithub domains` for allowed domains per experiment or property.
- **`splithub analytics archive|restore <id>`** archives a property as the dashboard does (stops collecting, leaves the list, numbers kept); the list shows `archived`. Self-hosted `splithub analytics <id>` reads `--from --to` too, and says that filters, `--by` and `--compare` come with SplitHub Cloud instead of ignoring them.
- **`splithub results <id> --by page`** and **`--filter page=/pricing`**: experiment breakdowns use the same word for a page as analytics.
- **`create --goal`** takes any event name.
- **`splithub results <id>`** takes `--from`, `--to` and `--filter k=v` for a slice, and `--by <dimension>`, `--timeline`, `--engagement`, `--events` or `--export` for one view at a time; `splithub events --experiment <id>` lists raw events.
- **`splithub status`** also shows each analytics property's last 7 days.
- Errors from a scoped API key name the missing scope.

### MCP (`@splithub/mcp`)

- New tools: `splithub_analytics`, `splithub_analytics_events`, `splithub_analytics_funnel`, `splithub_analytics_paths`, `splithub_analytics_retention`, `splithub_analytics_realtime`, `splithub_analytics_connect`, `splithub_property_create`, `splithub_property_status`, `splithub_segments`, `splithub_notes`, `splithub_links`, `splithub_alerts` and `splithub_domains`.
- Tool names follow `splithub_<noun>[_<verb>]`: `splithub_experiment_create` and `splithub_experiment_status` replace `splithub_create_experiment` and `splithub_set_status`. The old names (`splithub_create_experiment`, `splithub_set_status`, `splithub_create_property`, `splithub_set_property_status`) still work in this release.
- `splithub_property_status` takes `archived` and `restored` (SplitHub Cloud) next to `running`, `paused` and `removed`.
- `splithub_results` takes `page` as a breakdown (`by`) and as a filter.
- `splithub_results` also takes `from`, `to`, `filters`, `by`, `timeline`, `engagement` and `events`; new `splithub_experiment_events`.

### SplitHub Cloud API

- Every `/v1` error is plain JSON `{ error, code, hint? }`, sign-in and API key errors included. The CLI reads both shapes.
- Experiment breakdown and timeline errors carry a `code` and a `hint`.

### Wording

- CLI, MCP and skills say "experiment" everywhere.

### Upgrading from 0.3

- Nothing to change for experiments. `track('signup')` keeps converting experiments whose goal is `signup`.
- To add analytics, run `npx splithub analytics connect`, or add `property="sh-…"` to your provider.
- `track()` no longer warns about goal names that are not in the config: they become goals.
