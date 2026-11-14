import SwiftUI

/* The accent colour, chosen in Settings: the desktop app's nine
 * (components/Appearance.js), sky by default as there. Kept in the app's own
 * defaults; the main screen, links and switches follow it. */
enum Accent {
    static let key = "accent"

    static let options: [(id: String, color: Color)] = [
        ("sky", hex(0x38BDF8)),
        ("teal", hex(0x2DD4BF)),
        ("emerald", hex(0x34D399)),
        ("lime", hex(0xA3E635)),
        ("amber", hex(0xFBBF24)),
        ("rose", hex(0xFB7185)),
        ("pink", hex(0xF472B6)),
        ("violet", hex(0xA78BFA)),
        ("indigo", hex(0x818CF8)),
    ]

    static let defaultId = "sky"
    static let followKey = "accentFollowsLogo"

    /* The accent each logo matches, for "Colour follows the icon": the one
     * nearest the logo's main colour (components/Appearance.js LOGO_ACCENT,
     * android Accent.kt: the same table). */
    static let logoAccent: [String: String] = [
        "classic": "sky", "flat": "sky", "line": "sky", "paper": "sky", "key": "amber", "veil": "violet",
        "terminal": "emerald", "night": "teal", "coral": "rose",
        "newyear": "emerald", "halloween": "amber", "valentine": "rose", "spring": "emerald", "ramadan": "amber", "winter": "sky",
        "tr": "rose", "ir": "rose", "ru": "sky", "cn": "rose", "pk": "emerald", "az": "rose", "kz": "teal", "eg": "rose", "vn": "rose",
    ]

    /* The accent in use: the logo's while the colour follows the icon (the
     * one picked kept for when it is off), else the one picked. */
    static func effective(_ picked: String?, follows: Bool, logo: String) -> String {
        follows ? (logoAccent[Logos.chosen(logo)] ?? defaultId) : (picked ?? defaultId)
    }

    /* An unknown or missing id (the logo's blue, chosen before 2.6.63) is sky. */
    static func color(_ id: String?) -> Color {
        options.first { $0.id == id }?.color ?? options[0].color
    }

    static var current: Color {
        let d = UserDefaults.standard
        return color(effective(d.string(forKey: key), follows: d.bool(forKey: followKey), logo: Logos.current))
    }

    private static func hex(_ v: Int) -> Color {
        Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}

/* Settings: the swatches in a row, the chosen one ringed. */
struct AccentPicker: View {
    @AppStorage(Accent.key) private var accent = Accent.defaultId
    @AppStorage(Accent.followKey) private var follows = false
    @AppStorage(Logos.key) private var logo = "classic"

    var body: some View {
        let shown = Accent.effective(accent, follows: follows, logo: logo)
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 5), spacing: 12) {
            ForEach(Accent.options, id: \.id) { o in
                // A colour picked by hand: the icon's no longer followed.
                Button { follows = false; accent = o.id } label: {
                    Circle()
                        .fill(o.color)
                        .frame(width: 30, height: 30)
                        .overlay(Circle().stroke(.white, lineWidth: shown == o.id ? 3 : 0).padding(-4))
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(o.id)
                .accessibilityAddTraits(shown == o.id ? .isSelected : [])
            }
        }
        .padding(.vertical, 4)
    }
}
