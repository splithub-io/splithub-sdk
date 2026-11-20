package io.splithub.core

import java.net.URI

/**
 * The cloud's address can change after an app has shipped (splithub.io lapsed in November 2026
 * and took every hard-coded `go.splithub.io` with it). So the client keeps a short list instead of
 * one URL: the address the cloud last announced (`endpoint` in the overrides, kept in storage),
 * the configured endpoint, the default, and a backup on workers.dev, which belongs to no domain
 * that can lapse. Only a request with no answer moves to the next one. A custom endpoint (a
 * staging cloud, your own proxy) is used as written.
 */
object CloudEndpoints {
    const val STORAGE_KEY = "sh_endpoint"

    @JvmField
    val BACKUPS: List<String> = listOf("https://splithub-go.adbro.workers.dev/v1/events")

    /** Earlier cloud addresses: an app that still passes one counts as on the cloud, and it is skipped. */
    private val PAST: List<String> = listOf("https://go.splithub.io/v1/events")

    private fun trim(s: String) = s.trimEnd('/')

    /** An `https://…/v1/events` URL, the only shape the cloud may announce. */
    @JvmStatic
    fun isEndpointUrl(value: String?): Boolean {
        if (value == null || value.length > 200) return false
        return try {
            val u = URI(value)
            u.scheme == "https" && !u.host.isNullOrEmpty() && u.rawQuery == null && u.rawFragment == null && trim(u.path ?: "").endsWith("/v1/events")
        } catch (e: Exception) {
            false
        }
    }

    @JvmStatic
    fun isCloud(endpoint: String): Boolean {
        val e = trim(endpoint)
        return e == trim(SplitHubClient.DEFAULT_ENDPOINT) || BACKUPS.any { trim(it) == e } || PAST.contains(e)
    }

    /** Addresses in the order to try them: announced, configured (unless a past one), default, backups. */
    @JvmStatic
    fun list(remembered: String?, configured: String): List<String> {
        val own = if (PAST.contains(trim(configured))) null else configured
        val out = ArrayList<String>()
        for (c in listOf(remembered?.takeIf { isEndpointUrl(it) }, own, SplitHubClient.DEFAULT_ENDPOINT) + BACKUPS) {
            if (c != null && out.none { trim(it) == trim(c) }) out.add(trim(c))
        }
        return out
    }
}
