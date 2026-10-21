package io.splithub.core

import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/**
 * Synchronous key-value storage (SharedPreferences on Android), so assignment stays
 * synchronous: visitor id, user id, cached overrides, the offline queue.
 */
interface KeyValueStorage {
    fun getItem(key: String): String?
    fun setItem(key: String, value: String)
    fun removeItem(key: String)
}

class MemoryStorage : KeyValueStorage {
    private val map = ConcurrentHashMap<String, String>()
    override fun getItem(key: String): String? = map[key]
    override fun setItem(key: String, value: String) {
        map[key] = value
    }
    override fun removeItem(key: String) {
        map.remove(key)
    }
}

data class HttpResponse(val status: Int, val body: String)

/** The two requests the SDK makes. Throws [IOException] when the network fails (no answer at all). */
interface HttpClient {
    @Throws(IOException::class)
    fun post(url: String, headers: Map<String, String>, body: String): Int

    @Throws(IOException::class)
    fun get(url: String, headers: Map<String, String> = emptyMap()): HttpResponse
}

/** HttpURLConnection: in every Android version and every JVM, no library. Call it off the main thread. */
class UrlConnectionHttpClient(
    private val connectTimeoutMs: Int = 10_000,
    private val readTimeoutMs: Int = 10_000,
) : HttpClient {
    override fun post(url: String, headers: Map<String, String>, body: String): Int {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val conn = open(url, headers)
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.outputStream.use { it.write(bytes) }
            val status = conn.responseCode
            drain(if (status >= 400) conn.errorStream else conn.inputStream)
            return status
        } finally {
            conn.disconnect()
        }
    }

    override fun get(url: String, headers: Map<String, String>): HttpResponse {
        val conn = open(url, headers)
        try {
            conn.requestMethod = "GET"
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            return HttpResponse(status, text)
        } finally {
            conn.disconnect()
        }
    }

    @Suppress("DEPRECATION") // URL(String) is deprecated on JDK 20+, not on Android.
    private fun open(url: String, headers: Map<String, String>): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = connectTimeoutMs
        conn.readTimeout = readTimeoutMs
        conn.useCaches = false
        for ((k, v) in headers) conn.setRequestProperty(k, v)
        return conn
    }

    // Reading the answer lets the connection be reused.
    private fun drain(stream: InputStream?) {
        try {
            stream?.use { s ->
                val buf = ByteArray(1024)
                while (s.read(buf) >= 0) Unit
            }
        } catch (e: IOException) {
            // the status is all we need
        }
    }
}
