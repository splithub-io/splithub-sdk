package io.splithub

import android.content.Context
import android.util.Log
import io.splithub.core.Assignment
import io.splithub.core.ClientOptions
import io.splithub.core.Reason
import io.splithub.core.SplitHubClient

/** Optional settings for [SplitHub.start]. */
data class SplitHubOptions @JvmOverloads constructor(
    /** First launch, nothing cached yet: how long experiments wait for the dashboard's settings before showing the control. */
    val waitMs: Long = SplitHubClient.REMOTE_WAIT_MS,
    /** Force variants on this device for QA (`mapOf("hero" to "bold")`). Forced variants are shown and never counted. */
    val forcedVariants: Map<String, String> = emptyMap(),
    /** Send nothing (screenshots, UI tests). */
    val disabled: Boolean = false,
    /** Log what the SDK decides and sends (Logcat tag `SplitHub`). Warnings are always logged. */
    val debug: Boolean = false,
    /** How often waiting events are sent, in milliseconds. */
    val flushIntervalMs: Long = 2_000,
)

/**
 * SplitHub for Android: experiments and analytics. Call [start] once, in `Application.onCreate`:
 *
 * ```kotlin
 * SplitHub.start(this, "pk_live_...", property = "sh-x1h78w")
 * val cta = SplitHub.variant("hero-cta")
 * SplitHub.track("signup")
 * ```
 *
 * Experiments are created in the dashboard (apps have no config file). The settings are cached,
 * so from the second launch on every variant is known synchronously.
 */
object SplitHub {
    const val DEFAULT_ENDPOINT: String = SplitHubClient.DEFAULT_ENDPOINT

    @Volatile
    private var instance: SplitHubClient? = null

    /** The client after [start]; null before. */
    @JvmStatic
    val client: SplitHubClient?
        get() = instance

    /**
     * Starts the SDK. Safe to call more than once: later calls return the running client.
     * @param publicKey the project's public key (`pk_...`), safe to ship in the app.
     * @param property the analytics property id (`sh-x1h78w`) for screens and events; null sends experiments only.
     * @param endpoint the ingest URL; change it for a self-hosted cloud or a local worker.
     */
    @JvmStatic
    @JvmOverloads
    @Synchronized
    fun start(
        context: Context,
        publicKey: String,
        property: String? = null,
        endpoint: String = DEFAULT_ENDPOINT,
        options: SplitHubOptions = SplitHubOptions(),
    ): SplitHubClient {
        instance?.let { running ->
            Log.w("SplitHub", "[splithub] start() was already called; the running client is kept.")
            return running
        }
        if (!publicKey.startsWith("pk_")) {
            Log.w("SplitHub", "[splithub] \"$publicKey\" does not look like a public key. Copy the pk_... key from Settings, API keys.")
        }
        val app = context.applicationContext ?: context
        val info = AndroidPlatform.appInfo(app)
        val client = SplitHubClient(
            ClientOptions(
                publicKey = publicKey,
                property = property,
                endpoint = endpoint,
                storage = SharedPreferencesStorage(app),
                sdk = sdkName(),
                app = info,
                context = AndroidPlatform.targetingContext(info),
                forcedVariants = options.forcedVariants,
                disabled = options.disabled,
                waitMs = options.waitMs,
                flushIntervalMs = options.flushIntervalMs,
                dispatch = { r -> AndroidPlatform.mainHandler.post(r) },
                logger = AndroidPlatform.logger(options.debug),
            ),
        )
        instance = client
        AndroidPlatform.observeLifecycle(client)
        return client
    }

    private fun running(what: String): SplitHubClient? {
        val c = instance
        if (c == null) Log.w("SplitHub", "[splithub] $what before SplitHub.start(); call start() in Application.onCreate.")
        return c
    }

    /** The variant key of an experiment (control when not in it) and an exposure. */
    @JvmStatic
    fun variant(experiment: String): String = running("variant(\"$experiment\")")?.variant(experiment) ?: "control"

    /**
     * The payload of a `value` experiment, as parsed JSON: `Map<String, Any?>`, `List<Any?>`, `String`,
     * `Long`, `Double`, `Boolean` or null. Records an exposure.
     */
    @JvmStatic
    fun value(experiment: String): Any? = running("value(\"$experiment\")")?.value(experiment)

    /** [value] as JSON text, for your own parser (Gson, Moshi, kotlinx.serialization). */
    @JvmStatic
    fun valueJson(experiment: String): String? = running("valueJson(\"$experiment\")")?.valueJson(experiment)

    /** Assignment without side effects: the variant and why. */
    @JvmStatic
    fun assignment(experiment: String): Assignment =
        instance?.assignment(experiment) ?: Assignment(experiment, null, Reason.PENDING)

    /** Record that the visitor saw the experiment. [variant] and the Compose helpers do it for you. */
    @JvmStatic
    fun exposure(experiment: String) {
        running("exposure(\"$experiment\")")?.exposure(experiment)
    }

    /** An event, any name: `track("signup")`, `track("Video Played", mapOf("id" to 7))`. */
    @JvmStatic
    @JvmOverloads
    fun track(name: String, props: Map<String, Any?>? = null) {
        running("track(\"$name\")")?.track(name, props)
    }

    /** A screen view, sent as a page with url `/<name>`. */
    @JvmStatic
    @JvmOverloads
    fun screen(name: String, props: Map<String, Any?>? = null) {
        running("screen(\"$name\")")?.screen(name, props)
    }

    /** Ties this visitor to your user id with optional flat traits; `null` forgets it. */
    @JvmStatic
    @JvmOverloads
    fun identify(userId: String?, traits: Map<String, Any?>? = null) {
        running("identify()")?.identify(userId, traits)
    }

    /** Log out: forget the user id and start over as a new visitor. */
    @JvmStatic
    fun reset() {
        running("reset()")?.reset()
    }

    /** Send waiting events now. */
    @JvmStatic
    fun flush() {
        instance?.flush()
    }

    /** True on a first launch while experiments wait for the dashboard's settings (at most 400 ms). */
    @JvmStatic
    val isPending: Boolean
        get() = instance?.isPending ?: false

    /** Runs [callback] on the main thread once experiments are decided; at once when they already are. */
    @JvmStatic
    fun whenReady(callback: () -> Unit) {
        val c = running("whenReady()") ?: return
        c.whenReady(callback)
    }

    /** Called on the main thread when variants may have changed (decided, new session, reset). Returns a function that unsubscribes. */
    @JvmStatic
    fun addListener(listener: () -> Unit): () -> Unit = instance?.addListener(listener) ?: {}
}
