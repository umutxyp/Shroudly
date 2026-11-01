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
