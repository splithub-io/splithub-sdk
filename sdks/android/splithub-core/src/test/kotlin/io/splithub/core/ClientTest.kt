package io.splithub.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class ClientTest {
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private var now = 1_791_819_000_000L

    @After
    fun stop() {
        scheduler.shutdownNow()
    }

    private val overrides = """
        {
          "version": 1,
          "experiments": {},
          "added": [
            { "key": "hero", "kind": "component", "status": "running", "traffic": 1, "goal": "signup", "seed": "hero",
              "variants": [ { "key": "control", "weight": 0.5 }, { "key": "bold", "weight": 0.5 } ] },
            { "key": "price", "kind": "value", "status": "running", "traffic": 1, "goal": null, "seed": "price",
              "variants": [ { "key": "control", "weight": 0, "value": { "amount": 9 } }, { "key": "cheaper", "weight": 1, "value": { "amount": 7 } } ] }
          ],
          "addedProperties": [ { "key": "sh-app123", "status": "running", "kind": "app", "goals": [] } ],
          "ctx": { "country": "DE" }
        }
    """.trimIndent()

    private fun client(
        http: FakeHttp,
        storage: KeyValueStorage = MemoryStorage(),
        property: String? = "sh-app123",
        io: java.util.concurrent.Executor = DirectExecutor,
    ) = SplitHubClient(
        ClientOptions(
            publicKey = "pk_test",
            property = property,
            endpoint = "https://go.test/v1/events",
            storage = storage,
            sdk = "android/test",
            app = AppInfo(id = "com.acme.shop", version = "2.4.1", device = "mobile"),
            context = TargetingContext(platform = "android", appVersion = "2.4.1", device = "mobile", os = "android"),
            http = http,
            flushIntervalMs = 60_000,
            clock = { now },
            scheduler = scheduler,
            io = io,
        ),
    )

    @Test
    fun experimentsComeFromTheOverrides() {
        val http = FakeHttp(overrides)
        val c = client(http)
        assertFalse(c.isPending)
        assertEquals("https://go.test/v1/overrides/pk_test.json?all=1", http.gets.single())
        val expected = Assign.assign(c.currentConfig, "hero", c.visitorId, emptyMap(), c.context).variant!!.key
        assertEquals(expected, c.variant("hero"))
        assertEquals(mapOf("amount" to 7L), c.value("price"))
        assertEquals("""{"amount":7}""", c.valueJson("price"))
        assertEquals("control", c.variant("nope"))
        assertEquals("de", Targeting.contextValue("country", null, c.context))
        c.flush()
        val exposures = http.events().filter { it["type"] == "exposure" }
        // Once per variant per session, however often the variant is read.
        assertEquals(listOf("hero", "price"), exposures.map { it["exp"] })
        assertEquals(c.visitorId, exposures[0]["vid"])
        assertEquals(c.sessionId, exposures[0]["sid"])
    }

    @Test
    fun screensEventsAndIdentify() {
        val http = FakeHttp(overrides)
        val c = client(http)
        c.screen("Home")
        c.identify("user-1", mapOf("plan" to "pro", "nested" to mapOf("no" to 1)))
        c.track("Video Played", mapOf("id" to 7))
        c.flush()
        val events = http.events()
        assertEquals(listOf("page", "identify", "event"), events.map { it["type"] })
        assertEquals("/Home", events[0]["url"])
        assertEquals("Home", events[0]["title"])
        assertEquals("sh-app123", events[0]["prop"])
        assertEquals(mapOf("plan" to "pro"), events[1]["traits"])
        assertEquals("Video Played", events[2]["name"])
        assertEquals("/Home", events[2]["url"])
        assertEquals(mapOf("id" to 7L), events[2]["props"])
        val batch = Json.parse(http.posts[0]).asObj()!!
        assertEquals("android/test", batch["sdk"])
        assertEquals("android", batch.obj("app")!!["platform"])
    }

    @Test
    fun withoutPropertyTrackSendsAGoal() {
        val http = FakeHttp(overrides)
        val c = client(http, property = null)
        c.track("Sign Up")
        c.screen("Home")
        c.flush()
        assertEquals(listOf("goal"), http.events().map { it["type"] })
        assertEquals("sign-up", http.events()[0]["goal"])
    }

    @Test
    fun cachedOverridesApplyOnTheNextLaunch() {
        val storage = MemoryStorage()
        client(FakeHttp(overrides), storage).close()
        val offline = FakeHttp(null)
        val next = client(offline, storage)
        assertFalse(next.isPending)
        // Fresh cache: no fetch at all.
        assertTrue(offline.gets.isEmpty())
        assertEquals(2, next.currentConfig.experiments.size)
    }

    @Test
    fun visitorIdPersistsAndResetMakesANewOne() {
        val storage = MemoryStorage()
        val first = client(FakeHttp(overrides), storage)
        val vid = first.visitorId
        first.close()
        val second = client(FakeHttp(overrides), storage)
        assertEquals(vid, second.visitorId)
        assertEquals("returning", second.context.visitor)
        second.reset()
        assertNotEquals(vid, second.visitorId)
    }

    @Test
    fun sessionRotatesAfterThirtyMinutesAway() {
        val c = client(FakeHttp(overrides))
        val sid = c.sessionId
        c.onBackground()
        now += 10 * 60_000
        c.onForeground()
        assertEquals(sid, c.sessionId)
        c.onBackground()
        now += 31 * 60_000
        c.onForeground()
        assertNotEquals(sid, c.sessionId)
    }

    @Test
    fun firstLaunchWaitsForTheOverrides() {
        val release = CountDownLatch(1)
        val http = FakeHttp(overrides).apply { beforeGet = { release.await(5, TimeUnit.SECONDS) } }
        val io = Executors.newSingleThreadExecutor()
        try {
            val c = client(http, io = io)
            assertTrue(c.isPending)
            assertEquals("control", c.variant("hero"))
            c.exposure("hero")
            var heard = 0
            c.addListener { heard++ }
            release.countDown()
            assertTrue(c.awaitReady(2_000))
            assertFalse(c.isPending)
            assertEquals(1, heard)
            c.flush()
            // This test's network thread is real: wait for the batch.
            val deadline = System.currentTimeMillis() + 2_000
            while (http.posts.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(10)
            // The exposure recorded while waiting goes out with the variant decided afterwards.
            val expected = Assign.assign(c.currentConfig, "hero", c.visitorId, emptyMap(), c.context).variant!!.key
            assertEquals(listOf(expected), http.events().filter { it["exp"] == "hero" }.map { it["var"] })
        } finally {
            io.shutdownNow()
        }
    }

    @Test
    fun forcedVariantsAreShownNotCounted() {
        val http = FakeHttp(overrides)
        val c = SplitHubClient(
            ClientOptions(publicKey = "pk_test", endpoint = "https://go.test/v1/events", http = http, forcedVariants = mapOf("hero" to "bold"), scheduler = scheduler, io = DirectExecutor),
        )
        assertEquals("bold", c.variant("hero"))
        c.flush()
        assertTrue(http.events().none { it["exp"] == "hero" })
    }
}
