# @splithub/react-native

Experiments and analytics for React Native and Expo apps. Variants are decided on the device
before the first render (a local hash, no network call), screens and events are counted in the
same reports as your website, and events wait on the device while it is offline.

## Install

Expo:

```bash
npx expo install @splithub/react-native @react-native-async-storage/async-storage expo-application expo-device
```

Bare React Native:

```bash
npm i @splithub/react-native @react-native-async-storage/async-storage
cd ios && pod install
```

React Native 0.72 or newer. Storage keeps the visitor (and their variant) between launches, plus events not sent yet.
The package uses `react-native-mmkv` when it is installed, else AsyncStorage. `expo-application`
and `expo-device` report the app version and the device model; without Expo, pass them yourself
(see below).

## Quick start

```tsx
import { SplitHubProvider, Experiment, Variant, useTrack } from '@splithub/react-native';

export default function App() {
  return (
    <SplitHubProvider publicKey="pk_..." property="sh-x1h78w">
      <Home />
    </SplitHubProvider>
  );
}

function Home() {
  const track = useTrack();
  return (
    <>
      <Experiment id="welcome">
        <Variant name="control"><Text>Welcome to the shop.</Text></Variant>
        <Variant name="short"><Text>Shop in two taps.</Text></Variant>
      </Experiment>
      <Button title="Get started" onPress={() => track('Get Started')} />
    </>
  );
}
```

`publicKey` is your project's public key (`pk_...`) from the dashboard, `property` the id of your
app's analytics property. Create the `welcome` experiment in the dashboard: until it runs, everyone sees the control.

The hooks are the same as in `@splithub/react`: `useVariant`, `useValue`, `useTrack`, `useIdentify`,
`useScreen`, `useAssignment`, `useSplitHub`.

### With a config file

If you keep experiments in `splithub.config.ts` (and run the `splithub` CLI), pass the config instead:

```tsx
import config from './splithub.config';

<SplitHubProvider config={config} property="sh-x1h78w">
```

### App info without Expo

```tsx
<SplitHubProvider publicKey="pk_..." app={{ appId: 'com.acme.shop', version: '2.4.1', build: '412' }}>
```

`app` also takes `device` (`mobile | tablet | desktop`), `storage` (an MMKV instance, AsyncStorage or
any synchronous `getItem` / `setItem` / `removeItem` store) and extra targeting `context`.

### Launch

AsyncStorage is read once into memory on launch, so variants stay synchronous. The provider renders
`fallback` (default nothing) during that read. To start it earlier, call `prepare()` before the
splash screen hides:

```ts
import { prepare } from '@splithub/react-native';
import * as SplashScreen from 'expo-splash-screen';

SplashScreen.preventAutoHideAsync();
prepare().finally(() => SplashScreen.hideAsync());
```

With MMKV there is nothing to wait for.

The very first launch also waits up to 400 ms for the dashboard's experiments (control meanwhile),
then decides once. Later launches use the copy saved on the device and refresh it in the background.

## Screens

A screen is a page in the analytics reports: the url is the route, the title the screen name.

Expo Router, once in `app/_layout.tsx`:

```tsx
function Screens() {
  useExpoRouterTracking(); // `/`, `/product/42`, ...
  return <Stack />;
}

export default function RootLayout() {
  return (
    <SplitHubProvider publicKey="pk_...">
      <Screens />
    </SplitHubProvider>
  );
}
```

React Navigation:

```tsx
const ref = useNavigationContainerRef();
const tracking = useNavigationTracking(ref); // `/Home`, `/Settings`, ...

<NavigationContainer ref={ref} {...tracking}>
```

`useNavigationTracking` must run inside `<SplitHubProvider>`. Anything else: `useScreen('Checkout')`.

The same as one line each, which is what `npx splithub init` writes:

```tsx
import { SplitHubProvider, ExpoRouterScreens, NavigationScreens } from '@splithub/react-native';

<SplitHubProvider config={config}>
  <ExpoRouterScreens />        {/* app/_layout.tsx */}
  <Stack />
</SplitHubProvider>

<SplitHubProvider config={config}>
  <NavigationContainer>
    <NavigationScreens />      {/* finds the container; or navigationRef={ref} */}
    <Tabs />
  </NavigationContainer>
</SplitHubProvider>
```

## Targeting by app version

Every event carries the app's platform and version, so an experiment can target them. In the
dashboard's targeting editor add an app version or platform condition; in a config file:

```ts
flow: {
  start: 'new-app',
  nodes: {
    'new-app': { type: 'condition', conditions: [{ field: 'app_version', op: 'gte', value: '2.4' }], then: 'split', else: 'out' },
    split: { type: 'split', outputs: [{ weight: 50, to: 'a' }, { weight: 50, to: 'b' }] },
    a: { type: 'variant', variant: 'control' },
    b: { type: 'variant', variant: 'new-checkout' },
    out: { type: 'skip' },
  },
},
```

Versions compare part by part (`2.10.0` is after `2.9`). Only builds that ship the new variant's code
should enter: older versions get the control and count as nothing.

## Why app experiments live in the cloud

A website deploys in minutes; an app waits for store review and for users to update. So the variants
ship inside the build, and everything else lives in the dashboard: start, pause, weights, values,
targeting and new `value` experiments reach installed apps on the next launch. Nothing is fetched
while rendering; the app uses the copy it saved on the last launch.

## Debug builds send nothing

Like `vite` or `next dev` on the web, a development build (`NODE_ENV=development`, every Metro debug bundle) sends
nothing to SplitHub Cloud, so your own taps never count as visitors. Variants still render, and
assignment works the same. To see events arrive, run a release build:

```bash
npx expo start --no-dev --minify              # Expo Go / dev client, production JS
npx expo run:ios --configuration Release
npx expo run:android --variant release
```

## Background and offline

Events are sent in small batches, and right away when the app goes to the background. Without a
connection they stay on the device (up to 1000) and go out on a later launch with their original
time. Coming back after 30 minutes in the background starts a new session.

## Example

`examples/expo-app` in the SDK repository: Expo Router, an experiment, screens and an event.
