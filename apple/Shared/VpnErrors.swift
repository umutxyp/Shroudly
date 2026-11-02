import Foundation

/*
 * Whether iOS refused the VPN configuration because this copy of the app is
 * signed without Apple's VPN permission (the Network Extension entitlement;
 * issue #65). Signing with a free Apple ID (AltStore, SideStore, Sideloadly
 * and the like) removes it, and iOS then never shows its "Add VPN
 * Configurations" question at all: reading the configuration, which asks
 * the user nothing, already fails with "permission denied"
 * (NEConfigurationErrorDomain 10, not public; or NEVPNError's
 * configurationReadWriteFailed with those words). A save fails the same way
 * when the user says no, so a save counts only with the domain that says it.
 */
enum VpnErrors {
    static func missingPermission(domain: String, code: Int, text: String, reading: Bool) -> Bool {
        if domain == "NEConfigurationErrorDomain" && code == 10 { return true }
        guard reading else { return false }
        return (domain == "NEVPNErrorDomain" && code == 5) || text.lowercased().contains("permission denied")
    }

    static func missingPermission(_ error: Error, reading: Bool) -> Bool {
        let e = error as NSError
        return missingPermission(domain: e.domain, code: e.code, text: e.localizedDescription, reading: reading)
    }

    /* How to install a copy that can make a VPN (README, iPhone and iPad). */
    static let installHelp = URL(string: "https://github.com/umutxyp/Shroudly#iphone-and-ipad")!
}
