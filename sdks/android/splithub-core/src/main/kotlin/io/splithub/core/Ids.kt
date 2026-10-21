package io.splithub.core

import java.security.SecureRandom

/** Event, visitor and session ids in the format of @splithub/core: prefix + 9 time chars + 11 random chars, base 36. */
object Ids {
    private const val ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"
    private val random = SecureRandom()

    @JvmStatic
    @JvmOverloads
    fun newId(prefix: String = "", now: Long = System.currentTimeMillis()): String {
        val time = java.lang.Long.toString(now, 36).padStart(9, '0')
        val bytes = ByteArray(11)
        synchronized(random) { random.nextBytes(bytes) }
        val sb = StringBuilder(prefix.length + 20).append(prefix).append(time)
        for (b in bytes) sb.append(ALPHABET[(b.toInt() and 0xff) % 36])
        return sb.toString()
    }

    @JvmStatic
    fun newVisitorId(): String = newId("v_")

    @JvmStatic
    fun newSessionId(): String = newId("s_")
}
