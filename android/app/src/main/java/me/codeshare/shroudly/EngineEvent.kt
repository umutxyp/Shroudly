package me.codeshare.shroudly

/*
 * The engine's stdout: one JSON object per line (core/src/main.c, engine.c).
 * Read here without org.json so the parser runs in plain JVM tests too.
 * The lines are flat (no nested objects or arrays); anything else is text.
 */

sealed class EngineEvent {
    data class Ready(val port: Int, val techniques: Int) : EngineEvent()
    data class Stats(
        val connsTotal: Long,
        val connsActive: Long,
        val bytesUp: Long,
        val bytesDown: Long,
        val desync: Long,
        val tls: Long,
        val http: Long,
        val probeOk: Long,
        val probeFail: Long,
    ) : EngineEvent()

    /* bypass, blocked, cut, unreachable, send_failed: something about one site. */
    data class Host(
        val kind: String,
        val host: String,
        val strategy: String,
        val attempts: Int,
        val family: String,
        val note: String?,
        val stage: String?,
        val alert: Boolean,
        val siteOk: Boolean,
    ) : EngineEvent()

    data class Error(val message: String, val code: Int?) : EngineEvent()
    object Stopped : EngineEvent()
    data class Other(val type: String) : EngineEvent()
    data class Text(val line: String) : EngineEvent()

    companion object {
        private val HOST_KINDS = setOf("bypass", "blocked", "cut", "unreachable", "send_failed")

        fun parse(line: String): EngineEvent {
            val m = FlatJson.parse(line) ?: return Text(line)
            fun str(k: String) = m[k] as? String
            fun num(k: String) = (m[k] as? Number)?.toLong() ?: 0L
            fun bool(k: String) = m[k] == true
            val type = str("type") ?: return Text(line)
            return when (type) {
                "ready" -> Ready(num("port").toInt(), num("techniques").toInt())
                "stats" -> Stats(
                    num("conns_total"), num("conns_active"), num("bytes_up"), num("bytes_down"),
                    num("desync"), num("tls"), num("http"), num("probe_ok"), num("probe_fail"),
                )
                in HOST_KINDS -> Host(
                    kind = type,
                    host = str("host") ?: "",
                    strategy = str("strategy") ?: "",
                    attempts = num("attempts").toInt(),
                    family = str("family") ?: "",
                    note = str("note"),
                    stage = str("stage"),
                    alert = bool("alert"),
                    siteOk = bool("site_ok"),
                )
                "error" -> Error(str("msg") ?: "code ${num("code")}", (m["code"] as? Number)?.toInt())
                "stopped" -> Stopped
                else -> Other(type)
            }
        }
    }
}

/* A JSON object of strings, numbers, booleans and nulls. null for anything else. */
object FlatJson {
    fun parse(s: String): Map<String, Any?>? {
        val p = Parser(s.trim())
        return try {
            val m = p.obj()
            if (p.i != p.s.length) null else m
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private class Parser(val s: String) {
        var i = 0

        fun fail(): Nothing = throw IllegalArgumentException("bad json at $i")

        fun ws() { while (i < s.length && s[i].isWhitespace()) i++ }

        fun expect(c: Char) { ws(); if (i >= s.length || s[i] != c) fail(); i++ }

        fun obj(): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            expect('{')
            ws()
            if (i < s.length && s[i] == '}') { i++; return out }
            while (true) {
                ws()
                val k = string()
                expect(':')
                out[k] = value()
                ws()
                if (i >= s.length) fail()
                when (s[i++]) {
                    ',' -> continue
                    '}' -> return out
                    else -> fail()
                }
            }
        }

        fun value(): Any? {
            ws()
            if (i >= s.length) fail()
            return when (s[i]) {
                '"' -> string()
                't' -> word("true", true)
                'f' -> word("false", false)
                'n' -> word("null", null)
                else -> number()
            }
        }

        fun word(w: String, v: Any?): Any? {
            if (!s.startsWith(w, i)) fail()
            i += w.length
            return v
        }

        fun number(): Number {
            val start = i
            if (i < s.length && s[i] == '-') i++
            while (i < s.length && (s[i].isDigit() || s[i] in ".eE+-")) i++
            val t = s.substring(start, i)
            if (t.isEmpty() || t == "-") fail()
            return t.toLongOrNull() ?: t.toDoubleOrNull() ?: fail()
        }

        fun string(): String {
            if (i >= s.length || s[i] != '"') fail()
            i++
            val b = StringBuilder()
            while (true) {
                if (i >= s.length) fail()
                val c = s[i++]
                when (c) {
                    '"' -> return b.toString()
                    '\\' -> {
                        if (i >= s.length) fail()
                        when (val e = s[i++]) {
                            '"', '\\', '/' -> b.append(e)
                            'b' -> b.append('\b')
                            'f' -> b.append('\u000c')
                            'n' -> b.append('\n')
                            'r' -> b.append('\r')
                            't' -> b.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) fail()
                                b.append(s.substring(i, i + 4).toIntOrNull(16)?.toChar() ?: fail())
                                i += 4
                            }
                            else -> fail()
                        }
                    }
                    else -> b.append(c)
                }
            }
        }
    }
}
