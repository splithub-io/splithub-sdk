package io.splithub.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The shared vectors of @splithub/core (`packages/core/test/vectors.json`): every case must
 * match exactly, or the app would put a visitor in another variant than the website.
 */
class VectorsTest {
    companion object {
        private val vectors: Map<String, Any?> by lazy {
            val text = VectorsTest::class.java.getResourceAsStream("/vectors.json")?.use { it.readBytes().toString(Charsets.UTF_8) }
                ?: System.getProperty("splithub.vectors")?.let { File(it) }?.takeIf { it.exists() }?.readText()
                ?: error("vectors.json not found: run `node scripts/copy-vectors.mjs`")
            Json.parse(text).asObj()!!
        }

        fun cases(name: String): List<Map<String, Any?>> = vectors.list(name)!!.map { it.asObj()!! }

        fun contextOf(raw: Any?): TargetingContext {
            val m = raw.asObj() ?: return TargetingContext()
            return TargetingContext(
                country = m.str("country"),
                region = m.str("region"),
                city = m.str("city"),
                device = m.str("device"),
                browser = m.str("browser"),
                os = m.str("os"),
                language = m.str("language"),
                referrer = m.str("referrer"),
                url = m.str("url"),
                cookies = m.obj("cookies")?.mapValues { it.value as String },
                visitor = m.str("visitor"),
                now = m.num("now")?.toLong(),
                timezone = m.str("timezone"),
                platform = m.str("platform"),
                appVersion = m.str("appVersion"),
            )
        }
    }

    @Test
    fun format() {
        assertEquals("splithub-vectors", vectors["format"])
        assertEquals(1L, vectors["version"])
    }

    @Test
    fun murmur3() {
        for (c in cases("murmur3")) {
            val input = c.str("input")!!
            val seed = (c["seed"] as Number).toLong()
            assertEquals("murmur3(\"$input\", $seed)", (c["expected"] as Number).toLong(), Hash.murmur3(input, seed))
        }
    }

    @Test
    fun hashToUnit() {
        for (c in cases("hashToUnit")) {
            val input = c.str("input")!!
            assertEquals("hashToUnit(\"$input\")", (c["expected"] as Number).toDouble(), Hash.hashToUnit(input, (c["seed"] as Number).toLong()), 0.0)
        }
    }

    @Test
    fun pickVariant() {
        for (group in cases("pickVariant")) {
            val e = group.obj("experiment")!!
            val experiment = Experiment(
                key = e.str("key")!!,
                kind = "component",
                status = "running",
                traffic = e.num("traffic")!!,
                seed = e.str("seed")!!,
                goal = null,
                variants = e.list("variants")!!.map { v -> v.asObj()!!.let { Variant(it.str("key")!!, it.num("weight")!!) } },
            )
            for (c in group.list("cases")!!.map { it.asObj()!! }) {
                val visitor = c.str("visitor")!!
                assertEquals("${experiment.key} / \"$visitor\"", c["expected"], Assign.pickVariant(experiment, visitor)?.key)
            }
        }
    }

    @Test
    fun layerBucket() {
        for (c in cases("layerBucket")) {
            val layer = c.str("layer")!!
            val config = SplitHubConfig(layers = mapOf(layer to c.str("seed")))
            val visitor = c.str("visitor")!!
            assertEquals("$layer / \"$visitor\"", (c["expected"] as Number).toInt(), Assign.layerBucket(config, layer, visitor))
        }
    }

    @Test
    fun holdoutGroup() {
        for (c in cases("holdoutGroup")) {
            val config = SplitHubConfig(holdout = Holdout(c.num("percent")!!, c.str("seed")!!, null))
            val visitor = c.str("visitor")!!
            assertEquals("holdout \"$visitor\"", c["expected"], Assign.holdoutGroup(config, visitor))
        }
    }

    @Test
    fun compareVersions() {
        for (c in cases("compareVersions")) {
            val a = c.str("a")!!
            val b = c.str("b")!!
            assertEquals("compareVersions($a, $b)", (c["expected"] as Number).toInt(), Targeting.compareVersions(a, b))
        }
    }

    @Test
    fun conditions() {
        for (c in cases("conditions")) {
            val condition = ConfigJson.condition(c["condition"])!!
            assertEquals("$condition with ${c["context"]}", c["expected"], Targeting.evaluateCondition(condition, contextOf(c["context"])))
        }
    }

    @Test
    fun mvt() {
        for (c in cases("mvt")) {
            @Suppress("UNCHECKED_CAST")
            val factors = c.obj("factors")!! as Map<String, Map<String, Any?>>
            val variants = Assign.mvtVariants(factors)
            val expected = c.list("expected")!!.map { it.asObj()!! }
            assertEquals(expected.size, variants.size)
            expected.forEachIndexed { i, e ->
                assertEquals(e.str("key"), variants[i].key)
                assertEquals(e.num("weight")!!, variants[i].weight, 0.0)
                assertEquals(e["levels"], variants[i].levels)
                assertEquals(e["value"], variants[i].value)
            }
        }
    }

    @Test
    fun assign() {
        val a = vectors.obj("assign")!!
        val config = ConfigJson.config(a["normalized"])
        assertTrue(config.experiments.isNotEmpty())
        val contexts = a.list("contexts")!!.map { contextOf(it) }
        var checked = 0
        for (c in a.list("cases")!!.map { it.asObj()!! }) {
            val experiment = c.str("experiment")!!
            val visitor = c.str("visitor")!!
            val context = contexts[(c["context"] as Number).toInt()]
            val expected = c.obj("expected")!!
            val got = Assign.assign(config, experiment, visitor, emptyMap(), context)
            val label = "$experiment / \"$visitor\" / context ${c["context"]}"
            assertEquals("$label variant", expected["variant"], got.variant?.key)
            assertEquals("$label reason", expected["reason"], got.reason)
            checked++
        }
        assertTrue(checked > 0)
    }
}
