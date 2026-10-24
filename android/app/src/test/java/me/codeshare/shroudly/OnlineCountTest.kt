package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.zip.GZIPOutputStream

class OnlineCountTest {
    /* Tasks are run by the test, one at a time, in order. */
    private class Clock : Pinger.Scheduler {
        class Task(val delayMs: Long, val run: () -> Unit) { var cancelled = false; var done = false }
        val tasks = mutableListOf<Task>()

        override fun schedule(delayMs: Long, task: () -> Unit): () -> Unit {
            val t = Task(delayMs, task)
            tasks += t
            return { t.cancelled = true }
        }

        fun pending() = tasks.filter { !it.cancelled && !it.done }

        /* Runs the next task; its delay, or null when none is left. */
        fun next(): Long? {
            val t = pending().firstOrNull() ?: return null
            t.done = true
            t.run()
            return t.delayMs
        }
    }

    private class Sent(val path: String, val body: String, val timeoutMs: Int)

    private val uuid = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    private fun pinger(clock: Clock, sent: MutableList<Sent>, answer: () -> String? = { "{\"online\":88,\"interval\":60}" },
                       dozing: () -> Boolean = { false }) =
        Pinger({ path, body, timeoutMs -> sent += Sent(path, body, timeoutMs); answer() }, clock, dozing = dozing)

    @Test
    fun sendsOnlyTheIdAsTheDesktopDoes() {
        val clock = Clock()
        val sent = mutableListOf<Sent>()
        val p = pinger(clock, sent)
        assertNull(p.sync(shareOnlineCount = true, protectionOn = true))
        assertEquals(0L, clock.next())                      // at once
        assertEquals(1, sent.size)
        assertEquals("/v1/ping", sent[0].path)
        assertEquals(10000, sent[0].timeoutMs)
        val m = Regex("^\\{\"id\":\"([^\"]+)\"\\}$").find(sent[0].body)
        assertTrue("body is {\"id\":\"<uuid>\"} and nothing else: ${sent[0].body}", m != null)
        assertTrue(uuid.matches(m!!.groupValues[1]))
        assertEquals(Pinger.body(m.groupValues[1]), sent[0].body)
        // Again after the server's interval, with the same id.
        assertEquals(60_000L, clock.next())
        assertEquals(sent[0].body, sent[1].body)
    }

    @Test
    fun aFreshIdEachTimeCountingStarts() {
        val clock = Clock()
        val sent = mutableListOf<Sent>()
        val p = pinger(clock, sent)
        p.start(); clock.next()
        val first = sent.last().body
        val dropped = p.stop()
        assertEquals(first, Pinger.body(dropped!!))
        p.start(); clock.next()
        assertNotEquals(first, sent.last().body)
    }

    @Test
    fun stopsWhenProtectionStops() {
        val clock = Clock()
        val sent = mutableListOf<Sent>()
        val p = pinger(clock, sent)
        p.sync(shareOnlineCount = true, protectionOn = true)
        clock.next()
        assertEquals(1, sent.size)
        assertEquals(1, clock.pending().size)               // the next ping, waiting
        // Protection off: the id comes back for a leave, and the next ping is cancelled.
        val dropped = p.sync(shareOnlineCount = true, protectionOn = false)
        assertEquals(sent[0].body, Pinger.body(dropped!!))
        assertFalse(p.counting)
        assertTrue(clock.pending().isEmpty())
        assertNull(clock.next())
        assertEquals(1, sent.size)
        // Stopping again: nothing more to leave.
        assertNull(p.sync(shareOnlineCount = true, protectionOn = false))
    }

    @Test
    fun aPingAlreadyDueWhenProtectionStopsSendsNothing() {
        val clock = Clock()
        val sent = mutableListOf<Sent>()
        val p = pinger(clock, sent)
        p.start()
        val due = clock.tasks.single()
        p.stop()
        due.run()                                           // ran anyway (it had started)
        assertTrue(sent.isEmpty())
        assertTrue(clock.pending().isEmpty())
    }

    @Test
    fun settingOffSendsNoRequest() {
        val clock = Clock()
        val sent = mutableListOf<Sent>()
        val p = pinger(clock, sent)
        assertNull(p.sync(shareOnlineCount = false, protectionOn = true))
        assertNull(p.sync(shareOnlineCount = false, protectionOn = false))
        assertNull(p.sync(shareOnlineCount = true, protectionOn = false))
        assertFalse(p.counting)
        assertNull(clock.next())
        assertTrue(sent.isEmpty())
        // Switched off while counting: stops, and nothing more is sent.
        p.sync(shareOnlineCount = true, protectionOn = true)
        clock.next()
        assertTrue(p.sync(shareOnlineCount = false, protectionOn = true) != null)
        assertNull(clock.next())
        assertEquals(1, sent.size)
    }

    @Test
    fun followsTheServersIntervalLikeTheDesktop() {
        assertEquals(180L, Pinger.nextDelayS("{\"online\":900,\"interval\":180}"))
        assertEquals(60L, Pinger.nextDelayS("{\"online\":1}"))
        assertEquals(60L, Pinger.nextDelayS("{\"online\":1,\"interval\":0}"))
        assertEquals(30L, Pinger.nextDelayS("{\"interval\":5}"))
        assertEquals(30L, Pinger.nextDelayS("{\"interval\":-5}"))
        assertEquals(900L, Pinger.nextDelayS("{\"interval\":86400}"))
        assertNull(Pinger.nextDelayS("<html>error</html>"))

        val clock = Clock()
        val sent = mutableListOf<Sent>()
        var answer: () -> String? = { throw IOException("offline") }
        val p = Pinger({ path, body, t -> sent += Sent(path, body, t); answer() }, clock)
        p.start()
        clock.next()
        assertEquals(30_000L, clock.pending().single().delayMs)   // failed: again in 30 s
        answer = { "{\"online\":3,\"interval\":300}" }
        clock.next()
        assertEquals(300_000L, clock.pending().single().delayMs)
        answer = { null }                                         // counted, answer unreadable: same pace
        clock.next()
        assertEquals(300_000L, clock.pending().single().delayMs)
        answer = { "Bad gateway" }                                // not the server's answer
        clock.next()
        assertEquals(30_000L, clock.pending().single().delayMs)
    }

    @Test
    fun nothingIsSentWhileThePhoneDozes() {
        val clock = Clock()
        val sent = mutableListOf<Sent>()
        var dozing = true
        val p = pinger(clock, sent, dozing = { dozing })
        p.start()
        clock.next()
        assertTrue(sent.isEmpty())
        assertEquals(60_000L, clock.pending().single().delayMs)
        dozing = false
        clock.next()
        assertEquals(1, sent.size)
    }

    @Test
    fun theRequestIsTheDesktopsByteForByte() {
        val id = "f95cc186-4e1a-4068-8598-2935496a1fed"
        val req = OnlineHttp.request("/v1/ping", Pinger.body(id), "2.6.1", "tr").toString(Charsets.ISO_8859_1)
        // Electron 43.8.1's net.request, as electron/presence.js makes it
        // (captured), with Windows as the system.
        val expected = "POST /v1/ping HTTP/1.1\r\n" +
            "Host: shroudly.codeshare.me\r\n" +
            "Connection: keep-alive\r\n" +
            "Content-Length: 45\r\n" +
            "content-type: application/json\r\n" +
            "Sec-Fetch-Site: none\r\n" +
            "Sec-Fetch-Mode: no-cors\r\n" +
            "Sec-Fetch-Dest: empty\r\n" +
            "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Shroudly/2.6.1 Chrome/150.0.7871.250 Electron/43.8.1 Safari/537.36\r\n" +
            "Accept-Encoding: gzip, deflate, br, zstd\r\n" +
            "Accept-Language: tr\r\n" +
            "\r\n" +
            "{\"id\":\"$id\"}"
        assertEquals(expected, req)
        // Nothing that names Android, the phone or its maker.
        for (word in listOf("Android", "Dalvik", "Linux", "Mobile", "okhttp")) assertFalse(word, req.contains(word, ignoreCase = true))
    }

    @Test
    fun theUserAgentFollowsTheDesktopsElectron() {
        var dir: File? = File("").absoluteFile
        while (dir != null && !File(dir, "package.json").isFile) dir = dir.parentFile
        assertTrue("the repository's package.json", dir != null)
        val pkg = File(dir, "package.json").readText()
        val electron = Regex("\"electron\"\\s*:\\s*\"\\^?~?([0-9.]+)\"").find(pkg)?.groupValues?.get(1)
        assertEquals("package.json has another Electron: update OnlineHttp.ELECTRON and CHROME (its process.versions.chrome)",
            electron, OnlineHttp.ELECTRON)
    }

    @Test
    fun acceptLanguageIsWhatChromiumWouldSend() {
        // What Electron 43 sent with --lang=<tag>.
        val seen = mapOf(
            "tr-TR" to "tr", "pt" to "pt-BR", "pt-PT" to "pt-PT", "pt-BR" to "pt-BR", "es" to "es", "es-ES" to "es",
            "es-MX" to "es-419", "zh" to "zh-CN", "zh-CN" to "zh-CN", "zh-HK" to "zh-TW", "zh-TW" to "zh-TW",
            "zh-Hant-TW" to "zh-TW", "zh-Hans-CN" to "zh-CN", "en-AU" to "en-GB", "en-GB" to "en-GB", "en-US" to "en-US",
            "fa-IR" to "fa", "de-AT" to "de", "fr-CA" to "fr", "id-ID" to "id", "in-ID" to "id", "ms-MY" to "ms",
            "nb-NO" to "nb", "no" to "nb", "he-IL" to "he", "iw-IL" to "he", "tl" to "fil", "fil-PH" to "fil",
            "am-ET" to "am", "ru-RU" to "ru", "ar-EG" to "ar",
        )
        for ((tag, want) in seen) assertEquals(tag, want, OnlineHttp.chromiumLocale(listOf(tag)))
        // Not among Chromium's languages: the next one the user has, else en-US.
        assertEquals("ru", OnlineHttp.chromiumLocale(listOf("kk-KZ", "ru-RU")))
        assertEquals("tr", OnlineHttp.chromiumLocale(listOf("az-Latn-AZ", "tr-TR")))
        assertEquals("en-US", OnlineHttp.chromiumLocale(listOf("tk-TM")))
        assertEquals("en-US", OnlineHttp.chromiumLocale(emptyList()))
    }

    @Test
    fun readsCloudflaresGzippedChunkedAnswer() {
        val json = "{\"online\":88,\"interval\":60}"
        val gz = ByteArrayOutputStream().also { o -> GZIPOutputStream(o).use { it.write(json.toByteArray()) } }.toByteArray()
        val raw = ByteArrayOutputStream()
        raw.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n" +
            "Connection: keep-alive\r\nContent-Encoding: gzip\r\n\r\n").toByteArray())
        raw.write("${Integer.toHexString(gz.size)}\r\n".toByteArray()); raw.write(gz); raw.write("\r\n0\r\n\r\n".toByteArray())
        val resp = Http1.read(ByteArrayInputStream(raw.toByteArray()), OnlineHttp.MAX_BODY)
        assertEquals(200, resp.status)
        assertEquals(json, OnlineHttp.text(resp))
        assertEquals(60L, Pinger.nextDelayS(OnlineHttp.text(resp)!!))
        assertEquals(json, OnlineHttp.text(Http1.Response(200, emptyMap(), json.toByteArray())))
        assertNull(OnlineHttp.text(Http1.Response(200, mapOf("content-encoding" to "br"), byteArrayOf(1, 2, 3))))
    }
}
