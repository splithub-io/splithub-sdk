package io.splithub.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OverridesTest {
    private val body = """
        {
          "version": 3,
          "experiments": {
            "price": { "weights": { "control": 1, "cheaper": 3 }, "values": { "cheaper": { "amount": 5 } } },
            "hero": { "status": "paused", "traffic": 2 }
          },
          "added": [
            { "key": "hero", "kind": "component", "status": "running", "traffic": 1, "goal": "signup", "seed": "hero",
              "variants": [ { "key": "control", "weight": 0.5 }, { "key": "bold", "weight": 0.5 } ] },
            { "key": "price", "kind": "value", "status": "running", "traffic": 1, "goal": null, "seed": "price",
              "variants": [ { "key": "control", "weight": 0.5, "value": 9 }, { "key": "cheaper", "weight": 0.5, "value": 7 } ] },
            { "key": "broken", "variants": [ { "key": "only", "weight": 1 } ] }
          ],
          "goals": [ { "key": "signup", "type": "event", "path": null } ],
          "properties": { "sh-app123": { "status": "paused" } },
          "addedProperties": [ { "key": "sh-app123", "status": "running", "kind": "app", "goals": [] } ],
          "holdout": { "percent": 10, "seed": "h", "goal": "signup" },
          "layers": { "checkout": { "seed": "c2" } },
          "ctx": { "country": "DE", "timezone": "Europe/Berlin" }
        }
    """.trimIndent()

    @Test
    fun appliesAddedExperimentsAndPatches() {
        val o = Overrides.parseText(body)!!
        val config = Overrides.apply(SplitHubConfig.EMPTY, o)
        assertEquals(listOf("hero", "price"), config.experiments.map { it.key })
        val hero = config.experiment("hero")!!
        assertEquals("paused", hero.status)
        // Traffic outside 0..1 is ignored.
        assertEquals(1.0, hero.traffic, 0.0)
        val price = config.experiment("price")!!
        assertEquals(0.25, price.variants[0].weight, 1e-12)
        assertEquals(0.75, price.variants[1].weight, 1e-12)
        assertEquals(mapOf("amount" to 5L), price.variants[1].value)
        assertEquals(9L, price.variants[0].value)
        assertEquals("paused", config.properties.single().status)
        assertEquals("app", config.properties.single().kind)
        assertEquals(Holdout(10.0, "h", "signup"), config.holdout)
        assertEquals("c2", config.layers["checkout"])
        assertEquals("DE", o.ctx?.country)
        assertEquals(listOf("signup"), config.goals.map { it.key })
    }

    @Test
    fun refusesWhatIsNotOverrides() {
        assertNull(Overrides.parseText("""{"experiments":{}}"""))
        assertNull(Overrides.parseText("""{"version":1}"""))
        assertNull(Overrides.parseText("not json"))
    }

    @Test
    fun overridesUrl() {
        assertEquals("https://go.splithub.io/v1/overrides/pk_abc.json?all=1", Overrides.resolveUrl("https://go.splithub.io/v1/events", "pk_abc"))
        assertEquals("http://10.0.2.2:8787/v1/overrides/pk_a%20b.json?all=1", Overrides.resolveUrl("http://10.0.2.2:8787/v1/events/", "pk_a b"))
    }

    @Test
    fun eventKeys() {
        assertEquals("video-played", Goals.eventKey("Video Played"))
        assertEquals("signup", Goals.eventKey("signup"))
        assertEquals("a", Goals.eventKey("--A--"))
        assertEquals("video-played", Goals.goalKeyFor(emptyList(), "Video Played"))
        assertEquals("watch", Goals.goalKeyFor(listOf(Goal("watch", "event", event = "Video Played")), "Video Played"))
        assertNull(Goals.goalKeyFor(emptyList(), "!!!"))
        assertTrue(Goals.matchPath("/blog/*", "/blog/a/b"))
        assertTrue(Goals.matchPath("/pricing/", "/pricing"))
    }

    @Test
    fun isoDates() {
        assertEquals(1793491200000L, Iso8601.parse("2026-11-01T00:00:00Z"))
        assertEquals(1793491200000L, Iso8601.parse("2026-11-01"))
        assertEquals(1793491200000L - 2 * 3600_000L, Iso8601.parse("2026-11-01T00:00:00+02:00"))
        assertEquals(1793491200123L, Iso8601.parse("2026-11-01T00:00:00.123Z"))
        assertNull(Iso8601.parse("soon"))
    }
}
