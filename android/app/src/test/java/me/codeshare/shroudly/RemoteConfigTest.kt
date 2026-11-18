package me.codeshare.shroudly

import me.codeshare.shroudly.RemoteConfig.Take as T
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/* Remote settings: only a signed, understood file; rules by platform,
 * country and version; engine arguments only from the allow-list. The same
 * as electron/remote-config.js. */
class RemoteConfigTest {
    private val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private val pub = java.util.Base64.getEncoder().encodeToString(pair.public.encoded)
    private fun sign(text: String) = Signature.getInstance("SHA256withECDSA").run {
        initSign(pair.private); update(text.toByteArray()); java.util.Base64.getEncoder().encodeToString(sign())
    }

    @Test
    fun onlyASignedFileChecks() {
        val f = """{"v":1,"serial":2,"set":{"quicOff":false}}"""
        assertTrue(RemoteConfig.verify(f, sign(f), pub))
        assertFalse(RemoteConfig.verify("$f ", sign(f), pub))
        assertFalse("another key: the apps' own", RemoteConfig.verify(f, sign(f)))
    }

    @Test
    fun eachSourceInTurnUntilOneGivesAUsableFile() {
        val f3 = """{"v":1,"serial":3,"set":{"quicOff":true}}"""
        val f1 = """{"v":1,"serial":1}"""

        assertEquals(T.NEW, RemoteConfig.worth(f3, sign(f3), 2, pub))
        assertEquals(T.SAME, RemoteConfig.worth(f3, sign(f3), 3, pub))
        assertEquals("older", T.UNUSABLE, RemoteConfig.worth(f1, sign(f1), 3, pub))
        assertEquals("signed wrong", T.UNUSABLE, RemoteConfig.worth("$f3 ", sign(f3), 2, pub))
        assertEquals("a portal's page", T.UNUSABLE, RemoteConfig.worth("<html>", sign(f3), 2, pub))
        assertEquals("expired", T.UNUSABLE, RemoteConfig.worth("""{"v":1,"serial":5,"expires":"2020-01-01T00:00:00Z"}""",
            sign("""{"v":1,"serial":5,"expires":"2020-01-01T00:00:00Z"}"""), 2, pub))

        val asked = mutableListOf<String>()
        val take = { t: String, s: String -> RemoteConfig.worth(t, s, 2, pub) }
        // The first source's file and signature do not match: the mirror is asked.
        assertEquals(T.NEW, RemoteConfig.ask(listOf("a", "b"), { src -> asked += src; (if (src == "a") "$f3 " else f3) to sign(f3) }, take))
        assertEquals(listOf("a", "b"), asked)
        // The first source gives a usable one: the mirror is not asked.
        asked.clear()
        assertEquals(T.NEW, RemoteConfig.ask(listOf("a", "b"), { src -> asked += src; f3 to sign(f3) }, take))
        assertEquals(listOf("a"), asked)
        // Unusable from both; no answer from either (offline, or not HTTP 200).
        assertEquals(T.UNUSABLE, RemoteConfig.ask(listOf("a", "b"), { _ -> f1 to sign(f1) }, take))
        assertNull(RemoteConfig.ask(listOf("a", "b"), { _ -> null }, take))
        assertNull(RemoteConfig.ask(listOf("a", "b"), { _ -> throw java.io.IOException("offline") }, take))
        // The first does not answer, the mirror has the one in use: done.
        assertEquals(T.SAME, RemoteConfig.ask(listOf("a", "b"), { src -> if (src == "a") null else f3 to sign(f3) },
            { t, s -> RemoteConfig.worth(t, s, 3, pub) }))

        // When the next check is due: six hours on, an hour on, or as before.
        val now = 100_000_000_000L
        assertEquals(now, RemoteConfig.checkedAt(T.NEW, now))
        assertEquals(now, RemoteConfig.checkedAt(T.SAME, now))
        assertEquals(now - 5 * 3600_000L, RemoteConfig.checkedAt(T.UNUSABLE, now))
        assertNull(RemoteConfig.checkedAt(null, now))
    }

    @Test
    fun onlyVersionOneWithASerialNotExpired() {
        assertTrue(RemoteConfig.parse("""{"v":1,"serial":1}""") != null)
        assertNull(RemoteConfig.parse("""{"v":2,"serial":1}"""))
        assertNull(RemoteConfig.parse("""{"v":1,"serial":0}"""))
        assertNull(RemoteConfig.parse("""{"v":1,"serial":3,"expires":"2020-01-01T00:00:00Z"}"""))
        assertNull(RemoteConfig.parse("{"))
    }

    @Test
    fun rulesMatchPlatformCountryAndVersion() {
        val c = RemoteConfig.parse("""{"v":1,"serial":4,"set":{"quicOff":true,"reportOffer":"fault"},
            "rules":[{"when":{"platform":["android"],"country":["IR"]},"set":{"quicOff":false}},
                     {"when":{"appMin":"2.6.90"},"set":{"reportOffer":"never"}}]}""")
        assertEquals(false, RemoteConfig.effective(c, RemoteConfig.Ctx("android", "ir", "2.6.81")).optBoolean("quicOff", true))
        assertEquals(true, RemoteConfig.effective(c, RemoteConfig.Ctx("android", "TR", "2.6.81")).optBoolean("quicOff", false))
        assertEquals("fault", RemoteConfig.reportOffer(RemoteConfig.effective(c, RemoteConfig.Ctx("android", "TR", "2.6.81"))))
        assertEquals("never", RemoteConfig.reportOffer(RemoteConfig.effective(c, RemoteConfig.Ctx("android", "TR", "2.6.100"))))
    }

    @Test
    fun engineArgumentsOnlyFromTheAllowList() {
        val a = RemoteConfig.engineArgs(JSONArray(listOf("--strategy", "fake(ttl=4),split(sni)", "--upstream-file", "/x", "--port", "1", "--drop-quic", "--decoy-name", "www.digikala.com", "--decoy-name", "bad name")))
        assertEquals(listOf("--strategy", "fake(ttl=4),split(sni)", "--drop-quic", "--decoy-name", "www.digikala.com"), a)
        val args = Engine.args(1, 0, emptyList(), remote = a)
        assertTrue(args.joinToString(" ").endsWith("--decoy-name www.digikala.com") && "/x" !in args)
    }

    @Test
    fun theRepositorysFileChecksWithTheAppsKey() {
        // The unit tests run in android/app.
        val root = generateSequence(java.io.File("").absoluteFile) { it.parentFile }.first { java.io.File(it, "remote.json").exists() }
        assertTrue(RemoteConfig.verify(java.io.File(root, "remote.json").readText(), java.io.File(root, "remote.json.sig").readText()))
    }

    @Test
    fun aRestartOnlyWhenWhatTheEngineUsesChanges() {
        val empty = RemoteConfig.engineKey(JSONObject())
        assertEquals(empty, RemoteConfig.engineKey(JSONObject("""{"reportOffer":"never"}""")))
        assertEquals(empty, RemoteConfig.engineKey(JSONObject("""{"engineArgs":["--port","1"]}""")))
        assertTrue(empty != RemoteConfig.engineKey(JSONObject("""{"engineArgs":["--drop-quic"]}""")))
        assertTrue(empty != RemoteConfig.engineKey(JSONObject("""{"torAllowed":false}""")))
    }

    @Test
    fun bridgesOnlyOfTheirOwnTransport() {
        val eff = JSONObject("""{"torBridges":{"snowflake":["snowflake 192.0.2.3:80 ABC","obfs4 x"],"bad kind!":["x"]}}""")
        assertEquals(mapOf("snowflake" to listOf("snowflake 192.0.2.3:80 ABC")), RemoteConfig.torBridges(eff))
        assertEquals(listOf("www.aparat.com"), RemoteConfig.decoyNames(JSONObject("""{"decoyNames":{"IR":["www.aparat.com","bad name"]}}"""), "ir"))
    }
}
