package io.splithub.core

import java.io.IOException
import java.util.concurrent.Executor
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/**
 * Batches events and sends them every [flushIntervalMs], when [maxBatch] are waiting, and
 * when the app goes to the background. Persisted under `sh_queue` (at most [maxQueue],
 * the oldest go first), so a killed process or an offline phone loses nothing.
 *
 * - No answer (offline, timeout): retried with backoff, never dropped.
 * - 5xx, 408, 429: retried with backoff, dropped after [maxAttempts].
 * - Any other 4xx is a refusal (bad key, invalid batch): dropped at once, retrying cannot help.
 */
class EventQueue(
    private val project: String,
    private val sdk: String,
    private val app: AppInfo?,
    private val endpoint: String,
    private val key: String?,
    private val http: HttpClient,
    private val storage: KeyValueStorage?,
    private val scheduler: ScheduledExecutorService,
    private val io: Executor,
    private val clock: () -> Long = System::currentTimeMillis,
    private val maxBatch: Int = 20,
    private val flushIntervalMs: Long = 2_000,
    private val maxQueue: Int = 1_000,
    private val maxAttempts: Int = 5,
    private val onError: ((String) -> Unit)? = null,
    private val random: Random = Random.Default,
) {
    companion object {
        const val STORAGE_KEY = "sh_queue"
        /** The ingest takes at most 500 events per batch. */
        const val MAX_SEND = 100
        private const val MAX_BACKOFF_MS = 30_000L
        private const val PERSIST_DELAY_MS = 500L
    }

    private class Item(val seq: Long, val json: String)

    private val lock = Any()
    private val items = ArrayList<Item>()
    private var nextSeq = 0L
    private var sending = false
    private var attempts = 0
    private var failures = 0
    private var backoffUntil = 0L
    private var timer: ScheduledFuture<*>? = null
    private var persistTimer: ScheduledFuture<*>? = null
    private var closed = false

    init {
        load()
    }

    val size: Int get() = synchronized(lock) { items.size }

    fun push(event: Map<String, Any?>) = pushJson(Json.write(event))

    fun pushJson(json: String) {
        synchronized(lock) {
            items.add(Item(nextSeq++, json))
            if (items.size > maxQueue) items.subList(0, items.size - maxQueue).clear()
            persistSoonLocked()
            val now = clock()
            val waiting = now < backoffUntil
            if (!waiting && items.size >= maxBatch) startSendLocked()
            else scheduleLocked(if (waiting) backoffUntil - now else flushIntervalMs)
        }
    }

    /** Send what is waiting now. `force` skips the backoff (the app is going to the background). */
    @JvmOverloads
    fun flush(force: Boolean = false) {
        synchronized(lock) {
            if (force) backoffUntil = 0
            cancelTimerLocked()
            startSendLocked()
        }
    }

    /** Write the queue to storage now (the process may be killed in the background). */
    fun persistNow() {
        val text = synchronized(lock) {
            persistTimer?.cancel(false)
            persistTimer = null
            if (items.isEmpty()) null else items.joinToString(",", "[", "]") { it.json }
        }
        try {
            if (text == null) storage?.removeItem(STORAGE_KEY) else storage?.setItem(STORAGE_KEY, text)
        } catch (e: Exception) {
            onError?.invoke("could not save the event queue: ${e.message}")
        }
    }

    fun close() {
        synchronized(lock) {
            closed = true
            cancelTimerLocked()
        }
        persistNow()
    }

    private fun load() {
        val raw = try {
            storage?.getItem(STORAGE_KEY)
        } catch (e: Exception) {
            null
        } ?: return
        val list = Json.parseOrNull(raw).asJsonList() ?: return
        for (e in list.takeLast(maxQueue)) {
            if (e.asObj() != null) items.add(Item(nextSeq++, Json.write(e)))
        }
        if (items.isNotEmpty()) scheduleLocked(flushIntervalMs)
    }

    private fun persistSoonLocked() {
        if (persistTimer != null || storage == null || closed) return
        persistTimer = scheduler.schedule(Runnable { persistNow() }, PERSIST_DELAY_MS, TimeUnit.MILLISECONDS)
    }

    private fun cancelTimerLocked() {
        timer?.cancel(false)
        timer = null
    }

    private fun scheduleLocked(delayMs: Long) {
        if (timer != null || closed) return
        timer = scheduler.schedule(Runnable {
            synchronized(lock) {
                timer = null
                startSendLocked()
            }
        }, maxOf(0L, delayMs), TimeUnit.MILLISECONDS)
    }

    private fun startSendLocked() {
        if (sending || items.isEmpty() || closed) return
        val now = clock()
        if (now < backoffUntil) {
            scheduleLocked(backoffUntil - now)
            return
        }
        sending = true
        val batch = ArrayList(items.subList(0, minOf(items.size, MAX_SEND)))
        io.execute { send(batch) }
    }

    private fun body(batch: List<Item>): String {
        val sb = StringBuilder(256 + batch.size * 200)
        sb.append("{\"project\":")
        Json.writeTo(sb, project)
        sb.append(",\"sdk\":")
        Json.writeTo(sb, sdk)
        sb.append(",\"events\":[")
        batch.forEachIndexed { i, item ->
            if (i > 0) sb.append(',')
            sb.append(item.json)
        }
        sb.append(']')
        if (app != null) {
            sb.append(",\"app\":")
            Json.writeTo(sb, app.toJson())
        }
        sb.append('}')
        return sb.toString()
    }

    private sealed class Outcome {
        object Sent : Outcome()
        class Refused(val status: Int) : Outcome()
        class Failed(val status: Int) : Outcome()
        class Offline(val message: String?) : Outcome()
    }

    private fun send(batch: List<Item>) {
        val headers = LinkedHashMap<String, String>()
        headers["content-type"] = "application/json"
        if (key != null) headers["authorization"] = "Bearer $key"
        val outcome = try {
            val status = http.post(endpoint, headers, body(batch))
            when {
                status in 200..299 -> Outcome.Sent
                status in 400..499 && status != 408 && status != 429 -> Outcome.Refused(status)
                else -> Outcome.Failed(status)
            }
        } catch (e: IOException) {
            Outcome.Offline(e.message)
        } catch (e: RuntimeException) {
            // A broken URL or a security exception: as good as offline, the events stay.
            Outcome.Offline(e.message)
        }
        synchronized(lock) {
            sending = false
            when (outcome) {
                is Outcome.Sent -> {
                    remove(batch)
                    attempts = 0
                    failures = 0
                    backoffUntil = 0
                }
                is Outcome.Refused -> {
                    remove(batch)
                    attempts = 0
                    failures = 0
                    backoffUntil = 0
                    onError?.invoke("ingest refused ${batch.size} events (${outcome.status}); they were dropped")
                }
                is Outcome.Failed -> {
                    attempts += 1
                    failures += 1
                    if (attempts >= maxAttempts) {
                        remove(batch)
                        attempts = 0
                        failures = 0
                        backoffUntil = 0
                        onError?.invoke("ingest answered ${outcome.status} $maxAttempts times; ${batch.size} events were dropped")
                    } else {
                        backoffLocked()
                    }
                }
                is Outcome.Offline -> {
                    failures += 1
                    backoffLocked()
                }
            }
            persistSoonLocked()
            if (items.isNotEmpty() && backoffUntil == 0L) {
                if (items.size >= maxBatch) startSendLocked() else scheduleLocked(flushIntervalMs)
            }
        }
    }

    private fun remove(batch: List<Item>) {
        val seqs = batch.mapTo(HashSet()) { it.seq }
        items.removeAll { it.seq in seqs }
    }

    private fun backoffLocked() {
        val exp = minOf(failures - 1, 15)
        val base = minOf(MAX_BACKOFF_MS, 1000L shl exp)
        val delay = base / 2 + (random.nextDouble() * (base / 2)).toLong()
        backoffUntil = clock() + delay
        cancelTimerLocked()
        scheduleLocked(delay)
    }
}
