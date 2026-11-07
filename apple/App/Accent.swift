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

    /* An unknown or missing id (the logo's blue, chosen before 2.6.63) is sky. */
    static func color(_ id: String?) -> Color {
        options.first { $0.id == id }?.color ?? options[0].color
    }

    static var current: Color { color(UserDefaults.standard.string(forKey: key)) }

    private static func hex(_ v: Int) -> Color {
        Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}

/* Settings: the swatches in a row, the chosen one ringed. */
struct AccentPicker: View {
    @AppStorage(Accent.key) private var accent = Accent.defaultId

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 5), spacing: 12) {
            ForEach(Accent.options, id: \.id) { o in
                Button { accent = o.id } label: {
                    Circle()
                        .fill(o.color)
                        .frame(width: 30, height: 30)
                        .overlay(Circle().stroke(.white, lineWidth: accent == o.id ? 3 : 0).padding(-4))
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(o.id)
                .accessibilityAddTraits(accent == o.id ? .isSelected : [])
            }
        }
        .padding(.vertical, 4)
    }
}
