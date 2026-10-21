package io.splithub.core

/**
 * Port of `assignment.ts`. Same visitor + same experiment + same seed always gives the
 * same variant, on any runtime, with no network call. The hashed strings must stay
 * byte for byte what @splithub/core hashes.
 */
object Assign {
    const val HOLDOUT_KEY = "__holdout"
    const val LAYER_BUCKETS = 100

    /** Two hashes, so changing `traffic` does not reshuffle the variants of visitors already in. */
    @JvmStatic
    fun pickVariant(experiment: Experiment, visitorId: String): Variant? {
        val trafficUnit = Hash.hashToUnit("${experiment.seed}:${experiment.key}:traffic:$visitorId")
        if (trafficUnit >= experiment.traffic) return null
        val unit = Hash.hashToUnit("${experiment.seed}:${experiment.key}:variant:$visitorId")
        var cumulative = 0.0
        for (variant in experiment.variants) {
            cumulative += variant.weight
            if (unit < cumulative) return variant
        }
        // Floating point rounding: the last variant.
        return experiment.variants.lastOrNull()
    }

    /** `holdout`, `enrolled`, or null without a holdout. */
    @JvmStatic
    fun holdoutGroup(config: SplitHubConfig, visitorId: String): String? {
        val h = config.holdout ?: return null
        if (!(h.percent > 0)) return null
        return if (Hash.hashToUnit("${h.seed}:$HOLDOUT_KEY:$visitorId") < h.percent / 100) "holdout" else "enrolled"
    }

    /** The visitor's bucket 0..99 in a layer, the same in every experiment of the layer. */
    @JvmStatic
    fun layerBucket(config: SplitHubConfig, layerKey: String, visitorId: String): Int {
        val seed = config.layers[layerKey] ?: layerKey
        return minOf(LAYER_BUCKETS - 1, Math.floor(Hash.hashToUnit("$seed:layer:$layerKey:$visitorId") * LAYER_BUCKETS).toInt())
    }

    @JvmStatic
    fun inLayer(config: SplitHubConfig, experiment: Experiment, visitorId: String): Boolean {
        val l = experiment.layer ?: return true
        val b = layerBucket(config, l.key, visitorId)
        return b >= l.start && b < l.end
    }

    /** The visitor reached a running experiment (in or out of it), so they count for the holdout comparison. */
    @JvmStatic
    fun countsForHoldout(reason: String): Boolean =
        reason == Reason.ASSIGNED || reason == Reason.HOLDOUT || reason == Reason.OUTSIDE_TRAFFIC ||
            reason == Reason.TARGETING || reason == Reason.LAYER

    /** True when the experiment has no run window or `now` is inside it. An unreadable date is ignored, like `Date.parse` giving NaN. */
    @JvmStatic
    fun inSchedule(experiment: Experiment, now: Long): Boolean {
        val s = experiment.schedule ?: return true
        val start = s.startAt?.let { Iso8601.parse(it) }
        val end = s.endAt?.let { Iso8601.parse(it) }
        if (start != null && now < start) return false
        if (end != null && now > end) return false
        return true
    }

    /**
     * Assignment of one experiment. `overrides` forces variants (QA); a forced key that does
     * not exist shows the control and is never counted. Apps have no development drafts.
     */
    @JvmStatic
    @JvmOverloads
    fun assign(
        config: SplitHubConfig,
        experimentKey: String,
        visitorId: String,
        overrides: Map<String, String> = emptyMap(),
        context: TargetingContext = TargetingContext(),
    ): Assignment {
        val experiment = config.experiment(experimentKey)
            ?: return Assignment(experimentKey, null, Reason.UNKNOWN_EXPERIMENT)

        val forced = overrides[experimentKey]
        if (!forced.isNullOrEmpty()) {
            val variant = experiment.variants.firstOrNull { it.key == forced } ?: experiment.control
            return Assignment(experimentKey, variant, Reason.OVERRIDE)
        }
        if (context.device == "bot") return Assignment(experimentKey, null, Reason.BOT)
        if (experiment.status != "running" || !inSchedule(experiment, context.now ?: System.currentTimeMillis())) {
            return Assignment(experimentKey, null, Reason.NOT_RUNNING)
        }
        // Holdout and layers come before traffic and targeting: they decide who may enter at all.
        if (holdoutGroup(config, visitorId) == "holdout") return Assignment(experimentKey, null, Reason.HOLDOUT)
        if (!inLayer(config, experiment, visitorId)) return Assignment(experimentKey, null, Reason.LAYER)
        val flow = experiment.flow
        if (flow != null) {
            val trafficUnit = Hash.hashToUnit("${experiment.seed}:${experiment.key}:traffic:$visitorId")
            if (trafficUnit >= experiment.traffic) return Assignment(experimentKey, null, Reason.OUTSIDE_TRAFFIC)
            val outcome = Targeting.runFlow(experiment, flow, visitorId, context)
            return if (outcome.variant != null) Assignment(experimentKey, outcome.variant, Reason.ASSIGNED)
            else Assignment(experimentKey, null, Reason.TARGETING)
        }
        val variant = pickVariant(experiment, visitorId) ?: return Assignment(experimentKey, null, Reason.OUTSIDE_TRAFFIC)
        return Assignment(experimentKey, variant, Reason.ASSIGNED)
    }

    /**
     * Every combination of the factors' levels as a variant, in order (the all-first-levels
     * combination is the control), equal weights; `value` is `{ factor: levelValue }`.
     * The cloud sends mvt experiments already expanded; this is here for parity with core.
     */
    @JvmStatic
    fun mvtVariants(factors: Map<String, Map<String, Any?>>): List<Variant> {
        var combos: List<Map<String, String>> = listOf(emptyMap())
        for ((factor, levels) in factors) {
            combos = combos.flatMap { c -> levels.keys.map { l -> LinkedHashMap(c).apply { put(factor, l) } } }
        }
        return combos.map { levels ->
            Variant(
                key = factors.keys.joinToString("-") { levels.getValue(it) },
                weight = 1.0 / combos.size,
                value = LinkedHashMap<String, Any?>().apply { for (f in factors.keys) put(f, factors.getValue(f)[levels.getValue(f)]) },
                levels = levels,
            )
        }
    }
}

/**
 * `Date.parse` for the ISO 8601 forms the dashboard writes: a date alone is UTC, a date
 * and time without an offset is local time (like JavaScript). Null when unreadable.
 */
object Iso8601 {
    private val PATTERN = Regex(
        "^([+-]\\d{6}|\\d{4})(?:-(\\d{2})(?:-(\\d{2}))?)?" +
            "(?:T(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,9}))?)?(Z|[+-]\\d{2}:\\d{2})?)?$",
    )

    @JvmStatic
    fun parse(s: String): Long? {
        val m = PATTERN.matchEntire(s.trim()) ?: return null
        val g = m.groupValues
        val year = g[1].toInt()
        val month = if (g[2].isEmpty()) 1 else g[2].toInt()
        val day = if (g[3].isEmpty()) 1 else g[3].toInt()
        val hasTime = g[4].isNotEmpty()
        val hour = if (hasTime) g[4].toInt() else 0
        val minute = if (hasTime) g[5].toInt() else 0
        val second = if (g[6].isEmpty()) 0 else g[6].toInt()
        val millis = if (g[7].isEmpty()) 0 else g[7].padEnd(3, '0').substring(0, 3).toInt()
        if (month !in 1..12 || day !in 1..31 || hour > 24 || minute > 59 || second > 59) return null
        val zone = g[8]
        val tz = when {
            zone == "Z" -> java.util.TimeZone.getTimeZone("UTC")
            zone.isNotEmpty() -> java.util.TimeZone.getTimeZone("GMT$zone")
            hasTime -> java.util.TimeZone.getDefault()
            else -> java.util.TimeZone.getTimeZone("UTC")
        }
        val cal = java.util.GregorianCalendar(tz, java.util.Locale.ROOT)
        cal.isLenient = true
        cal.clear()
        cal.set(year, month - 1, day, hour, minute, second)
        cal.set(java.util.Calendar.MILLISECOND, millis)
        return cal.timeInMillis
    }
}
