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

/*
 * What StoreUpdate decides, asked each time the window comes to the front:
 * the App Store copy's required update, or the App Store offered to another
 * copy (iPhone and iPad only). Not on Apple TV.
 */
@MainActor
enum StoreUpdateCheck {
    enum Ask: Equatable { case update(String), move }

    private enum Key {
        static let askedAt = "storeUpdateAskedAt"
        static let checkedAt = "storeUpdateCheckedAt"
        static let version = "storeUpdateVersion"
        static let moveNoes = "storeMoveNoes"
        static let moveNextAt = "storeMoveNextAt"
        static let moveDone = "storeMoveDone"
    }

    static var source: StoreUpdate.Source {
        let url = Bundle.main.appStoreReceiptURL
        return StoreUpdate.source(receiptName: url?.lastPathComponent,
                                  receiptExists: url.map { FileManager.default.fileExists(atPath: $0.path) } ?? false)
    }

    static func next(now: Date = Date()) async -> Ask? {
        #if os(tvOS)
        return nil
        #else
        let d = AppGroup.defaults
        let installed = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        switch source {
        case .appStore:
            guard StoreUpdate.due(d.object(forKey: Key.askedAt) as? Date, now: now, every: StoreUpdate.askEvery),
                  await StoreFlagCache().isLive() else { return nil }
            if StoreUpdate.due(d.object(forKey: Key.checkedAt) as? Date, now: now, every: StoreUpdate.checkEvery),
               let data = try? await StoreFlagCache.download(StoreUpdate.lookupURL, 8) {
                d.set(now, forKey: Key.checkedAt)
                d.set(StoreUpdate.version(inLookup: data), forKey: Key.version)
            }
            guard let v = d.string(forKey: Key.version), StoreUpdate.newer(v, than: installed) else { return nil }
            d.set(now, forKey: Key.askedAt)
            SharedLog(name: "app.log").write("The App Store has Shroudly \(v); asking to update")
            return .update(v)
        case .other:
            #if os(iOS)
            guard !d.bool(forKey: Key.moveDone),
                  now >= (d.object(forKey: Key.moveNextAt) as? Date ?? .distantPast),
                  await StoreFlagCache().isLive() else { return nil }
            // Shown counts as a "not now" until its button is tapped.
            let n = d.integer(forKey: Key.moveNoes) + 1
            d.set(n, forKey: Key.moveNoes)
            d.set(now.addingTimeInterval(Double(StoreUpdate.moveWaitDays(afterNoes: n)) * 86400), forKey: Key.moveNextAt)
            return .move
            #else
            return nil
            #endif
        case .testing:
            return nil
        }
        #endif
    }

    /* The App Store offer's button: never offered again. */
    static func moveTapped() { AppGroup.defaults.set(true, forKey: Key.moveDone) }
}
