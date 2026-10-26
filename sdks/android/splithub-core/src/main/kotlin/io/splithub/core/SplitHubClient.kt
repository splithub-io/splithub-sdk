package io.splithub.core

import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit

/** Where the SDK writes what it does. Warnings are worth showing in every build; debug lines only when asked. */
interface SplitHubLogger {
    fun warn(message: String)
    fun debug(message: String) {}
}

/**
 * Everything the client needs. The Android library fills storage, app info, context and
 * dispatch; tests pass memory storage, a fake [HttpClient] and their own executors.
 */
class ClientOptions @JvmOverloads constructor(
    /** Public project key (`pk_...`). Safe to ship in the app. */
    val publicKey: String,
    /** Analytics property id (`sh-x1h78w`) for screens and events; null sends no analytics. */
    val property: String? = null,
    val endpoint: String = SplitHubClient.DEFAULT_ENDPOINT,
    val storage: KeyValueStorage = MemoryStorage(),
    /** `sdk` of every batch, `android/<version>` from the Android library. */
    val sdk: String = "jvm/${SplitHubClient.VERSION}",
    val app: AppInfo? = null,
    /** Device context for targeting: platform, appVersion, language, timezone, device, os. */
    val context: TargetingContext = TargetingContext(),
    val http: HttpClient = UrlConnectionHttpClient(),
    /** Forced variants for QA (`mapOf("hero" to "bold")`): shown, never counted. */
    val forcedVariants: Map<String, String> = emptyMap(),
    /** Send nothing (tests, previews). Overrides are still fetched. */
    val disabled: Boolean = false,
    val overridesUrl: String? = null,
    /** Never fetch overrides (tests). */
    val remoteDisabled: Boolean = false,
    /** First launch, nothing cached: how long experiments wait for the overrides before showing the control. */
    val waitMs: Long = SplitHubClient.REMOTE_WAIT_MS,
    /** Cached overrides older than this are fetched again (used from the next session on). */
    val ttlMs: Long = 60_000,
    /** Time in the background after which coming back starts a new session. */
    val sessionTimeoutMs: Long = 30 * 60_000L,
    val maxBatch: Int = 20,
    val flushIntervalMs: Long = 2_000,
    val maxQueue: Int = 1_000,
    val clock: () -> Long = { System.currentTimeMillis() },
    val scheduler: ScheduledExecutorService? = null,
    val io: Executor? = null,
    /** Where listeners and ready callbacks run (the main thread on Android). */
    val dispatch: (Runnable) -> Unit = { it.run() },
    val logger: SplitHubLogger? = null,
)

/**
 * The SplitHub client for apps, a port of `createClient` in @splithub/core with a platform
 * adapter: persistent visitor id, sessions that rotate after 30 minutes in the background,
 * experiments from the cloud's overrides JSON (cached, applied synchronously on the next
 * launch), screens as `page` events and a persisted offline queue.
 *
 * Thread-safe: call it from any thread. Network work runs on background threads.
 */
class SplitHubClient(private val options: ClientOptions) {
    companion object {
        const val VERSION = "0.5.1"
        const val DEFAULT_ENDPOINT = "https://go.splithub.io/v1/events"
        const val REMOTE_WAIT_MS = 400L
        const val PROPERTY_WAIT_MS = 5_000L
        const val MAX_PROPS_BYTES = 4096
        const val VISITOR_KEY = "sh_vid"
        const val UID_KEY = "sh_uid"
        const val REMOTE_CACHE_KEY = "sh_remote"
        /** The cloud identifies the project by the key; the name is informational. */
        const val PROJECT = "app"

        private fun daemon(name: String) = ThreadFactory { r -> Thread(r, name).apply { isDaemon = true } }
    }

    /** Who and where an event happened, read when it happened (the session may rotate before it is sent). */
    private class Who(val vid: String, val sid: String, val url: String?)

    private val lock = Any()
    private val storage = options.storage
    private val clock = options.clock
    private val ownScheduler = options.scheduler == null
    private val scheduler: ScheduledExecutorService = options.scheduler ?: Executors.newSingleThreadScheduledExecutor(daemon("splithub"))
    private val ownIo = options.io == null
    private val io: Executor = options.io ?: Executors.newCachedThreadPool(daemon("splithub-io"))
    private val wanted: String? = options.property?.trim()?.lowercase(Locale.ROOT)?.ifEmpty { null }
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val warned = HashSet<String>()

    private val queue = EventQueue(
        project = PROJECT,
        sdk = options.sdk,
        app = options.app,
        endpoint = options.endpoint,
        key = options.publicKey,
        http = options.http,
        storage = storage,
        scheduler = scheduler,
        io = io,
        clock = clock,
        maxBatch = options.maxBatch,
        flushIntervalMs = options.flushIntervalMs,
        maxQueue = options.maxQueue,
        onError = { warn(it) },
    )

    private var config = SplitHubConfig.EMPTY
    /** Analytics follow the freshest overrides, even ones that arrive after the experiments were decided. */
    private var propConfig = SplitHubConfig.EMPTY
    private var geo: Geo? = null
    private var ctx = TargetingContext()
    private var pendingFlag = false
    private var readyLatch = CountDownLatch(0)
    private val waiting = ArrayList<Pair<String, Long>>()
    private val afterReady = ArrayList<() -> Unit>()
    private val readyCallbacks = ArrayList<() -> Unit>()
    private var fetching = false
    private var propertyFetching = false
    private var propertyWaitId = 0
    private val propertyWaiting = ArrayList<() -> Unit>()
    private var visitor = ""
    private var newVisitor = false
    private var session = Ids.newSessionId()
    private val exposed = HashSet<String>()
    private var sentIdentity: String? = null
    private var currentScreen: String? = null
    private var lastPage: Pair<String, Long>? = null
    private var backgroundAt: Long? = null
    private var closed = false

    init {
        synchronized(lock) {
            val stored = safeGet(VISITOR_KEY)?.takeIf { it.isNotEmpty() && it.length <= 64 }
            newVisitor = stored == null
            visitor = stored ?: Ids.newVisitorId().also { safeSet(VISITOR_KEY, it) }
            ctx = contextFor(null)
            refreshLocked(applyCache = true, initial = true)
        }
    }

    // ---------------------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------------------

    val visitorId: String get() = synchronized(lock) { visitor }

    /** Changes when the app comes back after [ClientOptions.sessionTimeoutMs] in the background, and on [reset]. */
    val sessionId: String get() = synchronized(lock) { session }

    /** Targeting context used for assignments (device + the cloud's geo). */
    val context: TargetingContext get() = synchronized(lock) { ctx }

    /**
     * True on a first launch while the overrides are on their way (at most [ClientOptions.waitMs]).
     * Every experiment shows the control meanwhile; listeners hear when it is decided.
     */
    val isPending: Boolean get() = synchronized(lock) { pendingFlag }

    /** The experiments, goals and properties in use (the overrides applied). */
    val currentConfig: SplitHubConfig get() = synchronized(lock) { config }

    /** Assignment without side effects. */
    fun assignment(experiment: String): Assignment = synchronized(lock) { assignmentLocked(experiment) }

    /** The variant key without recording an exposure (control when not in the experiment). */
    fun peekVariant(experiment: String): String {
        synchronized(lock) {
            val e = config.experiment(experiment) ?: return "control"
            return (assignmentLocked(experiment).variant ?: e.control).key
        }
    }

    /** The payload of a `value` or `mvt` experiment without recording an exposure. */
    fun peekValue(experiment: String): Any? {
        synchronized(lock) {
            val e = config.experiment(experiment) ?: return null
            return (assignmentLocked(experiment).variant ?: e.control).value
        }
    }

    /**
     * The variant key (control when not in the experiment) and an exposure. While [isPending]
     * it answers control and records nothing, since the visitor may end up in another variant.
     */
    fun variant(experiment: String): String {
        synchronized(lock) {
            if (pendingFlag) return "control"
            if (config.experiment(experiment) == null) {
                warnUnknown(experiment)
                return "control"
            }
        }
        val key = peekVariant(experiment)
        exposure(experiment)
        return key
    }

    /** The payload of a `value` experiment (parsed JSON: Map, List, String, Long, Double, Boolean, null) and an exposure. */
    fun value(experiment: String): Any? {
        synchronized(lock) {
            if (pendingFlag) return null
            if (config.experiment(experiment) == null) {
                warnUnknown(experiment)
                return null
            }
        }
        val v = peekValue(experiment)
        exposure(experiment)
        return v
    }

    /** [value] as JSON text, for your own parser. */
    fun valueJson(experiment: String): String? = value(experiment)?.let { Json.write(it) }

    /** Record that the visitor saw the experiment (once per variant per session). The Compose helpers call it. */
    fun exposure(experiment: String) {
        if (options.disabled) return
        synchronized(lock) {
            if (closed) return
            val now = clock()
            if (pendingFlag) {
                if (waiting.none { it.first == experiment }) waiting.add(experiment to now)
                return
            }
            sendExposureLocked(experiment, now)
        }
    }

    /**
     * An event, any name (`track("signup")`, `track("Video Played", mapOf("id" to 7))`): one row for the
     * analytics property that also converts the experiments whose goal it is. Without a property it is sent as a goal.
     */
    @JvmOverloads
    fun track(name: String, props: Map<String, Any?>? = null) {
        if (options.disabled) return
        val ts = clock()
        val p = fitProps(props, "event \"$name\"")
        synchronized(lock) {
            if (closed) return
            val who = whoLocked()
            if (pendingFlag) afterReady.add { sendTrackedLocked(name, p, ts, who) } else sendTrackedLocked(name, p, ts, who)
        }
    }

    /**
     * A screen view: a `page` event with url `/<name>` (a name starting with `/` is used as is) and the
     * name as title. Pageview goals match that url. `props` are accepted for parity with the other SDKs;
     * page events carry none on the wire today, so they are not sent.
     */
    @JvmOverloads
    fun screen(name: String, @Suppress("UNUSED_PARAMETER") props: Map<String, Any?>? = null) {
        val clean = name.trim()
        if (clean.isEmpty()) {
            warn("screen() needs a name.")
            return
        }
        val url = (if (clean.startsWith("/")) clean else "/$clean").take(512)
        val ts = clock()
        synchronized(lock) {
            if (closed) return
            currentScreen = url
            if (options.disabled) return
            val who = whoLocked()
            val title = clean.take(200)
            if (pendingFlag) afterReady.add { sendPageLocked(url, title, ts, who) } else sendPageLocked(url, title, ts, who)
        }
    }

    /**
     * Ties this visitor to your user id (1..128 characters) with optional flat traits (`mapOf("plan" to "pro")`).
     * Remembered across launches and re-sent once per session; `null` forgets it.
     */
    @JvmOverloads
    fun identify(userId: String?, traits: Map<String, Any?>? = null) {
        if (userId == null) {
            safeRemove(UID_KEY)
            synchronized(lock) { sentIdentity = null }
            return
        }
        val id = userId.trim()
        if (id.isEmpty() || id.length > 128) {
            warn("identify() needs a user id of 1 to 128 characters.")
            return
        }
        safeSet(UID_KEY, id)
        if (options.disabled) return
        val t = cleanTraits(traits)
        val ts = clock()
        synchronized(lock) {
            if (closed) return
            sendIdentifyLocked(id, t, ts, whoLocked())
        }
    }

    /** Log out: forget the user id and start over as a new visitor with a new session. Queued events keep their old ids. */
    fun reset() {
        safeRemove(UID_KEY)
        synchronized(lock) {
            sentIdentity = null
            visitor = Ids.newVisitorId()
            safeSet(VISITOR_KEY, visitor)
            newVisitor = true
            session = Ids.newSessionId()
            exposed.clear()
            lastPage = null
            ctx = contextFor(geo)
        }
        notifyListeners()
    }

    /** Send waiting events now. */
    fun flush() = queue.flush(force = true)

    /** Number of events waiting to be sent. */
    val queued: Int get() = queue.size

    /** The app went to the background: send and save the queue. */
    fun onBackground() {
        synchronized(lock) { backgroundAt = clock() }
        queue.flush(force = true)
        queue.persistNow()
    }

    /** The app came back: a new session after the timeout (with the latest overrides), otherwise a quiet refresh of the cache. */
    fun onForeground() {
        var rotated = false
        synchronized(lock) {
            if (closed) return
            val bg = backgroundAt
            backgroundAt = null
            if (bg != null && clock() - bg >= options.sessionTimeoutMs) {
                session = Ids.newSessionId()
                exposed.clear()
                sentIdentity = null
                lastPage = null
                newVisitor = false
                ctx = contextFor(geo)
                refreshLocked(applyCache = true, initial = false)
                rotated = true
            } else {
                refreshLocked(applyCache = false, initial = false)
            }
        }
        if (rotated) notifyListeners()
    }

    /** Called when experiments are decided, on a new session and on [reset]. Returns a function that unsubscribes. */
    fun addListener(listener: () -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    /** Runs [callback] (through [ClientOptions.dispatch]) once experiments are decided; at once when they are. */
    fun whenReady(callback: () -> Unit) {
        val now = synchronized(lock) {
            if (pendingFlag) {
                readyCallbacks.add(callback)
                false
            } else {
                true
            }
        }
        if (now) options.dispatch(Runnable { callback() })
    }

    /** Blocks until experiments are decided or [timeoutMs] passes. Never call it on the main thread. */
    fun awaitReady(timeoutMs: Long): Boolean {
        val latch = synchronized(lock) { readyLatch }
        return latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    }

    /** Saves the queue and stops the timers. Events pushed afterwards are ignored. */
    fun close() {
        synchronized(lock) { closed = true }
        queue.close()
        if (ownScheduler) scheduler.shutdown()
        if (ownIo) (io as? java.util.concurrent.ExecutorService)?.shutdown()
    }

    // ---------------------------------------------------------------------------------------
    // Overrides
    // ---------------------------------------------------------------------------------------

    private val cacheKey get() = "$REMOTE_CACHE_KEY:${options.publicKey}"

    private fun readCache(): Pair<Long, RemoteOverrides>? {
        val m = Json.parseOrNull(safeGet(cacheKey)).asObj() ?: return null
        val fetchedAt = m.num("fetchedAt")?.toLong() ?: return null
        val o = Overrides.parse(m["overrides"]) ?: return null
        return fetchedAt to o
    }

    private fun writeCache(body: String) {
        safeSet(cacheKey, "{\"fetchedAt\":${clock()},\"overrides\":${body.trim()}}")
    }

    private fun contextFor(g: Geo?): TargetingContext =
        TargetingContext(country = g?.country, region = g?.region, city = g?.city, timezone = g?.timezone)
            .with(TargetingContext(visitor = if (newVisitor) "new" else "returning"))
            // The device's own time zone beats the one guessed from the IP.
            .with(options.context)

    private fun applyLocked(o: RemoteOverrides) {
        config = Overrides.apply(SplitHubConfig.EMPTY, o)
        propConfig = config
        geo = o.ctx
        ctx = contextFor(geo)
    }

    /**
     * Cached overrides apply synchronously (no flicker) and stale ones are fetched for the next
     * session. A first launch has no cache: experiments wait up to `waitMs` for the fetch, then decide once.
     */
    private fun refreshLocked(applyCache: Boolean, initial: Boolean) {
        val cached = readCache()
        if (cached != null && applyCache) {
            applyLocked(cached.second)
            debug("overrides v${Json.number(cached.second.version)} from cache, ${(clock() - cached.first) / 1000} s old")
        }
        val stale = cached == null || clock() - cached.first > options.ttlMs
        if (!stale || options.remoteDisabled || fetching) return
        val wait = initial && cached == null && options.waitMs > 0
        if (wait) {
            pendingFlag = true
            readyLatch = CountDownLatch(1)
        }
        if (wanted != null && !knownLocked()) startPropertyWaitLocked()
        fetching = true
        if (wait) scheduler.schedule(Runnable { decide(null, timedOut = true) }, options.waitMs, TimeUnit.MILLISECONDS)
        io.execute { fetchOverrides() }
    }

    private fun fetchOverrides() {
        val url = options.overridesUrl ?: Overrides.resolveUrl(options.endpoint, options.publicKey)
        var fresh: RemoteOverrides? = null
        try {
            val res = options.http.get(url, mapOf("cache-control" to "no-cache"))
            if (res.status == 200) {
                fresh = Overrides.parseText(res.body)
                if (fresh != null) writeCache(res.body)
            } else {
                debug("overrides answered ${res.status}")
            }
        } catch (e: Exception) {
            debug("overrides not fetched: ${e.message}")
        }
        synchronized(lock) { fetching = false }
        decide(fresh, timedOut = false)
        synchronized(lock) {
            if (propertyFetching) {
                if (fresh != null) propConfig = Overrides.apply(SplitHubConfig.EMPTY, fresh)
                releasePropertyLocked()
            }
        }
    }

    private fun decide(fresh: RemoteOverrides?, timedOut: Boolean) {
        var callbacks: List<() -> Unit> = emptyList()
        var latch: CountDownLatch? = null
        synchronized(lock) {
            if (!pendingFlag) return
            if (fresh != null) {
                applyLocked(fresh)
                debug("first launch: overrides v${Json.number(fresh.version)} arrived, experiments decided")
            } else {
                debug(if (timedOut) "first launch: overrides did not arrive in ${options.waitMs} ms; every experiment shows its control this session" else "first launch: overrides not available; every experiment shows its control this session")
            }
            pendingFlag = false
            // Exposures first: a goal only converts a visitor already in the experiment.
            for ((exp, ts) in waiting) sendExposureLocked(exp, ts)
            waiting.clear()
            val tasks = ArrayList(afterReady)
            afterReady.clear()
            for (t in tasks) t()
            callbacks = ArrayList(readyCallbacks)
            readyCallbacks.clear()
            latch = readyLatch
        }
        for (c in callbacks) options.dispatch(Runnable { c() })
        notifyListeners()
        // Last, so whoever waits sees the listeners already called (when dispatch runs them in place).
        latch?.countDown()
    }

    // ---------------------------------------------------------------------------------------
    // Analytics property: events wait while overrides that may declare it are on their way
    // ---------------------------------------------------------------------------------------

    private fun knownLocked(): Boolean = wanted != null && propConfig.properties.any { it.key == wanted }

    private fun propertyLocked(): String? =
        propConfig.properties.firstOrNull { it.key == wanted }?.takeIf { it.status == "running" }?.key

    private fun startPropertyWaitLocked() {
        if (propertyFetching) return
        propertyFetching = true
        val id = ++propertyWaitId
        scheduler.schedule(Runnable {
            synchronized(lock) { if (propertyFetching && propertyWaitId == id) releasePropertyLocked() }
        }, PROPERTY_WAIT_MS, TimeUnit.MILLISECONDS)
    }

    private fun releasePropertyLocked() {
        propertyFetching = false
        if (wanted != null && !knownLocked()) {
            warn("property \"$wanted\" is not in this project, so no screens or events are sent for it. Check the id in the dashboard (it looks like sh-x1h78w).")
        }
        val tasks = ArrayList(propertyWaiting)
        propertyWaiting.clear()
        for (t in tasks) t()
    }

    private fun withPropertyLocked(send: () -> Unit) {
        if (wanted == null) return
        if (!knownLocked() && propertyFetching) {
            propertyWaiting.add(send)
            return
        }
        send()
    }

    // ---------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------

    private fun whoLocked() = Who(visitor, session, currentScreen)

    private fun assignmentLocked(experiment: String): Assignment {
        if (pendingFlag) return Assignment(experiment, null, Reason.PENDING)
        return Assign.assign(config, experiment, visitor, options.forcedVariants, ctx)
    }

    /** The cloud refuses a project with nothing running; sending anyway only produces errors. */
    private fun cloudIdleLocked(): Boolean =
        config.experiments.none { it.status == "running" } && config.properties.none { it.status == "running" }

    private fun event(prefix: String, type: String): LinkedHashMap<String, Any?> {
        val m = LinkedHashMap<String, Any?>()
        m["id"] = Ids.newId(prefix, clock())
        m["type"] = type
        return m
    }

    private fun LinkedHashMap<String, Any?>.who(who: Who, ts: Long): LinkedHashMap<String, Any?> {
        this["vid"] = who.vid
        this["sid"] = who.sid
        this["ts"] = ts
        return this
    }

    private fun pushLocked(e: Map<String, Any?>, line: String) {
        if (closed) return
        debug(line)
        queue.push(e)
    }

    private fun sendExposureLocked(experiment: String, ts: Long) {
        val a = assignmentLocked(experiment)
        if (config.holdout != null && Assign.countsForHoldout(a.reason)) markHoldoutLocked(ts)
        val v = a.variant ?: return
        if (a.reason == Reason.OVERRIDE) return
        if (!exposed.add("$experiment:${v.key}")) return
        val e = event("e_", "exposure")
        e["exp"] = experiment
        e["var"] = v.key
        e.who(whoLocked(), ts)
        currentScreen?.let { e["url"] = it }
        pushLocked(e, "exposure $experiment / ${v.key}")
    }

    /** One `__holdout` exposure per visitor and session the first time they reach a running experiment. */
    private fun markHoldoutLocked(ts: Long) {
        val group = Assign.holdoutGroup(config, visitor) ?: return
        if (!exposed.add("${Assign.HOLDOUT_KEY}:$group")) return
        val e = event("e_", "exposure")
        e["exp"] = Assign.HOLDOUT_KEY
        e["var"] = group
        e.who(whoLocked(), ts)
        currentScreen?.let { e["url"] = it }
        pushLocked(e, "exposure ${Assign.HOLDOUT_KEY} / $group")
    }

    private fun sendGoalLocked(name: String, props: Map<String, Any?>?, ts: Long, who: Who) {
        // Resolved now, not when tracked: the overrides may have brought goals from the dashboard.
        val goal = Goals.goalKeyFor(config.goals, name) ?: return
        if (cloudIdleLocked()) {
            debug("goal $goal not sent: nothing is running in this project yet")
            return
        }
        val e = event("g_", "goal")
        e["goal"] = goal
        e.who(who, ts)
        who.url?.let { e["url"] = it }
        if (props != null) e["props"] = props
        pushLocked(e, "goal $goal")
    }

    private fun sendTrackedLocked(name: String, props: Map<String, Any?>?, ts: Long, who: Who) {
        if (wanted == null) {
            sendGoalLocked(name, props, ts, who)
            return
        }
        if (!Goals.EVENT_NAME_PATTERN.matches(name)) {
            warn("event name \"$name\" is invalid: letters, digits, spaces and \"_ . : / -\", up to 64 characters.")
            sendGoalLocked(name, props, ts, who)
            return
        }
        withPropertyLocked {
            val prop = propertyLocked()
            if (prop == null) {
                sendGoalLocked(name, props, ts, who)
            } else {
                val e = event("v_", "event")
                e["prop"] = prop
                e["name"] = name
                e.who(who, ts)
                who.url?.let { e["url"] = it }
                if (props != null) e["props"] = props
                pushLocked(e, "$prop: event $name")
            }
        }
    }

    private fun sendPageGoalsLocked(path: String, ts: Long, who: Who) {
        for (goal in config.goals) {
            if (goal.type == "pageview" && goal.path != null && Goals.matchPath(goal.path, path)) sendGoalLocked(goal.key, null, ts, who)
        }
    }

    private fun sendPageLocked(url: String, title: String, ts: Long, who: Who) {
        val path = url.substringBefore('?')
        if (wanted == null) {
            sendPageGoalsLocked(path, ts, who)
            return
        }
        withPropertyLocked {
            val prop = propertyLocked()
            if (prop == null) {
                sendPageGoalsLocked(path, ts, who)
            } else {
                val last = lastPage
                // The same screen reported twice in a row (a recomposition, two hooks) counts once.
                if (last == null || last.first != url || ts - last.second >= 1000) {
                    lastPage = url to ts
                    val e = event("p_", "page")
                    e["prop"] = prop
                    e.who(who, ts)
                    e["url"] = url
                    if (title.isNotEmpty()) e["title"] = title
                    pushLocked(e, "$prop: screen $url")
                    resendIdentityLocked(ts, who)
                }
            }
        }
    }

    private fun sendIdentifyLocked(uid: String, traits: Map<String, Any?>?, ts: Long, who: Who) {
        if (wanted == null) return
        val mark = "$uid\n${if (traits != null) Json.write(traits) else ""}"
        withPropertyLocked {
            val prop = propertyLocked()
            if (prop != null && sentIdentity != mark) {
                sentIdentity = mark
                val e = event("i_", "identify")
                e["prop"] = prop
                e.who(who, ts)
                e["uid"] = uid
                if (traits != null) e["traits"] = traits
                pushLocked(e, "$prop: identify $uid")
            }
        }
    }

    /** A returning user's id goes out once in each new session, with its first screen. */
    private fun resendIdentityLocked(ts: Long, who: Who) {
        val uid = safeGet(UID_KEY) ?: return
        if (!(sentIdentity ?: "").startsWith("$uid\n")) sendIdentifyLocked(uid, null, ts, who)
    }

    // ---------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------

    private fun notifyListeners() {
        for (l in listeners) options.dispatch(Runnable { l() })
    }

    /** Props as the ingest takes them: at most 4 KB of JSON. Larger ones keep `revenue` and the plain values that fit. */
    private fun fitProps(props: Map<String, Any?>?, what: String): Map<String, Any?>? {
        if (props == null) return null
        val copy = LinkedHashMap(props)
        if (Json.write(copy).length <= MAX_PROPS_BYTES) return copy
        val out = LinkedHashMap<String, Any?>()
        var size = 2
        val entries = copy.entries.sortedBy { if (it.key == "revenue") 0 else 1 }
        for ((k, v) in entries) {
            if (v is Map<*, *> || v is Iterable<*> || v is Array<*>) continue
            val part = Json.write(mapOf(k to v)).length - 1
            if (size + part > MAX_PROPS_BYTES) continue
            out[k] = v
            size += part
        }
        warn("$what: props are larger than 4 KB, so ${if (out.isEmpty()) "none went out" else "only ${out.keys.joinToString(", ")} went out"}.")
        return out.ifEmpty { null }
    }

    /** Flat traits (text, numbers, true/false) up to 4 KB; anything else is left out. */
    private fun cleanTraits(traits: Map<String, Any?>?): Map<String, Any?>? {
        if (traits == null) return null
        val out = LinkedHashMap<String, Any?>()
        var size = 2
        var skipped = false
        for ((key, value) in traits) {
            val plain = value is String || value is Boolean ||
                (value is Number && !(value is Double && (value.isNaN() || value.isInfinite())) && !(value is Float && (value.isNaN() || value.isInfinite())))
            if (!plain || key.length > 64) {
                if (value != null) skipped = true
                continue
            }
            val v: Any? = if (value is String) value.take(256) else value
            val part = Json.write(mapOf(key to v)).length - 1
            if (size + part > MAX_PROPS_BYTES) {
                skipped = true
                continue
            }
            out[key] = v
            size += part
        }
        if (skipped) warn("identify(): traits keep text, numbers and true/false up to 4 KB; the rest was left out.")
        return out.ifEmpty { null }
    }

    private fun warnUnknown(experiment: String) =
        warn("experiment \"$experiment\" is not in this project (or not running yet in the dashboard); showing the control.")

    private fun warn(message: String) {
        val first = synchronized(warned) { warned.add(message) }
        if (first) options.logger?.warn("[splithub] $message")
    }

    private fun debug(message: String) {
        options.logger?.debug("[splithub] $message")
    }

    private fun safeGet(key: String): String? = try {
        storage.getItem(key)
    } catch (e: Exception) {
        null
    }

    private fun safeSet(key: String, value: String) {
        try {
            storage.setItem(key, value)
        } catch (e: Exception) {
            debug("storage write failed: ${e.message}")
        }
    }

    private fun safeRemove(key: String) {
        try {
            storage.removeItem(key)
        } catch (e: Exception) {
            debug("storage write failed: ${e.message}")
        }
    }
}
