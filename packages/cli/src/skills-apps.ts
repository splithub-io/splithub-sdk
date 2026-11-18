// Skill: experiments and analytics in mobile and desktop apps (React Native / Expo, iOS, Android).

export const SKILL_APPS = `---
name: splithub-apps
description: Run SplitHub experiments and analytics in a mobile or desktop app: React Native and Expo (@splithub/react-native), native iOS (Swift package SplitHub) and Android (io.splithub:splithub). Screens, app_version targeting, retention, and why app experiments are created in the cloud. Use when the project has react-native, expo, an Xcode project or an Android Gradle build, or the user asks to A/B test or measure an app.
---

# SplitHub in apps

Same experiments, goals and analytics as on the web. Two things differ: an app's config is built into the binary,
and screens take the place of pages.

## Install

- React Native / Expo: \`npx splithub init --mode cloud --yes --json\`. It installs \`@splithub/react-native\` (plus
  \`@react-native-async-storage/async-storage\`, through \`npx expo install\` on Expo) and wraps the entry in
  \`<SplitHubProvider config={config}>\`: \`app/_layout.tsx\` with Expo Router (adds \`<ExpoRouterScreens />\`),
  else \`App.tsx\` (adds \`<NavigationScreens />\` inside \`<NavigationContainer>\` with React Navigation). Both come from
  \`@splithub/react-native\`; the hooks \`useExpoRouterTracking()\` / \`useNavigationTracking(ref)\` do the same by hand.
  Without a config file: \`<SplitHubProvider publicKey="pk_…" property="sh-…">\`.
  \`app.entry.status\`: added | already | manual (wire \`nextStep\` by hand). Hooks are the web ones, imported from
  \`@splithub/react-native\`: \`useValue\`, \`useVariant\`, \`<Experiment>\`, \`useTrack\`, \`useIdentify\`.
- iOS: Swift package \`SplitHub\` (Xcode: File → Add Package Dependencies → \`https://github.com/splithub-io/splithub-sdk\`).
  \`SplitHub.start(publicKey: "pk_…", property: "sh-…")\` once at launch; \`SplitHub.variant("id")\`, SwiftUI \`SplitHubExperiment("id") { variant in }\`.
- Android: \`implementation("io.splithub:splithub:<version>")\` (+ \`io.splithub:splithub-compose\` for Compose).
  \`SplitHub.start(this, "pk_…", property = "sh-…")\` in \`Application.onCreate\`; \`SplitHub.variant("id")\`, Compose \`Experiment("id") { variant -> }\`, \`TrackScreen("Home")\`.
- Native apps have no \`splithub.config.ts\`: \`init\` prints the install lines and a quick start, and experiments come from the cloud.
- Analytics: \`npx splithub analytics connect --json\` names a property on the provider; in an app project it is created with \`kind: 'app'\`.
- \`npx splithub doctor\` checks the package, the storage module and the provider.

## Experiments reach apps through the cloud

- The config file ships inside the binary: an experiment added there reaches users only with the next store release,
  and only users who update. Old versions stay on what they were built with.
- Start new experiments in the dashboard (no release; installed apps get them on the next launch with network). Pause,
  finish, weights and values set in the dashboard or with \`npx splithub pause|start|finish <id>\` also apply live.
- Still \`npx splithub push\` after any config change, so the cloud and the file agree. Apps also receive the pushed
  experiments from the cloud (overrides JSON with \`?all=1\`), so a pushed experiment reaches an app whose build has its variants.
- Redirect experiments do nothing in an app: use \`value\` (copy, prices, flags as JSON) or \`component\`.
- Assignment is the same local hash on every platform: a visitor gets the same variant on web, iOS and Android.

## Screens, versions, platforms

- A screen is a \`page\` event: url \`/<screen name>\` (or the route path with Expo Router), title the screen name. Every
  page report, funnel (\`page:/Checkout\`) and pageview goal (\`{ type: 'pageview', path: '/Checkout' }\`) works on screens.
- Without a navigation tracker: \`useScreen('Settings')\` (React Native), \`SplitHub.screen("Settings")\` (iOS, Android).
- Target app versions in the experiment's flow (dashboard targeting, or by hand):
  \`{ type: 'condition', conditions: [{ field: 'app_version', op: 'gte', value: '2.4' }], then: 'split', else: 'skip' }\`.
  \`gte\` / \`lt\` compare dotted versions part by part (\`2.10.0\` ≥ \`2.9\`). \`platform\` is \`ios | android | macos | windows | linux | web\`.
  Gate on the version that ships the variant code, so older builds skip the experiment.
- Break down or filter by them: \`results <id> --by platform\`, \`--by app_version\`, \`--filter platform=ios\`;
  \`analytics <property> --by app_version\`, \`--filter app_version=2.5.0\`.
- Events sent offline are kept on the device and arrive later with their own time: today's numbers can still grow.

## Retention

\`npx splithub analytics retention <property> [--period day|week] [--from --to] --json\`: \`cohorts[] { start, users, retained[] }\`,
\`retained[0]\` is the cohort period itself, \`retained[n] / users\` the share back in period n. Up to 90 days or 26 weeks
(\`clamped: true\` when cut). \`--start event:Signup\` and \`--return event:<name>\` change who counts. Counts, never a verdict.
`;
