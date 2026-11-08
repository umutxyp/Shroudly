import SwiftUI

/* The Android app's colours (res/values/colors.xml): a dark window and the
 * icon's blue. */
enum Theme {
    static let background = Color(red: 0x0B / 255, green: 0x0F / 255, blue: 0x17 / 255)
    static let card = Color(red: 0x12 / 255, green: 0x18 / 255, blue: 0x26 / 255)
    /* The chosen accent (Settings, Accent.swift); the logo's blue by default. */
    static var accent: Color { Accent.current }
    static let off = Color(white: 0.35)
    static let secondaryText = Color(red: 0xA3 / 255, green: 0xAF / 255, blue: 0xC4 / 255)
    // The desktop app's (app/globals.css): text, its quieter shades, lines,
    // the raised surface, the states and the corner radii.
    static let text = Color(red: 0xE8 / 255, green: 0xED / 255, blue: 0xF6 / 255)
    static let faintText = Color(red: 0x7D / 255, green: 0x89 / 255, blue: 0xA1 / 255)
    static let line = Color(red: 148 / 255, green: 163 / 255, blue: 184 / 255).opacity(0.12)
    static let lineStrong = Color(red: 148 / 255, green: 163 / 255, blue: 184 / 255).opacity(0.22)
    static let cardRaised = Color(red: 0x1D / 255, green: 0x26 / 255, blue: 0x38 / 255)
    static let ok = Color(red: 0x34 / 255, green: 0xD3 / 255, blue: 0x99 / 255)
    static let warn = Color(red: 0xFB / 255, green: 0xBF / 255, blue: 0x24 / 255)
    static let danger = Color(red: 0xF8 / 255, green: 0x71 / 255, blue: 0x71 / 255)
    static let radius: CGFloat = 16
    static let radiusSmall: CGFloat = 11
}

extension Theme {
    /* Apple TV: no browser, and the help card points at phone apps. */
    static var isTV: Bool {
        #if os(tvOS)
        true
        #else
        false
        #endif
    }
}

extension View {
    /* The list's own background hidden, so the theme's shows; Apple TV's
     * lists have none to hide (and no such modifier). */
    /* Room above a form's first section. A tab whose first section has no
     * title (Settings, Connection: the technique) otherwise starts right
     * under the tabs above it, as if stuck to them. */
    @ViewBuilder func topRoom(_ points: CGFloat) -> some View {
        #if os(tvOS)
        self
        #else
        if #available(iOS 17.0, macOS 14.0, *) {
            self.contentMargins(.top, points, for: .scrollContent)
        } else {
            self.safeAreaInset(edge: .top, spacing: 0) { Color.clear.frame(height: points) }
        }
        #endif
    }

    @ViewBuilder func listBackgroundHidden() -> some View {
        #if os(tvOS)
        self
        #elseif os(macOS)
        // The Mac's scroll bar, drawn wide beside a narrow window, hidden:
        // the trackpad and the wheel scroll as before.
        self.scrollContentBackground(.hidden).scrollIndicators(.never)
        #else
        self.scrollContentBackground(.hidden)
        #endif
    }

    /* The main screen's scroll view (it scrolls only when it does not fit):
     * no scroll bar on the Mac. */
    @ViewBuilder func macScrollBarHidden() -> some View {
        #if os(macOS)
        // .never: hidden even with "Show scroll bars: Always" in System Settings.
        self.scrollIndicators(.never)
        #else
        self
        #endif
    }
}

/* A link to a web page. Apple TV has no browser: there the label is shown with
 * the address under it, to open on a phone or computer. */
struct WebLink<Label: View>: View {
    let url: URL
    @ViewBuilder let label: () -> Label

    var body: some View {
        #if os(tvOS)
        VStack(alignment: .leading, spacing: 4) {
            label()
            Text(url.absoluteString.replacingOccurrences(of: "https://", with: ""))
                .font(.caption).foregroundStyle(Theme.secondaryText)
        }
        .focusable()
        #else
        Link(destination: url, label: label)
        #endif
    }
}
