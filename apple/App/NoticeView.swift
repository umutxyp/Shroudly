import SwiftUI

/*
 * Said once, before protection is first turned on: what the VPN
 * configuration is for and that nothing is collected. App Store guideline
 * 5.4 asks a VPN app to say what user data it collects, on a screen of its
 * own, before the service is first used.
 */
struct NoticeView: View {
    let onContinue: () -> Void

    var body: some View {
        #if os(tvOS)
        tv
        #else
        card
        #endif
    }

    #if os(tvOS)
    /* Apple TV: the whole screen, read from the couch. A sheet there was a
     * small box with the text cut off below and Continue out of sight. */
    @FocusState private var onButton: Bool
    private var tv: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            HStack(alignment: .center, spacing: 90) {
                VStack(alignment: .leading, spacing: 28) {
                    Image(systemName: "lock.shield")
                        .font(.system(size: 110))
                        .foregroundStyle(Theme.accent)
                    Text(tr("appleNoticeTitle"))
                        .font(.system(size: 60, weight: .bold))
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(width: 520, alignment: .leading)
                VStack(alignment: .leading, spacing: 34) {
                    Text(tr("appleNoticeBody"))
                        .font(.system(size: 32))
                        .lineSpacing(8)
                        .foregroundStyle(Theme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                    // No browser on Apple TV: the address, to read.
                    Text(tr("androidPrivacyPolicy") + ": " + Ids.privacyURL.absoluteString.replacingOccurrences(of: "https://", with: ""))
                        .font(.system(size: 26))
                        .foregroundStyle(Theme.faintText)
                    Button(action: onContinue) {
                        Text(tr("appleNoticeContinue"))
                            .font(.system(size: 34, weight: .semibold))
                            .frame(minWidth: 460)
                            .padding(.vertical, 8)
                    }
                    .focused($onButton)
                    .padding(.top, 10)
                }
                .frame(maxWidth: 980, alignment: .leading)
            }
            .padding(.horizontal, 120)
        }
        .onAppear { onButton = true }
    }
    #endif

    private var card: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Image(systemName: "lock.shield")
                        .font(.system(size: 44))
                        .foregroundStyle(Theme.accent)
                    Text(tr("appleNoticeTitle"))
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(.white)
                    Text(tr("appleNoticeBody"))
                        .foregroundStyle(Theme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                    Link(tr("androidPrivacyPolicy"), destination: Ids.privacyURL)
                    Button(action: onContinue) {
                        Text(tr("appleNoticeContinue"))
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 8)
                }
                .padding(24)
                .frame(maxWidth: 520)
            }
        }
        #if os(macOS)
        .frame(width: 420, height: 460)
        #endif
    }
}
