package io.splithub.core

// The normalized shapes of @splithub/core (`types.ts`) the app works with. They come from
// the overrides JSON (`added` experiments, goals, properties), never from a config file.

/** One variant; `weight` is a share in 0..1. `value` is parsed JSON (Map, List, String, Long, Double, Boolean or null). */
data class Variant(
    val key: String,
    val weight: Double,
    val value: Any? = null,
    val to: String? = null,
    val levels: Map<String, String>? = null,
)

data class Schedule(val startAt: String? = null, val endAt: String? = null)

/** Mutual exclusion: the visitor's bucket in layer `key` must be in [start, end). */
data class LayerRange(val key: String, val start: Int, val end: Int)

/** `field` and `op` stay strings, so a field this SDK does not know behaves as unknown, like in TypeScript. */
data class TargetCondition(
    val field: String,
    val op: String,
    val key: String? = null,
    val value: String? = null,
)

data class SplitOutput(val weight: Double, val to: String?)

sealed class FlowNode {
    data class Condition(
        val conditions: List<TargetCondition>,
        val match: String = "all",
        val then: String?,
        val otherwise: String?,
    ) : FlowNode()

    data class Split(val outputs: List<SplitOutput>) : FlowNode()

    data class VariantNode(val variant: String) : FlowNode()

    object Skip : FlowNode()

    /** A node type this SDK does not know: the walk ends there. */
    object Unknown : FlowNode()
}

data class Flow(val start: String, val nodes: Map<String, FlowNode>)

data class Experiment(
    val key: String,
    val kind: String,
    val status: String,
    val traffic: Double,
    val seed: String,
    val goal: String?,
    val variants: List<Variant>,
    val flow: Flow? = null,
    val schedule: Schedule? = null,
    val layer: LayerRange? = null,
    val name: String? = null,
) {
    /** Control is always the first declared variant. */
    val control: Variant get() = variants[0]
}

data class Goal(
    val key: String,
    val type: String,
    val path: String? = null,
    val event: String? = null,
)

data class Property(
    val key: String,
    val status: String,
    val kind: String? = null,
    val goals: List<String> = emptyList(),
)

data class Holdout(val percent: Double, val seed: String, val goal: String?)

/** What assignment reads: experiments, goals, properties, layer seeds and the holdout. */
data class SplitHubConfig(
    val experiments: List<Experiment> = emptyList(),
    val goals: List<Goal> = emptyList(),
    val properties: List<Property> = emptyList(),
    /** Layer seeds by key; a missing seed means the layer key. */
    val layers: Map<String, String?> = emptyMap(),
    val holdout: Holdout? = null,
) {
    fun experiment(key: String): Experiment? = experiments.firstOrNull { it.key == key }

    companion object {
        @JvmField
        val EMPTY = SplitHubConfig()
    }
}

/** Why a variant was (not) assigned, as in @splithub/core. */
object Reason {
    const val ASSIGNED = "assigned"
    const val NOT_RUNNING = "not_running"
    const val OUTSIDE_TRAFFIC = "outside_traffic"
    const val UNKNOWN_EXPERIMENT = "unknown_experiment"
    const val OVERRIDE = "override"
    const val TARGETING = "targeting"
    const val BOT = "bot"
    const val LAYER = "layer"
    const val HOLDOUT = "holdout"
    const val PENDING = "pending"
}

data class Assignment(val experiment: String, val variant: Variant?, val reason: String)

/** Who sends a batch: the `app` block of the wire format. Trimmed to the ingest's limits when written. */
data class AppInfo(
    val platform: String = "android",
    val id: String? = null,
    val version: String? = null,
    val build: String? = null,
    val os: String? = null,
    val model: String? = null,
    /** `mobile`, `tablet` or `desktop`. */
    val device: String? = null,
) {
    fun toJson(): Map<String, Any?> {
        val m = LinkedHashMap<String, Any?>()
        m["platform"] = platform
        fun put(k: String, v: String?, max: Int) {
            val t = v?.trim()
            if (!t.isNullOrEmpty()) m[k] = t.take(max)
        }
        put("id", id, 128)
        put("version", version, 32)
        put("build", build, 32)
        put("os", os, 32)
        put("model", model, 64)
        if (device == "mobile" || device == "tablet" || device == "desktop") m["device"] = device
        return m
    }
}

/** Reads the normalized config shapes from parsed JSON (overrides `added`, or a whole config in tests). */
object ConfigJson {
    @JvmStatic
    fun experiment(raw: Any?): Experiment? {
        val m = raw.asObj() ?: return null
        val key = m.str("key") ?: return null
        val variants = m.list("variants")?.mapNotNull { variant(it) } ?: return null
        if (variants.size < 2) return null
        return Experiment(
            key = key,
            kind = m.str("kind") ?: "component",
            status = m.str("status") ?: "draft",
            // An absent traffic lets everyone in, as `unit >= undefined` does in TypeScript.
            traffic = m.num("traffic") ?: 1.0,
            // The cloud always sends a seed; the key is what defineConfig would have used.
            seed = m.str("seed") ?: key,
            goal = m.str("goal"),
            variants = variants,
            flow = flow(m["flow"]),
            schedule = m.obj("schedule")?.let { Schedule(it.str("startAt"), it.str("endAt")) },
            layer = m.obj("layer")?.let { l ->
                val k = l.str("key")
                val r = l.list("range")
                val a = (r?.getOrNull(0) as? Number)?.toInt()
                val b = (r?.getOrNull(1) as? Number)?.toInt()
                if (k != null && a != null && b != null) LayerRange(k, a, b) else null
            },
            name = m.str("name"),
        )
    }

    private fun variant(raw: Any?): Variant? {
        val m = raw.asObj() ?: return null
        val key = m.str("key") ?: return null
        val levels = m.obj("levels")?.mapNotNull { (k, v) -> (v as? String)?.let { k to it } }?.toMap()
        return Variant(key, m.num("weight") ?: 0.0, m["value"], m.str("to"), levels)
    }

    @JvmStatic
    fun flow(raw: Any?): Flow? {
        val m = raw.asObj() ?: return null
        val start = m.str("start") ?: return null
        val nodes = m.obj("nodes") ?: return null
        return Flow(start, nodes.mapValues { (_, v) -> node(v) })
    }

    private fun node(raw: Any?): FlowNode {
        val m = raw.asObj() ?: return FlowNode.Unknown
        return when (m.str("type")) {
            "condition" -> FlowNode.Condition(
                conditions = m.list("conditions")?.mapNotNull { condition(it) } ?: emptyList(),
                match = m.str("match") ?: "all",
                then = m.str("then"),
                otherwise = m.str("else"),
            )
            "split" -> FlowNode.Split(
                m.list("outputs")?.mapNotNull { o -> o.asObj()?.let { SplitOutput(it.num("weight") ?: 0.0, it.str("to")) } } ?: emptyList(),
            )
            "variant" -> m.str("variant")?.let { FlowNode.VariantNode(it) } ?: FlowNode.Unknown
            "skip" -> FlowNode.Skip
            else -> FlowNode.Unknown
        }
    }

    @JvmStatic
    fun condition(raw: Any?): TargetCondition? {
        val m = raw.asObj() ?: return null
        val value = when (val v = m["value"]) {
            is String -> v
            is Number -> Json.number(v.toDouble())
            is Boolean -> v.toString()
            else -> null
        }
        return TargetCondition(m.str("field") ?: return null, m.str("op") ?: return null, m.str("key"), value)
    }

    @JvmStatic
    fun goal(raw: Any?): Goal? {
        val m = raw.asObj() ?: return null
        return Goal(m.str("key") ?: return null, m.str("type") ?: "event", m.str("path"), m.str("event"))
    }

    @JvmStatic
    fun property(raw: Any?): Property? {
        val m = raw.asObj() ?: return null
        return Property(
            key = m.str("key") ?: return null,
            status = m.str("status") ?: "running",
            kind = m.str("kind"),
            goals = m.list("goals")?.filterIsInstance<String>() ?: emptyList(),
        )
    }

    @JvmStatic
    fun holdout(raw: Any?): Holdout? {
        val m = raw.asObj() ?: return null
        val percent = m.num("percent") ?: return null
        val seed = m.str("seed") ?: return null
        return Holdout(percent, seed, m.str("goal"))
    }

    @JvmStatic
    fun layers(raw: Any?): Map<String, String?>? =
        raw.asObj()?.mapValues { (_, v) -> v.asObj()?.str("seed") }

    /** A whole normalized config (what defineConfig returns). The app never has one; the tests read the vectors' config with it. */
    @JvmStatic
    fun config(raw: Any?): SplitHubConfig {
        val m = raw.asObj() ?: return SplitHubConfig.EMPTY
        return SplitHubConfig(
            experiments = m.list("experiments")?.mapNotNull { experiment(it) } ?: emptyList(),
            goals = m.list("goals")?.mapNotNull { goal(it) } ?: emptyList(),
            properties = m.list("properties")?.mapNotNull { property(it) } ?: emptyList(),
            layers = layers(m["layers"]) ?: emptyMap(),
            holdout = holdout(m["holdout"]),
        )
    }
}
