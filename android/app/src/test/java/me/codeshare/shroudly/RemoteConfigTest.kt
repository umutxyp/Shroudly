package me.codeshare.shroudly

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
