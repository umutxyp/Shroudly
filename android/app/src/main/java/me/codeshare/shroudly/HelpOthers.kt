package me.codeshare.shroudly

/*
 * "Help people in censored countries" (About): a phone helps best through
 * an app made for it, which keeps running on its own: Psiphon's Conduit, or
 * Orbot's Kindness Mode (a Snowflake proxy for Tor). The desktop runs a
 * Snowflake proxy itself (electron/snowflake.js); a phone's battery and
 * background limits are better left to those apps. Their pages, in the
 * app's language where Conduit's site has it.
 */
object HelpOthers {
    const val CONDUIT_PACKAGE = "ca.psiphon.conduit"
    const val ORBOT_PACKAGE = "org.torproject.android"

    /* The languages of conduit.psiphon.ca that this app speaks too. */
    private val CONDUIT_LANGS = setOf("ar", "az", "de", "en", "es", "fa", "fr", "hi", "id", "ms", "my", "pt", "ru", "tr", "vi")

    fun conduitUrl(language: String): String =
        "https://conduit.psiphon.ca/${if (language in CONDUIT_LANGS) language else "en"}/download"

    fun orbotUrl(): String = "https://play.google.com/store/apps/details?id=$ORBOT_PACKAGE"
}
