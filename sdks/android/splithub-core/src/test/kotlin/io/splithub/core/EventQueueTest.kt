package io.splithub.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.concurrent.Executors

class EventQueueTest {
    private val scheduler = Executors.newSingleThreadScheduledExecutor()

    @After
    fun stop() {
        scheduler.shutdownNow()
    }

    private fun queue(http: FakeHttp, storage: KeyValueStorage = MemoryStorage(), maxAttempts: Int = 5) = EventQueue(
        project = "app",
        sdk = "android/test",
        app = AppInfo(platform = "android", id = "com.acme.shop", version = "2.4.1", device = "mobile"),
        endpoint = "https://go.test/v1/events",
        key = "pk_test",
        http = http,
        storage = storage,
        scheduler = scheduler,
        io = DirectExecutor,
        flushIntervalMs = 60_000,
        maxAttempts = maxAttempts,
    )

    private fun event(n: Int) = linkedMapOf<String, Any?>("id" to "g_test0000$n", "type" to "goal", "goal" to "signup", "vid" to "v_1", "sid" to "s_1", "ts" to 1L)

    @Test
    fun sendsTheWireFormat() {
        val http = FakeHttp()
        val q = queue(http)
        q.push(event(1))
        q.flush(force = true)
        assertEquals(1, http.posts.size)
        assertEquals(
            """{"project":"app","sdk":"android/test","events":[{"id":"g_test00001","type":"goal","goal":"signup","vid":"v_1","sid":"s_1","ts":1}],"app":{"platform":"android","id":"com.acme.shop","version":"2.4.1","device":"mobile"}}""",
            http.posts[0],
        )
        assertEquals("Bearer pk_test", http.headers[0]["authorization"])
        assertEquals(0, q.size)
    }

    @Test
    fun offlineKeepsEverything() {
        val http = FakeHttp(null, -1, -1, -1, -1, -1, -1, -1)
        val q = queue(http, maxAttempts = 2)
        q.push(event(1))
        repeat(7) { q.flush(force = true) }
        assertEquals(1, q.size)
        q.flush(force = true)
        assertEquals(0, q.size)
        assertEquals(1, http.posts.size)
    }

    @Test
    fun refusalDropsAtOnce() {
        val http = FakeHttp(null, 400)
        val q = queue(http)
        q.push(event(1))
        q.flush(force = true)
        assertEquals(0, q.size)
    }

    @Test
    fun serverErrorsDropAfterTheAttempts() {
        val http = FakeHttp(null, 500, 429, 503)
        val q = queue(http, maxAttempts = 3)
        q.push(event(1))
        q.flush(force = true)
        q.flush(force = true)
        assertEquals(1, q.size)
        q.flush(force = true)
        assertEquals(0, q.size)
    }

    @Test
    fun persistsAndReloads() {
        val storage = MemoryStorage()
        val offline = FakeHttp(null, -1)
        val q = queue(offline, storage)
        q.push(event(1))
        q.push(event(2))
        q.flush(force = true)
        q.persistNow()
        val http = FakeHttp()
        val reloaded = queue(http, storage)
        assertEquals(2, reloaded.size)
        reloaded.flush(force = true)
        assertEquals(listOf("g_test00001", "g_test00002"), http.events().map { it["id"] })
    }
}
