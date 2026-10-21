package io.splithub.compose

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import io.splithub.SplitHub

/**
 * A number that changes whenever variants may have changed: decided on a first launch,
 * a new session, or [SplitHub.reset]. Reading it makes the caller recompose then.
 */
@Composable
fun rememberSplitHubVersion(): Int {
    var version by remember { mutableIntStateOf(0) }
    val pendingWhenComposed = SplitHub.isPending
    DisposableEffect(Unit) {
        val off = SplitHub.addListener { version++ }
        // Decided between composing and subscribing: the listener came too late for it.
        if (pendingWhenComposed && !SplitHub.isPending) version++
        onDispose { off() }
    }
    return version
}

/** The variant key of an experiment, recording an exposure once it is shown. Control when not in it. */
@Composable
fun rememberVariant(id: String): String {
    val version = rememberSplitHubVersion()
    val variant = remember(id, version) { SplitHub.client?.peekVariant(id) ?: "control" }
    LaunchedEffect(id, variant, version) { SplitHub.exposure(id) }
    return variant
}

/**
 * The payload of a `value` experiment (parsed JSON: Map, List, String, Long, Double, Boolean or null),
 * recording an exposure once it is shown.
 */
@Composable
fun rememberValue(id: String): Any? {
    val version = rememberSplitHubVersion()
    val value = remember(id, version) { SplitHub.client?.peekValue(id) }
    LaunchedEffect(id, version) { SplitHub.exposure(id) }
    return value
}

/**
 * Renders the visitor's variant of an experiment and records the exposure when it is shown:
 *
 * ```kotlin
 * Experiment("hero-cta") { variant ->
 *     when (variant) {
 *         "bold" -> BoldButton()
 *         else -> PlainButton()
 *     }
 * }
 * ```
 */
@Composable
fun Experiment(id: String, content: @Composable (variant: String) -> Unit) {
    content(rememberVariant(id))
}

/** Sends a screen view when this screen enters the composition (and again when [name] changes). */
@Composable
fun TrackScreen(name: String, props: Map<String, Any?>? = null) {
    LaunchedEffect(name) { SplitHub.screen(name, props) }
}
