# SplitHub for iOS and macOS

Experiments and analytics for Swift apps. You create experiments in the SplitHub
dashboard; the app picks a variant on the device, with no network call on render,
and sends what people saw and did.

iOS 14+ and macOS 11+. No dependencies.

## Install

In Xcode: **File → Add Package Dependencies…** and paste the repository URL.
Or in `Package.swift`:

```swift
.package(url: "https://github.com/splithub-io/splithub-sdk", from: "0.5.1")
```

Then add `SplitHub` to your target's dependencies.

## Quick start

Start the SDK once, as early as you can. You'll find the public key (`pk_...`) and
the property id (`sh-...`) in the dashboard under Settings.

```swift
import SplitHub

SplitHub.start(publicKey: "pk_...", property: "sh-x1h78w")
```

Read a variant where you render it. The first variant of an experiment is the control.

```swift
let button = SplitHub.variant("checkout-button") // "control" or "green"
```

A `value` experiment hands you its payload:

```swift
let price: Int? = SplitHub.value("price")
```

Send events by name. An experiment whose goal is that event counts it as a conversion.

```swift
SplitHub.track("Purchase", props: ["revenue": 29])
SplitHub.screen("Settings")              // a page view of /Settings
SplitHub.identify(userId: "user-42", traits: ["plan": "pro"])
SplitHub.reset()                         // on logout
```

## SwiftUI

```swift
import SwiftUI
import SplitHub

@main
struct ShopApp: App {
    init() {
        SplitHub.start(publicKey: "pk_...", property: "sh-x1h78w")
    }

    var body: some Scene {
        WindowGroup { CheckoutView() }
    }
}

struct CheckoutView: View {
    var body: some View {
        SplitHubExperiment("checkout-button") { variant in
            if variant == "green" {
                Button("Buy now") {}.foregroundColor(.green)
            } else {
                Button("Buy now") {}
            }
        }
        .splithubScreen("Checkout")
    }
}
```

`SplitHubExperiment` records the exposure when the view appears. `.splithubScreen`
reports the screen each time it appears.

## Good to know

- **First launch.** Experiments come from the dashboard. The SDK waits up to 400 ms
  for them (`Options(waitMs:)`) and shows the control meanwhile. After that it keeps a
  copy on the device, so later launches decide at once.
- **Offline.** Events wait on disk (up to 1,000) and go out when the network is back.
- **Sessions.** A new session starts after 30 minutes in the background.
- **QA.** Force a variant with `Options(force: ["checkout-button": "green"])`. Forced
  views are never counted.
- **Previews and tests.** SwiftUI previews send nothing. Pass `Options(disabled: true)` in tests.

## Development

The assignment code must match `@splithub/core` exactly. The tests check it against
the shared vectors:

```sh
node scripts/copy-vectors.mjs
swift test
```
