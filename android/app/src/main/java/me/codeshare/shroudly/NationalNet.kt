package me.codeshare.shroudly

import android.net.Network
import java.net.URL
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection

/* "Only this country's network works": the rest of the world cut while
 * sites inside the country still open (Iran's shutdowns, and others like
 * them), which no app gets past. Asked only once the path check finds
 * nothing reachable (ShroudlyVpnService.onPath), as the desktop does
 * (electron/national-net.js, the same sites): an HTTPS request to large
 * sites hosted inside their own countries, all at once, over the network
 * underneath (never the VPN). One that answers with its own valid
 * certificate says the country's network is up; a sign-in page cannot show
 * a site's certificate, so it is not taken for one. */
object NationalNet {
    val DOMESTIC: Map<String, List<String>> = linkedMapOf(
        "IR" to listOf("www.digikala.com", "www.aparat.com", "divar.ir", "www.zoomit.ir", "www.shaparak.ir"),
        "RU" to listOf("ya.ru", "vk.com", "www.gosuslugi.ru"),
        "BY" to listOf("www.belta.by", "onliner.by"),
        "KZ" to listOf("egov.kz", "kaspi.kz"),
        "UZ" to listOf("my.gov.uz", "kun.uz"),
        "TM" to listOf("turkmenportal.com"),
        "AZ" to listOf("www.azertag.az"),
        "CN" to listOf("www.baidu.com", "www.qq.com"),
        "TR" to listOf("www.turkiye.gov.tr"),
        "PK" to listOf("www.ptcl.com.pk"),
        "IQ" to listOf("www.ina.iq"),
        "ET" to listOf("www.ethiotelecom.et"),
        "MM" to listOf("www.mpt.com.mm"),
    )

    private const val TIMEOUT_MS = 5000

    /* (country, host) of the first site that answers, or null. `reach`
     * stands in for the network in tests. */
    fun answers(
        network: Network?,
        reach: (String) -> Boolean = { host -> reachable(network, host) },
    ): Pair<String, String>? {
        val list = DOMESTIC.flatMap { (cc, hosts) -> hosts.map { cc to it } }
        val pool = Executors.newFixedThreadPool(8) { r -> Thread(r, "national-net").apply { isDaemon = true } }
        return try {
            pool.invokeAny(
                list.map { (cc, host) -> Callable { if (reach(host)) cc to host else throw IllegalStateException(host) } },
                TIMEOUT_MS * 2L + 500, TimeUnit.MILLISECONDS,
            )
        } catch (_: Exception) {
            null
        } finally {
            pool.shutdownNow()
        }
    }

    /* An HTTPS request to the site over `network`: true once the server
     * answered with a valid certificate for that name (any HTTP status). */
    private fun reachable(network: Network?, host: String): Boolean {
        val url = URL("https://$host/")
        val conn = (network?.openConnection(url) ?: url.openConnection()) as HttpsURLConnection
        return try {
            conn.connectTimeout = TIMEOUT_MS
            conn.readTimeout = TIMEOUT_MS
            conn.instanceFollowRedirects = false
            conn.requestMethod = "HEAD"
            conn.useCaches = false
            conn.responseCode > 0
        } catch (_: Exception) {
            false
        } finally {
            conn.disconnect()
        }
    }

    /* The guide in the app's language (Shutdowns-<code> in the wiki). */
    fun guideUrl(language: String): String {
        val code = when (language) { "iw" -> "he"; "in" -> "id"; else -> language }
        val known = setOf("am", "ar", "az", "be", "bn", "de", "en", "es", "fa", "fr", "he", "hi", "id", "ja", "kk", "ku", "ky",
            "ms", "my", "ps", "pt", "ru", "tg", "th", "tk", "tr", "uk", "ur", "uz", "vi", "zh")
        return "https://github.com/umutxyp/Shroudly/wiki/Shutdowns-${if (code in known) code else "en"}"
    }
}
