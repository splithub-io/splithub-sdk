package io.splithub.core

/**
 * MurmurHash3 (32-bit, x86) over the UTF-8 bytes of the input, bit for bit the
 * same as `murmur3` in @splithub/core, so a visitor gets the same variant in the
 * browser, on the server and in the app.
 */
object Hash {
    private val C1 = 0xcc9e2d51.toInt()
    private val C2 = 0x1b873593

    /** The hash as an unsigned 32-bit value. `seed` is read as an unsigned 32-bit value too. */
    @JvmStatic
    @JvmOverloads
    fun murmur3(input: String, seed: Long = 0): Long {
        var h = seed.toInt()
        val bytes = utf8(input)
        val n = bytes.size
        val blocks = n ushr 2

        for (i in 0 until blocks) {
            val o = i * 4
            var k = (bytes[o].toInt() and 0xff) or
                ((bytes[o + 1].toInt() and 0xff) shl 8) or
                ((bytes[o + 2].toInt() and 0xff) shl 16) or
                ((bytes[o + 3].toInt() and 0xff) shl 24)
            k *= C1
            k = Integer.rotateLeft(k, 15)
            k *= C2
            h = h xor k
            h = Integer.rotateLeft(h, 13)
            h = h * 5 + 0xe6546b64.toInt()
        }

        var k = 0
        val tail = blocks * 4
        val rest = n and 3
        if (rest == 3) k = k xor ((bytes[tail + 2].toInt() and 0xff) shl 16)
        if (rest >= 2) k = k xor ((bytes[tail + 1].toInt() and 0xff) shl 8)
        if (rest >= 1) {
            k = k xor (bytes[tail].toInt() and 0xff)
            k *= C1
            k = Integer.rotateLeft(k, 15)
            k *= C2
            h = h xor k
        }

        h = h xor n
        h = h xor (h ushr 16)
        h *= 0x85ebca6b.toInt()
        h = h xor (h ushr 13)
        h *= 0xc2b2ae35.toInt()
        h = h xor (h ushr 16)
        return h.toLong() and 0xffffffffL
    }

    /** Hash to a number in [0, 1): murmur3 / 2^32. */
    @JvmStatic
    @JvmOverloads
    fun hashToUnit(input: String, seed: Long = 0): Double = murmur3(input, seed) / 4294967296.0

    /**
     * UTF-8 like the browser's TextEncoder: a lone surrogate becomes U+FFFD
     * (Java's own encoder would write `?`, and the hash would differ).
     */
    internal fun utf8(s: String): ByteArray {
        val out = java.io.ByteArrayOutputStream(s.length + 8)
        var i = 0
        while (i < s.length) {
            var c = s[i].code
            if (c in 0xd800..0xdbff && i + 1 < s.length && s[i + 1].code in 0xdc00..0xdfff) {
                c = 0x10000 + ((c - 0xd800) shl 10) + (s[i + 1].code - 0xdc00)
                i++
            } else if (c in 0xd800..0xdfff) {
                c = 0xfffd
            }
            when {
                c < 0x80 -> out.write(c)
                c < 0x800 -> {
                    out.write(0xc0 or (c shr 6))
                    out.write(0x80 or (c and 0x3f))
                }
                c < 0x10000 -> {
                    out.write(0xe0 or (c shr 12))
                    out.write(0x80 or ((c shr 6) and 0x3f))
                    out.write(0x80 or (c and 0x3f))
                }
                else -> {
                    out.write(0xf0 or (c shr 18))
                    out.write(0x80 or ((c shr 12) and 0x3f))
                    out.write(0x80 or ((c shr 6) and 0x3f))
                    out.write(0x80 or (c and 0x3f))
                }
            }
            i++
        }
        return out.toByteArray()
    }
}
