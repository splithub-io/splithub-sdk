package io.splithub.core

import java.math.BigDecimal

class JsonException(message: String) : Exception(message)

/**
 * A small JSON reader and writer, so the core needs no library (org.json exists on
 * Android but not on a plain JVM). Objects read as `Map<String, Any?>` (insertion
 * order kept), arrays as `List<Any?>`, whole numbers as `Long`, other numbers as
 * `Double`. The writer prints numbers and escapes strings the way `JSON.stringify` does,
 * so a batch from the app reads exactly like one from the browser.
 */
object Json {
    @JvmStatic
    @Throws(JsonException::class)
    fun parse(text: String): Any? {
        val p = Parser(text)
        p.ws()
        val v = p.value()
        p.ws()
        if (p.i != text.length) throw JsonException("unexpected '${text[p.i]}' at ${p.i}")
        return v
    }

    /** Parses, or returns null for invalid JSON. */
    @JvmStatic
    fun parseOrNull(text: String?): Any? = if (text == null) null else try {
        parse(text)
    } catch (e: JsonException) {
        null
    }

    @JvmStatic
    fun write(value: Any?): String = StringBuilder().also { writeTo(it, value) }.toString()

    @JvmStatic
    fun writeTo(sb: StringBuilder, value: Any?) {
        when (value) {
            null -> sb.append("null")
            is String -> quote(sb, value)
            is Boolean -> sb.append(if (value) "true" else "false")
            is Int, is Long, is Short, is Byte -> sb.append((value as Number).toLong())
            is Double -> sb.append(number(value))
            // A Float printed through Double would show its binary noise (0.1f -> 0.10000000149011612).
            is Float -> sb.append(if (value.isNaN() || value.isInfinite()) "null" else number(value.toString().toDouble()))
            is BigDecimal -> sb.append(number(value.toDouble()))
            is Number -> sb.append(number(value.toDouble()))
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, v) in value) {
                    // JSON.stringify leaves out undefined values; null is the closest we have for maps built in Kotlin.
                    if (!first) sb.append(',')
                    first = false
                    quote(sb, k.toString())
                    sb.append(':')
                    writeTo(sb, v)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (v in value) {
                    if (!first) sb.append(',')
                    first = false
                    writeTo(sb, v)
                }
                sb.append(']')
            }
            is Array<*> -> writeTo(sb, value.asList())
            is IntArray -> writeTo(sb, value.asList())
            is LongArray -> writeTo(sb, value.asList())
            is DoubleArray -> writeTo(sb, value.asList())
            is BooleanArray -> writeTo(sb, value.asList())
            is RawJson -> sb.append(value.json)
            else -> quote(sb, value.toString())
        }
    }

    /** Number formatting of JavaScript's `String(number)`: `1`, `0.5`, `1e-7`, `1e+21`. */
    @JvmStatic
    fun number(d: Double): String {
        if (d.isNaN() || d.isInfinite()) return "null"
        if (d == 0.0) return "0"
        if (d == Math.floor(d) && Math.abs(d) < 1e21) return BigDecimal(d).toPlainString()
        val bd = BigDecimal(d.toString()).stripTrailingZeros()
        val exponent = bd.precision() - bd.scale() - 1
        if (exponent > -7 && exponent < 21) return bd.toPlainString()
        val digits = bd.unscaledValue().abs().toString()
        val sign = if (d < 0) "-" else ""
        val mantissa = if (digits.length == 1) digits else digits[0] + "." + digits.substring(1)
        return "$sign${mantissa}e${if (exponent >= 0) "+" else "-"}${Math.abs(exponent)}"
    }

    private fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c == '\b' -> sb.append("\\b")
                c == '\u000c' -> sb.append("\\f")
                c.code < 0x20 -> sb.append("\\u").append(hex4(c.code))
                Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> {
                    sb.append(c).append(s[i + 1])
                    i++
                }
                // Lone surrogates are escaped, like the well-formed JSON.stringify of current engines.
                Character.isSurrogate(c) -> sb.append("\\u").append(hex4(c.code))
                else -> sb.append(c)
            }
            i++
        }
        sb.append('"')
    }

    private fun hex4(code: Int): String = Integer.toHexString(code).padStart(4, '0')

    private class Parser(val s: String) {
        var i = 0

        fun ws() {
            while (i < s.length && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) i++
        }

        fun value(): Any? {
            if (i >= s.length) throw JsonException("unexpected end")
            return when (val c = s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c in '0'..'9') num() else throw JsonException("unexpected '$c' at $i")
            }
        }

        private fun literal(word: String, v: Any?): Any? {
            if (!s.startsWith(word, i)) throw JsonException("unexpected token at $i")
            i += word.length
            return v
        }

        private fun obj(): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            i++
            ws()
            if (i < s.length && s[i] == '}') {
                i++
                return out
            }
            while (true) {
                ws()
                if (i >= s.length || s[i] != '"') throw JsonException("expected a key at $i")
                val k = str()
                ws()
                if (i >= s.length || s[i] != ':') throw JsonException("expected ':' at $i")
                i++
                ws()
                out[k] = value()
                ws()
                if (i >= s.length) throw JsonException("unexpected end")
                if (s[i] == ',') {
                    i++
                    continue
                }
                if (s[i] == '}') {
                    i++
                    return out
                }
                throw JsonException("expected ',' or '}' at $i")
            }
        }

        private fun arr(): List<Any?> {
            val out = ArrayList<Any?>()
            i++
            ws()
            if (i < s.length && s[i] == ']') {
                i++
                return out
            }
            while (true) {
                ws()
                out.add(value())
                ws()
                if (i >= s.length) throw JsonException("unexpected end")
                if (s[i] == ',') {
                    i++
                    continue
                }
                if (s[i] == ']') {
                    i++
                    return out
                }
                throw JsonException("expected ',' or ']' at $i")
            }
        }

        private fun str(): String {
            i++
            val sb = StringBuilder()
            while (true) {
                if (i >= s.length) throw JsonException("unterminated string")
                val c = s[i++]
                when {
                    c == '"' -> return sb.toString()
                    c == '\\' -> {
                        if (i >= s.length) throw JsonException("unterminated string")
                        when (val e = s[i++]) {
                            '"' -> sb.append('"')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000c')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) throw JsonException("bad \\u escape")
                                val code = s.substring(i, i + 4).toIntOrNull(16) ?: throw JsonException("bad \\u escape")
                                sb.append(code.toChar())
                                i += 4
                            }
                            else -> throw JsonException("bad escape '\\$e'")
                        }
                    }
                    c.code < 0x20 -> throw JsonException("control character in string")
                    else -> sb.append(c)
                }
            }
        }

        private fun num(): Any {
            val start = i
            if (s[i] == '-') i++
            while (i < s.length && s[i] in '0'..'9') i++
            var fractional = false
            if (i < s.length && s[i] == '.') {
                fractional = true
                i++
                while (i < s.length && s[i] in '0'..'9') i++
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                fractional = true
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                while (i < s.length && s[i] in '0'..'9') i++
            }
            val text = s.substring(start, i)
            if (text == "-" || text.isEmpty()) throw JsonException("bad number at $start")
            if (!fractional) text.toLongOrNull()?.let { return it }
            return text.toDoubleOrNull() ?: throw JsonException("bad number at $start")
        }
    }
}

/** JSON text written as is (already serialized). */
class RawJson(val json: String)

// Readers for parsed JSON, lenient like the TypeScript code that reads the same answers.

@Suppress("UNCHECKED_CAST")
internal fun Any?.asObj(): Map<String, Any?>? = this as? Map<String, Any?>

@Suppress("UNCHECKED_CAST")
internal fun Any?.asJsonList(): List<Any?>? = this as? List<Any?>

internal fun Map<String, Any?>.str(key: String): String? = this[key] as? String

internal fun Map<String, Any?>.num(key: String): Double? = (this[key] as? Number)?.toDouble()

internal fun Map<String, Any?>.obj(key: String): Map<String, Any?>? = this[key].asObj()

internal fun Map<String, Any?>.list(key: String): List<Any?>? = this[key].asJsonList()
