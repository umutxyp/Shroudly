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
