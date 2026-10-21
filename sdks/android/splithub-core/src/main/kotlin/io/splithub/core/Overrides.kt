package io.splithub.core

import java.net.URLEncoder

/** A live patch of one experiment from the dashboard, the CLI or an agent. */
data class ExperimentOverride(
    val status: String? = null,
    val traffic: Double? = null,
    val weights: Map<String, Double>? = null,
    /** `value` payloads by variant key; a key present with null sets null. */
    val values: Map<String, Any?>? = null,
    val seed: String? = null,
)

/** What the cloud knows about the device's request: country, region, city, timezone. */
data class Geo(val country: String? = null, val region: String? = null, val city: String? = null, val timezone: String? = null)

/**
 * `GET /v1/overrides/<pk>.json`. Apps have no config file, so every experiment arrives in
 * `added`; `experiments` patches them (pause, traffic, weights, values).
 */
data class RemoteOverrides(
    val version: Double,
    val experiments: Map<String, ExperimentOverride>,
    val added: List<Experiment> = emptyList(),
    val goals: List<Goal> = emptyList(),
    val properties: Map<String, String?> = emptyMap(),
    val addedProperties: List<Property> = emptyList(),
    val holdout: Holdout? = null,
    val layers: Map<String, String?>? = null,
    val ctx: Geo? = null,
)

object Overrides {
    /**
     * `https://go.splithub.io/v1/events` -> `https://go.splithub.io/v1/overrides/<pk>.json?all=1`.
     * `all=1`: an app has no config file, so it also asks for the experiments pushed from `splithub.config.ts`.
     */
    @JvmStatic
    fun resolveUrl(eventsEndpoint: String, publicKey: String): String {
        val base = eventsEndpoint.replace(Regex("/events/?$"), "")
        return "$base/overrides/${URLEncoder.encode(publicKey, "UTF-8").replace("+", "%20")}.json?all=1"
    }

    /** Null unless it has a numeric `version` and an `experiments` object, like `isRemoteOverrides`. */
    @JvmStatic
    fun parse(raw: Any?): RemoteOverrides? {
        val m = raw.asObj() ?: return null
        val version = m.num("version") ?: return null
        val patches = m.obj("experiments") ?: return null
        return RemoteOverrides(
            version = version,
            experiments = patches.mapNotNull { (k, v) -> v.asObj()?.let { k to patch(it) } }.toMap(),
            added = m.list("added")?.mapNotNull { ConfigJson.experiment(it) } ?: emptyList(),
            goals = m.list("goals")?.mapNotNull { ConfigJson.goal(it) } ?: emptyList(),
            properties = m.obj("properties")?.mapValues { (_, v) -> v.asObj()?.str("status") } ?: emptyMap(),
            addedProperties = m.list("addedProperties")?.mapNotNull { ConfigJson.property(it) } ?: emptyList(),
            holdout = ConfigJson.holdout(m["holdout"]),
            layers = ConfigJson.layers(m["layers"]),
            ctx = m.obj("ctx")?.let { Geo(it.str("country"), it.str("region"), it.str("city"), it.str("timezone")) },
        )
    }

    @JvmStatic
    fun parseText(text: String?): RemoteOverrides? = parse(Json.parseOrNull(text))

    private fun patch(m: Map<String, Any?>): ExperimentOverride = ExperimentOverride(
        status = m.str("status"),
        traffic = m.num("traffic"),
        weights = m.obj("weights")?.mapNotNull { (k, v) -> (v as? Number)?.let { k to it.toDouble() } }?.toMap(),
        values = m.obj("values"),
        seed = m.str("seed"),
    )

    private fun applyTo(e: Experiment, o: ExperimentOverride): Experiment {
        var variants = e.variants
        if (o.weights != null) {
            val raw = variants.map { it.copy(weight = maxOf(0.0, o.weights[it.key] ?: it.weight)) }
            val total = raw.sumOf { it.weight }
            if (total > 0) variants = raw.map { it.copy(weight = it.weight / total) }
        }
        if (o.values != null && e.kind == "value") {
            variants = variants.map { if (o.values.containsKey(it.key)) it.copy(value = o.values[it.key]) else it }
        }
        return e.copy(
            status = o.status ?: e.status,
            traffic = if (o.traffic != null && o.traffic >= 0 && o.traffic <= 1) o.traffic else e.traffic,
            seed = o.seed ?: e.seed,
            variants = variants,
        )
    }

    private fun validHoldout(h: Holdout?): Boolean = h != null && h.percent > 0 && h.percent <= 50

    /** Pure merge, as `applyRemoteOverrides`: returns a new config. */
    @JvmStatic
    fun apply(config: SplitHubConfig, overrides: RemoteOverrides?): SplitHubConfig {
        if (overrides == null) return config
        val known = config.experiments.map { it.key }.toSet()
        val added = overrides.added.filter { it.key !in known }
        val knownGoals = config.goals.map { it.key }.toSet()
        val addedGoals = overrides.goals.filter { it.key !in knownGoals }
        val holdout = if (config.holdout == null && validHoldout(overrides.holdout)) overrides.holdout else null
        val layers = overrides.layers?.let { it + config.layers }
        val knownProps = config.properties.map { it.key }.toSet()
        val addedProps = overrides.addedProperties.filter { it.key !in knownProps }
        val propsChanged = overrides.properties.isNotEmpty() || addedProps.isNotEmpty()
        if (overrides.experiments.isEmpty() && added.isEmpty() && addedGoals.isEmpty() && holdout == null && layers == null && !propsChanged) {
            return config
        }
        val properties = if (propsChanged) {
            (config.properties + addedProps).map { p ->
                val status = overrides.properties[p.key]
                if (status == "running" || status == "paused") p.copy(status = status) else p
            }
        } else {
            config.properties
        }
        return SplitHubConfig(
            experiments = (config.experiments + added).map { e -> overrides.experiments[e.key]?.let { applyTo(e, it) } ?: e },
            goals = if (addedGoals.isNotEmpty()) config.goals + addedGoals else config.goals,
            properties = properties,
            layers = layers ?: config.layers,
            holdout = holdout ?: config.holdout,
        )
    }
}
