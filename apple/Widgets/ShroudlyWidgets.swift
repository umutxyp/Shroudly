import AppIntents
import SwiftUI
import WidgetKit

/*
 * Shroudly's widgets: on the Home Screen and the Lock Screen (iPhone, iPad)
 * and the desktop (Mac), whether protection is on, with a switch on iPhone
 * and iPad (SetProtection, run by the app in the background); on the Mac a
 * tap opens the app. And, from iOS 18, a control for Control Center and the
 * Lock Screen. What they show comes from the app group (WidgetState).
 */
@main
struct ShroudlyWidgets: WidgetBundle {
    var body: some Widget {
        StatusWidget()
        #if os(iOS)
        if #available(iOS 18.0, *) { ProtectionControl() }
        #endif
    }
}

struct StatusEntry: TimelineEntry {
    let date: Date
    let on: Bool
    let since: Date?
}

struct StatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> StatusEntry { StatusEntry(date: Date(), on: true, since: Date()) }

    func getSnapshot(in context: Context, completion: @escaping (StatusEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : now())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StatusEntry>) -> Void) {
        // The app and the tunnel ask for a new one whenever it changes; this
        // is only the fallback.
        completion(Timeline(entries: [now()], policy: .after(Date().addingTimeInterval(30 * 60))))
    }

    private func now() -> StatusEntry { StatusEntry(date: Date(), on: WidgetState.on, since: WidgetState.since) }
}

struct StatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "status", provider: StatusProvider()) { e in
            StatusView(entry: e)
                .containerBackground(for: .widget) { Color(red: 0x0B / 255, green: 0x0F / 255, blue: 0x17 / 255) }
        }
        .configurationDisplayName("Shroudly")
        .description(Text(tr("tagline")))
        #if os(iOS)
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
        #else
        .supportedFamilies([.systemSmall, .systemMedium])
        #endif
    }
}

struct StatusView: View {
    let entry: StatusEntry
    @Environment(\.widgetFamily) private var family

    // The logo's blue (the app's accent lives in the app's own settings).
    private var tint: Color { entry.on ? Color(red: 0x0A / 255, green: 0x6C / 255, blue: 0xF5 / 255) : Color(white: 0.55) }
    private var title: String { tr(entry.on ? "protected" : "notProtected") }

    var body: some View {
        switch family {
        #if os(iOS)
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "power").font(.title2.weight(.semibold))
            }
            .widgetAccentable()
        case .accessoryRectangular:
            HStack(spacing: 8) {
                Image(systemName: entry.on ? "checkmark.shield.fill" : "shield.slash")
                VStack(alignment: .leading) {
                    Text("Shroudly").font(.headline)
                    Text(title).font(.caption)
                }
            }
        case .accessoryInline:
            Label(title, systemImage: entry.on ? "checkmark.shield" : "shield.slash")
        #endif
        case .systemMedium:
            HStack(spacing: 16) {
                orb
                VStack(alignment: .leading, spacing: 6) {
                    Text("Shroudly").font(.caption).foregroundStyle(.secondary)
                    Text(title).font(.title3.weight(.semibold)).foregroundStyle(.white)
                    if entry.on, let s = entry.since {
                        Text(s, style: .timer).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    switchButton
                }
                Spacer(minLength: 0)
            }
        default:
            VStack(spacing: 8) {
                orb
                Text(title).font(.footnote.weight(.semibold)).foregroundStyle(.white).lineLimit(1).minimumScaleFactor(0.7)
                switchButton
            }
        }
    }

    private var orb: some View {
        ZStack {
            Circle().fill(tint.opacity(entry.on ? 0.2 : 0.12)).frame(width: 58, height: 58)
            Circle().stroke(tint, lineWidth: 3).frame(width: 48, height: 48)
            Image(systemName: "power").font(.system(size: 20, weight: .semibold)).foregroundStyle(tint)
        }
    }

    @ViewBuilder private var switchButton: some View {
        #if os(iOS)
        Button(intent: SetProtection(!entry.on)) {
            Text(tr(entry.on ? "stop" : "start")).font(.caption2.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.7)
        }
        .tint(tint)
        #endif
    }
}

#if os(iOS)
/* iOS 18: Shroudly in Control Center and on the Lock Screen's controls. */
@available(iOS 18.0, *)
struct ProtectionControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "me.codeshare.shroudly.protection") {
            ControlWidgetToggle("Shroudly", isOn: WidgetState.on, action: SetProtection()) { on in
                Label(tr(on ? "protected" : "notProtected"), systemImage: on ? "checkmark.shield.fill" : "shield")
            }
        }
        .displayName("Shroudly")
        .description(LocalizedStringResource(stringLiteral: tr("tagline")))
    }
}
#endif
