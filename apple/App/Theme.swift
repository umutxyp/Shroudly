import SwiftUI

/* The Android app's colours (res/values/colors.xml): a dark window and the
 * icon's blue. */
enum Theme {
    static let background = Color(red: 0x0B / 255, green: 0x0F / 255, blue: 0x17 / 255)
    static let card = Color(red: 0x13 / 255, green: 0x19 / 255, blue: 0x26 / 255)
    static let accent = Color("AccentColor")
    static let off = Color(white: 0.35)
    static let secondaryText = Color(white: 0.65)
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
    @ViewBuilder func listBackgroundHidden() -> some View {
        #if os(tvOS)
        self
        #elseif os(macOS)
        // The Mac's scroll bar, drawn wide beside a narrow window, hidden:
        // the trackpad and the wheel scroll as before.
        self.scrollContentBackground(.hidden).scrollIndicators(.hidden)
        #else
        self.scrollContentBackground(.hidden)
        #endif
    }

    /* The main screen's scroll view (it scrolls only when it does not fit):
     * no scroll bar on the Mac. */
    @ViewBuilder func macScrollBarHidden() -> some View {
        #if os(macOS)
        self.scrollIndicators(.hidden)
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
