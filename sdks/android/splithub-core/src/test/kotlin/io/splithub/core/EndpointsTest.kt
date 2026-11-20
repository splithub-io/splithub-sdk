package io.splithub.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

class EndpointsTest {
    private val backup = CloudEndpoints.BACKUPS[0]

    @Test
    fun ordersAnnouncedDefaultBackupAndSkipsTheLapsedAddress() {
        assertTrue(CloudEndpoints.isCloud("https://go.splithub.io/v1/events"))
        assertFalse(CloudEndpoints.isCloud("https://mine.example/v1/events"))
        assertEquals(
            listOf("https://go.moved.example/v1/events", SplitHubClient.DEFAULT_ENDPOINT, backup),
            CloudEndpoints.list("https://go.moved.example/v1/events", "https://go.splithub.io/v1/events"),
        )
        assertEquals(listOf(SplitHubClient.DEFAULT_ENDPOINT, backup), CloudEndpoints.list("http://insecure/v1/events", SplitHubClient.DEFAULT_ENDPOINT))
    }

    /** The default host does not resolve; the backup answers and announces a new address. */
    private class MovedHttp : HttpClient {
        val posts = CopyOnWriteArrayList<String>()
        override fun post(url: String, headers: Map<String, String>, body: String): Int {
            if (url.startsWith("https://go.sh2.uk")) throw IOException("unknown host")
            posts.add(url)
            return 202
        }

        override fun get(url: String, headers: Map<String, String>): HttpResponse {
            if (url.startsWith("https://go.sh2.uk")) throw IOException("unknown host")
            return HttpResponse(
                200,
                """{"version":1,"experiments":{},"addedProperties":[{"key":"sh-app","status":"running","kind":"app","goals":[]}],"endpoint":"https://go.moved.example/v1/events"}""",
            )
        }
    }

    @Test
    fun movesToTheBackupAndRemembersTheAnnouncedAddress() {
        val storage = MemoryStorage()
        val http = MovedHttp()
        val scheduler = Executors.newSingleThreadScheduledExecutor()
        val c = SplitHubClient(ClientOptions(publicKey = "pk_test", property = "sh-app", storage = storage, http = http, waitMs = 0, scheduler = scheduler, io = DirectExecutor))
        c.track("opened")
        c.flush()
        assertEquals(backup, http.posts.first())
        assertEquals("https://go.moved.example/v1/events", storage.getItem(CloudEndpoints.STORAGE_KEY))
        c.close()
        scheduler.shutdownNow()
    }
}
