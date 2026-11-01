import Foundation

/*
 * Asks for a rating with Apple's own prompt (SwiftUI's requestReview, which
 * the system may or may not show) when RatingSchedule says it is a good
 * moment: Shroudly is live on its store, has worked for this user on several
 * days, is on and working now, and the back-off is over. At most once per
 * run of the app; the window must be in front.
 */
@MainActor
enum RatingPrompt {
    /* Protection on for this long first, so it is not asked during a start. */
    static let settle: TimeInterval = 30

    struct Moment: Equatable {
        let phase: TunnelController.Phase
        let active: Bool
    }

    private static var askedThisSession = false

    static func maybeAsk(controller: TunnelController, active: Bool, request: () -> Void) async {
        guard active, controller.phase == .on, !askedThisSession else { return }
        let store = RatingStore()
        // What can be told without the network or the tunnel, first.
        guard RatingSchedule.shouldAsk(store.load(), now: Date(), protectionWorking: true, storeLive: true,
                                       askedThisSession: false) else { return }
        let since = controller.connectedSince ?? Date()
        let wait = max(0, settle - Date().timeIntervalSince(since)) + 2
        // Cancelled when protection or the window's state changes meanwhile.
        do { try await Task.sleep(nanoseconds: UInt64(wait * 1e9)) } catch { return }
        let working = await controller.healthy()
        let live = await StoreFlagCache().isLive()
        guard !Task.isCancelled, controller.phase == .on,
              RatingSchedule.shouldAsk(store.load(), now: Date(), protectionWorking: working, storeLive: live,
                                       askedThisSession: askedThisSession) else { return }
        askedThisSession = true
        store.update { RatingSchedule.recordRequest(&$0, at: Date()) }
        request()
    }
}
