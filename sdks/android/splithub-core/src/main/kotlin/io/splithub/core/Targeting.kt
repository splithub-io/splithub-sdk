package io.splithub.core

import java.net.URLDecoder
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import java.util.regex.Pattern
import java.util.regex.PatternSyntaxException

/** What the SDK knows about the visitor when assigning. Everything is optional. */
data class TargetingContext(
    val country: String? = null,
    val region: String? = null,
    val city: String? = null,
    val device: String? = null,
    val browser: String? = null,
    val os: String? = null,
    val language: String? = null,
    val referrer: String? = null,
    val url: String? = null,
    val cookies: Map<String, String>? = null,
    /** `new` on the launch that created the visitor id, `returning` afterwards. */
    val visitor: String? = null,
    /** Clock for `hour`, `weekday` and schedules; null = now. */
    val now: Long? = null,
    /** IANA zone (`Europe/Berlin`) for `hour` / `weekday`; null = UTC. */
    val timezone: String? = null,
    /** `android` in this SDK. */
    val platform: String? = null,
    val appVersion: String? = null,
) {
    /** This context with every non-null field of [over] on top. */
    fun with(over: TargetingContext): TargetingContext = TargetingContext(
        country = over.country ?: country,
        region = over.region ?: region,
        city = over.city ?: city,
        device = over.device ?: device,
        browser = over.browser ?: browser,
        os = over.os ?: os,
        language = over.language ?: language,
        referrer = over.referrer ?: referrer,
        url = over.url ?: url,
        cookies = over.cookies ?: cookies,
        visitor = over.visitor ?: visitor,
        now = over.now ?: now,
        timezone = over.timezone ?: timezone,
        platform = over.platform ?: platform,
        appVersion = over.appVersion ?: appVersion,
    )
}

/**
 * Port of `targeting.ts`: conditions, the version comparison and the flow walk. Every
 * decision is a hash of visitor id + node id, the same on every runtime.
 */
object Targeting {
    private const val MAX_STEPS = 64
    private val WEEKDAYS = arrayOf("sun", "mon", "tue", "wed", "thu", "fri", "sat")
    private val ORIGIN = Regex("^[a-z]+://[^/]+", RegexOption.IGNORE_CASE)
    private val DIGITS = Regex("^[0-9]+$")
    private val LIST_SPLIT = Regex("[,\n]")

    private fun localClock(ctx: TargetingContext): Pair<Int, Int> {
        // An unknown zone reads as GMT here, like the TypeScript fallback to UTC.
        val zone = TimeZone.getTimeZone(ctx.timezone ?: "UTC")
        val cal = Calendar.getInstance(zone, Locale.ROOT)
        cal.timeInMillis = ctx.now ?: System.currentTimeMillis()
        return cal.get(Calendar.HOUR_OF_DAY) to (cal.get(Calendar.DAY_OF_WEEK) - 1)
    }

    private fun decode(s: String): String = try {
        URLDecoder.decode(s.replace("+", " "), "UTF-8")
    } catch (e: IllegalArgumentException) {
        s
    }

    private fun queryParam(url: String?, name: String): String? {
        if (url == null) return null
        val q = url.indexOf('?')
        if (q < 0) return null
        val search = url.substring(q + 1).split('#')[0]
        for (pair in search.split('&')) {
            val eq = pair.indexOf('=')
            val k = decode(if (eq < 0) pair else pair.substring(0, eq))
            if (k == name) return decode(if (eq < 0) "" else pair.substring(eq + 1))
        }
        return null
    }

    /** Value of a context field as a lowercase string, or null when unknown. */
    @JvmStatic
    fun contextValue(field: String, key: String?, ctx: TargetingContext): String? {
        val v: String? = when (field) {
            "country" -> ctx.country
            "region" -> ctx.region
            "city" -> ctx.city
            "device" -> ctx.device
            "browser" -> ctx.browser
            "os" -> ctx.os
            "referrer" -> ctx.referrer
            "url" -> ctx.url
            "visitor" -> ctx.visitor
            "platform" -> ctx.platform
            "app_version" -> ctx.appVersion
            "language" -> ctx.language?.split(',')?.get(0)?.trim()?.split('-')?.get(0)
            "path" -> ctx.url?.let { u ->
                val noOrigin = u.replace(ORIGIN, "")
                noOrigin.split('?')[0].split('#')[0].ifEmpty { "/" }
            }
            "query" -> if (key != null && key.isNotEmpty()) queryParam(ctx.url, key) else null
            "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content" -> queryParam(ctx.url, field)
            "cookie" -> if (key != null && key.isNotEmpty()) ctx.cookies?.get(key) else null
            "hour" -> localClock(ctx).first.toString()
            "weekday" -> WEEKDAYS[localClock(ctx).second]
            else -> null
        }
        return v?.lowercase(Locale.ROOT)
    }

    private fun list(value: String?): List<String> =
        (value ?: "").split(LIST_SPLIT).map { it.trim().lowercase(Locale.ROOT) }.filter { it.isNotEmpty() }

    /**
     * Orders two versions: dotted parts compare as numbers when both are digits
     * (`2.10.0` > `2.9`), otherwise as strings; a missing part counts as 0.
     */
    @JvmStatic
    fun compareVersions(a: String, b: String): Int {
        val pa = a.trim().split('.')
        val pb = b.trim().split('.')
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val x = pa.getOrElse(i) { "0" }
            val y = pb.getOrElse(i) { "0" }
            if (DIGITS.matches(x) && DIGITS.matches(y)) {
                val d = x.toDouble() - y.toDouble()
                if (d != 0.0) return if (d < 0) -1 else 1
            } else if (x != y) {
                return if (x < y) -1 else 1
            }
        }
        return 0
    }

    @JvmStatic
    fun evaluateCondition(c: TargetCondition, ctx: TargetingContext): Boolean {
        val actual = contextValue(c.field, c.key, ctx)
        val expected = (c.value ?: "").trim().lowercase(Locale.ROOT)
        return when (c.op) {
            "exists" -> actual != null && actual != ""
            "not_exists" -> actual == null || actual == ""
            "is" -> actual != null && actual == expected
            "is_not" -> actual == null || actual != expected
            "contains" -> actual != null && expected != "" && actual.contains(expected)
            "not_contains" -> actual == null || expected == "" || !actual.contains(expected)
            "starts_with" -> actual != null && actual.startsWith(expected)
            "in" -> actual != null && list(c.value).contains(actual)
            "not_in" -> actual == null || !list(c.value).contains(actual)
            "gte" -> actual != null && actual != "" && expected != "" && compareVersions(actual, expected) >= 0
            "lt" -> actual != null && actual != "" && expected != "" && compareVersions(actual, expected) < 0
            "matches" -> {
                if (actual == null) {
                    false
                } else {
                    try {
                        Pattern.compile(c.value ?: "", Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE).matcher(actual).find()
                    } catch (e: PatternSyntaxException) {
                        false
                    }
                }
            }
            else -> false
        }
    }

    @JvmStatic
    fun matchConditions(conditions: List<TargetCondition>, match: String, ctx: TargetingContext): Boolean {
        if (conditions.isEmpty()) return true
        return if (match == "any") conditions.any { evaluateCondition(it, ctx) } else conditions.all { evaluateCondition(it, ctx) }
    }

    /** Result of a flow walk: the variant, or null with `skip` / `dead_end`. */
    data class FlowOutcome(val variant: Variant?, val path: List<String>, val reason: String? = null)

    @JvmStatic
    fun runFlow(experiment: Experiment, flow: Flow, visitorId: String, ctx: TargetingContext): FlowOutcome {
        val path = ArrayList<String>()
        var id: String? = flow.start
        var step = 0
        while (step < MAX_STEPS && !id.isNullOrEmpty()) {
            val node = flow.nodes[id] ?: break
            path.add(id)
            when (node) {
                is FlowNode.Condition ->
                    id = if (matchConditions(node.conditions, node.match, ctx)) node.then else node.otherwise
                is FlowNode.Split -> {
                    val total = node.outputs.sumOf { maxOf(0.0, it.weight) }
                    if (total <= 0 || node.outputs.isEmpty()) return FlowOutcome(null, path, "dead_end")
                    val unit = Hash.hashToUnit("${experiment.seed}:${experiment.key}:flow:$id:$visitorId") * total
                    var acc = 0.0
                    var to: String? = node.outputs[node.outputs.size - 1].to
                    for (o in node.outputs) {
                        acc += maxOf(0.0, o.weight)
                        if (unit < acc) {
                            to = o.to
                            break
                        }
                    }
                    id = to
                }
                is FlowNode.VariantNode -> {
                    val variant = experiment.variants.firstOrNull { it.key == node.variant }
                    return if (variant != null) FlowOutcome(variant, path) else FlowOutcome(null, path, "dead_end")
                }
                FlowNode.Skip -> return FlowOutcome(null, path, "skip")
                // TypeScript loops on an unknown node until MAX_STEPS: a dead end either way.
                FlowNode.Unknown -> return FlowOutcome(null, path, "dead_end")
            }
            step++
        }
        return FlowOutcome(null, path, "dead_end")
    }
}
