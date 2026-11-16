import Foundation

/*
 * Where this copy came from: the App Store (and TestFlight), or the IPA on
 * GitHub for TrollStore and re-signing (apple/scripts/make-ipa.sh builds it
 * with SHROUDLY_SIDELOAD). The store copy leaves out what its rules do not
 * take from an app like this one: running this device as a proxy for other
 * people (Snowflake, "Help people in censored countries" inside Shroudly),
 * which is not what Shroudly is for. The link to Psiphon's Conduit, an app
 * made for that, stays.
 */
enum Distribution {
    static var sideloaded: Bool {
        #if SHROUDLY_SIDELOAD
        return true
        #else
        return false
        #endif
    }

    /* Snowflake inside the app: only outside the store. */
    static var snowflake: Bool { sideloaded }
}
