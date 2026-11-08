#if os(iOS)
import UIKit
#endif

/* The Taptic Engine's taps (iPhone): a firm one when protection comes on, a
 * light one when it goes off; nothing elsewhere. */
enum Feel {
    static func on() {
        #if os(iOS)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
    }

    static func off() {
        #if os(iOS)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
    }
}
