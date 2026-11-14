import SwiftUI
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/* The logo chosen in Settings, the same choice as the desktop's and
 * Android's (scripts/logo/variants.py draws them all). On iPhone and iPad it
 * is the app's icon on the home screen (an alternate icon: iOS says so in a
 * notice of its own as it changes); on the Mac, the Dock icon while the app
 * runs (the icon in Applications stays the one Apple installed). Apple TV
 * lets an app change neither, so it is not offered there. "classic" is the
 * logo Shroudly has always had. */
enum Logos {
    static let key = "logo"

    static let groups: [(id: String, ids: [String])] = [
        ("styles", ["classic", "flat", "line", "paper", "key", "veil", "terminal", "night", "coral"]),
        ("days", ["newyear", "halloween", "valentine", "spring", "ramadan", "winter"]),
        ("countries", ["tr", "ir", "ru", "cn", "pk", "az", "kz", "eg", "vn"]),
    ]
    static let ids = groups.flatMap { $0.ids }

    static func chosen(_ v: String?) -> String { ids.contains(v ?? "") ? v! : "classic" }

    static var current: String { chosen(UserDefaults.standard.string(forKey: key)) }

    /* The picture of logo `id` inside the app (its header, About): the
     * classic one is the app's own "Logo". */
    static func picture(_ id: String?) -> String {
        let v = chosen(id)
        return v == "classic" ? "Logo" : "LogoPick-\(v)"
    }

    /* Kept, and put where the system lets it go. */
    static func choose(_ id: String) {
        let v = chosen(id)
        UserDefaults.standard.set(v, forKey: key)
        apply(v)
    }

    /* The Mac: at launch too, since the Dock forgets it when the app quits. */
    static func apply(_ id: String = current) {
        #if os(iOS)
        let name: String? = id == "classic" ? nil : "Logo-\(id)"
        guard UIApplication.shared.supportsAlternateIcons, UIApplication.shared.alternateIconName != name else { return }
        UIApplication.shared.setAlternateIconName(name) { _ in }
        #elseif os(macOS)
        NSApp.applicationIconImage = id == "classic" ? nil : NSImage(named: "LogoDock-\(id)")
        #endif
    }
}

#if !os(tvOS)
/* Settings: the three groups, each a grid of pictures, the chosen one ringed. */
struct LogoPicker: View {
    @AppStorage(Logos.key) private var logo = "classic"
    @AppStorage(Accent.followKey) private var follows = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(tr("logoChoiceDesc"))
                .font(.footnote)
                .foregroundStyle(Theme.secondaryText)
            ForEach(Logos.groups, id: \.id) { group in
                Text(group.id == "styles" ? tr("logoStyles") : group.id == "days" ? tr("logoDays") : tr("logoCountries"))
                    .font(.caption.weight(.semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(Theme.secondaryText)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 46, maximum: 60), spacing: 10)], spacing: 10) {
                    ForEach(group.ids, id: \.self) { id in
                        let on = Logos.chosen(logo) == id
                        Button {
                            guard Logos.chosen(logo) != id else { return }
                            logo = id
                            Logos.choose(id)
                        } label: {
                            Image("LogoPick-\(id)")
                                .resizable()
                                .aspectRatio(1, contentMode: .fit)
                                .padding(3)
                                .overlay(RoundedRectangle(cornerRadius: 13).stroke(on ? Theme.accent : .clear, lineWidth: 3))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(tr("logoSwatch", ["n": "\(Logos.ids.firstIndex(of: id)! + 1)", "total": "\(Logos.ids.count)"]))
                        .accessibilityAddTraits(on ? .isSelected : [])
                    }
                }
            }
            // "Colour follows the icon": the app's accent is the logo's.
            Toggle(isOn: $follows) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(tr("logoAccent"))
                    Text(tr("logoAccentDesc")).font(.footnote).foregroundStyle(Theme.secondaryText)
                }
            }
        }
        .padding(.vertical, 4)
    }
}
#endif
