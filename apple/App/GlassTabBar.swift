import SwiftUI

#if !os(tvOS)
/*
 * The desktop's tabs (app/page.js), icons only, in a bar of Liquid Glass (iOS and
 * macOS 26; frosted material before), floating over the page.
 *
 * As the system's tab bar on iPhone: a press lifts a lens over the tab under
 * the finger, the finger can slide along the bar with the lens following
 * (a light tick at each tab), and letting go opens that tab. A click on the
 * Mac does the same at once.
 */
struct GlassTabBar: View {
    @Binding var tab: ContentView.MainTab
    @Environment(\.layoutDirection) private var direction
    // The tab under the finger while pressed.
    @State private var pressed: ContentView.MainTab?
    @Namespace private var lens

    private let tabs = ContentView.MainTab.shown

    var body: some View {
        GeometryReader { g in
            HStack(spacing: 0) {
                ForEach(tabs, id: \.self) { t in item(t) }
            }
            .padding(4)
            .frame(width: g.size.width, height: g.size.height)
            .contentShape(Capsule())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .local)
                    .onChanged { v in
                        let t = at(v.location.x, width: g.size.width)
                        if pressed != t {
                            Feel.select()
                            withAnimation(.spring(response: 0.28, dampingFraction: 0.72)) { pressed = t }
                        }
                    }
                    .onEnded { v in
                        let t = at(v.location.x, width: g.size.width)
                        withAnimation(.spring(response: 0.34, dampingFraction: 0.8)) {
                            tab = t
                            pressed = nil
                        }
                    }
            )
        }
        .frame(height: 52)
        .modifier(GlassBackground())
        .accessibilityElement(children: .contain)
    }

    private func at(_ x: CGFloat, width: CGFloat) -> ContentView.MainTab {
        let w = max(1, width - 8) / CGFloat(tabs.count)
        var i = Int(((x - 4) / w).rounded(.down))
        i = min(max(i, 0), tabs.count - 1)
        // Right to left: the first tab is on the right.
        if direction == .rightToLeft { i = tabs.count - 1 - i }
        return tabs[i]
    }

    private func item(_ t: ContentView.MainTab) -> some View {
        let shown = pressed ?? tab
        let on = t == shown
        // The icons alone, the cleanest; the name is what VoiceOver says.
        return Image(systemName: t == .protection && t == tab ? "shield.fill" : t.icon)
            .font(.system(size: 20, weight: on ? .semibold : .regular))
            .frame(height: 24)
        .foregroundStyle(t == tab || on ? Theme.accent : Theme.secondaryText)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 2)
        .background {
            if on {
                Lens(pressed: pressed != nil)
                    .matchedGeometryEffect(id: "lens", in: lens)
            }
        }
        .scaleEffect(on && pressed != nil ? 1.08 : 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(t.title)
        .accessibilityAddTraits(t == tab ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { tab = t }
    }
}

/* The lens over the chosen tab: the accent lightly, brighter while pressed. */
private struct Lens: View {
    let pressed: Bool

    var body: some View {
        Capsule()
            .fill(Theme.accent.opacity(pressed ? 0.22 : 0.14))
            .overlay(Capsule().stroke(LinearGradient(colors: [.white.opacity(pressed ? 0.35 : 0.18), Theme.accent.opacity(0.25)],
                                                     startPoint: .top, endPoint: .bottom), lineWidth: 1))
            .shadow(color: Theme.accent.opacity(pressed ? 0.35 : 0), radius: 10)
            .padding(.vertical, 1)
    }
}

/* The Taptic Engine's ticks (iPhone); nothing elsewhere. */
enum Feel {
    static func select() {
        #if os(iOS)
        UISelectionFeedbackGenerator().selectionChanged()
        #endif
    }

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

/* Liquid Glass where the system has it, frosted glass before. */
private struct GlassBackground: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .glassEffect(.regular.tint(Theme.card.opacity(0.35)), in: Capsule())
                .shadow(color: .black.opacity(0.35), radius: 16, y: 6)
        } else {
            content
                .background(.ultraThinMaterial, in: Capsule())
                .background(Theme.card.opacity(0.6), in: Capsule())
                .overlay(Capsule().stroke(Theme.lineStrong, lineWidth: 1))
                .shadow(color: .black.opacity(0.35), radius: 16, y: 6)
        }
    }
}
#endif
