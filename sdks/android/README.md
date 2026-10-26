# SplitHub for Android

Experiments and analytics for native Android apps, in Kotlin. A visitor gets the same variant here as on your website, because assignment is the same hash as `@splithub/core`.

## Install

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("io.splithub:splithub:0.5.1")
    // Optional: Jetpack Compose helpers
    implementation("io.splithub:splithub-compose:0.5.1")
}
```

Min SDK 21. The library brings its own `INTERNET` permission and no dependency besides `androidx.lifecycle:lifecycle-process`.

## Quick start

Start it once, in your `Application`:

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        SplitHub.start(this, "pk_live_...", property = "sh-x1h78w")
    }
}
```

The key is your project's public key (Settings, API keys). The property is the analytics property for screens and events; leave it out to run experiments only.

Then, anywhere:

```kotlin
val cta = SplitHub.variant("hero-cta")          // "control", "bold", ...
val price = SplitHub.value("price") as? Map<*, *> // payload of a value experiment
SplitHub.screen("Settings")                      // a page view with url /Settings
SplitHub.track("signup")                         // any event name
SplitHub.track("Video Played", mapOf("id" to 7))
SplitHub.identify("user-42", mapOf("plan" to "pro"))
SplitHub.reset()                                 // on log out
```

`variant()` and `value()` record an exposure (a visitor who saw a variant), once per variant per session. `valueJson()` gives the payload as JSON text for Gson, Moshi or kotlinx.serialization.

## Compose

```kotlin
@Composable
fun Home() {
    TrackScreen("Home")

    Experiment("hero-cta") { variant ->
        when (variant) {
            "bold" -> Button(onClick = { SplitHub.track("signup") }) { Text("Start free") }
            else -> Button(onClick = { SplitHub.track("signup") }) { Text("Sign up") }
        }
    }

    val price = rememberValue("price")
}
```

`Experiment` records the exposure when the variant is shown and recomposes when variants change.

## Where experiments come from

Apps have no `splithub.config.ts`. You create experiments in the dashboard, and the app reads them from the cloud:

- The settings are cached on the device, so from the second launch on every variant is known at once.
- On the very first launch the app waits up to 400 ms for them and shows the control meanwhile. The Compose helpers update by themselves. In plain views, read variants in `SplitHub.whenReady { }`.
- A change in the dashboard reaches the app on its next session, never in the middle of one.

Targeting can use `platform` (`android`), `app_version` (with `gte` / `lt`: `2.10.0` is above `2.9`), language, time zone, device (`mobile` or `tablet`) and the country the cloud sees.

## Sessions and offline

- The visitor id stays on the device until `reset()`.
- A new session starts when the app comes back after 30 minutes in the background.
- Events go out in batches every 2 seconds and when the app goes to the background. Offline, they wait on the device (up to 1,000) and go out later.

## QA

Force a variant on your own device. It's shown but never counted:

```kotlin
SplitHub.start(this, "pk_live_...", options = SplitHubOptions(forcedVariants = mapOf("hero-cta" to "bold"), debug = true))
```

`debug = true` logs every decision under the Logcat tag `SplitHub`.

## Working on the SDK

| Module | What |
|---|---|
| `splithub-core` | Plain Kotlin/JVM: hash, assignment, targeting, overrides, JSON, the queue and the client. Tested without Android. |
| `splithub` | The Android library: SharedPreferences, app lifecycle, device info. |
| `splithub-compose` | `Experiment`, `TrackScreen`, `rememberVariant`, `rememberValue`. |

The repository has no Gradle wrapper jar. Generate it once with a local Gradle (8.14 or newer):

```sh
gradle wrapper
./gradlew :splithub-core:test
```

The tests check every case of the shared vectors from `@splithub/core`. After the vectors change, copy them in:

```sh
node scripts/copy-vectors.mjs
```
