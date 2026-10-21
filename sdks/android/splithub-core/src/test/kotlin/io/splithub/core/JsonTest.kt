package io.splithub.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class JsonTest {
    @Test
    fun numbersPrintLikeJavaScript() {
        assertEquals("1", Json.number(1.0))
        assertEquals("-5", Json.number(-5.0))
        assertEquals("0", Json.number(-0.0))
        assertEquals("0.5", Json.number(0.5))
        assertEquals("0.16666666666666666", Json.number(1.0 / 6))
        assertEquals("15000000", Json.number(1.5e7))
        assertEquals("0.0001", Json.number(0.0001))
        assertEquals("1e-7", Json.number(1e-7))
        assertEquals("1.5e-7", Json.number(1.5e-7))
        assertEquals("1e+21", Json.number(1e21))
        assertEquals("100000000000000000000", Json.number(1e20))
        assertEquals("null", Json.number(Double.NaN))
        assertEquals("0.1", Json.write(0.1f))
        assertEquals("7", Json.write(7))
    }

    @Test
    fun stringsEscapeLikeStringify() {
        assertEquals("\"a\\\"b\\\\c\\n\\t\\u0001\"", Json.write("a\"b\\c\n\t\u0001"))
        assertEquals("\"ü🎉/\"", Json.write("ü🎉/"))
        assertEquals("\"\\ud800\"", Json.write("\ud800"))
    }

    @Test
    fun roundTrip() {
        val text = """{"a":[1,2.5,"x",true,null,{"b":-3}],"c":{},"d":[]}"""
        assertEquals(text, Json.write(Json.parse(text)))
        val parsed = Json.parse("""{"s":"\u00fc\n\ud83c\udf89"}""").asObj()!!
        assertEquals("ü\n🎉", parsed["s"])
    }

    @Test
    fun invalidJsonIsNull() {
        assertNull(Json.parseOrNull("{"))
        assertNull(Json.parseOrNull("[1,]"))
        assertNull(Json.parseOrNull("nul"))
        assertNull(Json.parseOrNull("{} x"))
    }
}
