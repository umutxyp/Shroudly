import SwiftUI

/*
 * The round switch in the middle of Protection, drawn the same on every
 * Shroudly (components/PowerOrb.js on the desktop, PowerOrb.kt on Android):
 * a disc of dark glass with Shroudly's logo in it, its eye shut while off
 * and open once protected; the disc lit in the accent while on (amber when
 * protected but not working). Calm: no waves, no spinning light; only a thin arc turns
 * while starting or stopping, and the colours change softly.
 *
 * On iPhone and iPad it is the switch itself (a tap starts or stops, with a
 * tap of the Taptic Engine); on the Mac it shows the state over the
 * desktop's button; on Apple TV it takes the remote's focus.
 */
struct PowerOrb: View {
    enum Look { case off, busy, on, warn }

    let look: Look
    var size: CGFloat = 170
    /* A tap on it starts or stops (iPhone, iPad, Apple TV). */
    var action: (() -> Void)?

    private var tint: Color {
        switch look {
        case .off: return Theme.faintText
        case .busy, .on: return Theme.accent
        case .warn: return Theme.warn
        }
    }

    private var lit: Bool { look == .on || look == .warn }

    var body: some View {
        if let action {
            Button(action: action) { orb }
                .buttonStyle(OrbPress(size: size))
                .disabled(look == .busy)
        } else {
            orb.accessibilityHidden(true)
        }
    }

    private var orb: some View {
        ZStack {
            // A soft, still light under the disc while protected.
            Circle()
                .fill(RadialGradient(colors: [tint.opacity(lit ? 0.30 : 0), tint.opacity(0)],
                                     center: .center, startRadius: size * 0.35, endRadius: size * 0.72))
                .frame(width: size * 1.44, height: size * 1.44)
            disc
            if look == .busy { Turning(tint: tint, size: size) }
            Mark(look: look, tint: tint)
                .frame(width: size * 0.56, height: size * 0.56)
        }
        .frame(width: size * 1.3, height: size * 1.3)
        .animation(.easeInOut(duration: 0.5), value: look)
        .contentShape(Circle().inset(by: size * 0.15))
    }

    /* Dark glass, lit from above, with a fine bright edge. */
    private var disc: some View {
        ZStack {
            Circle()
                .fill(LinearGradient(colors: lit
                                     ? [tint.opacity(0.20), Theme.card.opacity(0.9)]
                                     : [Theme.cardRaised, Theme.card],
                                     startPoint: .top, endPoint: .bottom))
            Circle()
                .fill(Theme.background.opacity(0.35))
                .padding(size * 0.1)
                .blur(radius: size * 0.06)
            // The light on the upper half, as on glass.
            Ellipse()
                .fill(LinearGradient(colors: [.white.opacity(0.07), .white.opacity(0)], startPoint: .top, endPoint: .bottom))
                .frame(width: size * 0.8, height: size * 0.5)
                .offset(y: -size * 0.24)
                .blur(radius: size * 0.04)
            Circle()
                .strokeBorder(LinearGradient(colors: [.white.opacity(lit ? 0.22 : 0.14), tint.opacity(lit ? 0.55 : 0.10)],
                                             startPoint: .top, endPoint: .bottom), lineWidth: 1.2)
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .shadow(color: .black.opacity(0.45), radius: size * 0.1, y: size * 0.05)
    }
}

/* Starting or stopping: a thin arc going round the disc. */
private struct Turning: View {
    let tint: Color
    let size: CGFloat
    @State private var turn = 0.0

    var body: some View {
        Circle()
            .trim(from: 0, to: 0.18)
            .stroke(tint, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .frame(width: size + 8, height: size + 8)
            .rotationEffect(.degrees(turn))
            .onAppear { withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) { turn = 360 } }
    }
}

/* Shroudly's logo, as at the top left of the window: shut and grey while
 * off (MarkClosed, made from the logo by scripts/logo/logo-closed.py), open
 * and in its own colours once on, the one fading into the other. */
private struct Mark: View {
    let look: PowerOrb.Look
    let tint: Color

    private var open: Bool { look != .off }

    var body: some View {
        ZStack {
            Image("MarkClosed").resizable().interpolation(.high).scaledToFit().opacity(open ? 0 : 1)
            Image("Mark").resizable().interpolation(.high).scaledToFit().opacity(open ? 1 : 0)
        }
        .shadow(color: look == .on || look == .warn ? tint.opacity(0.45) : .black.opacity(0.5), radius: 16)
    }
}

/* A press sinks the orb a little (iPhone, iPad); Apple TV's focus lifts it
 * with a ring round it instead of the system's square platter. */
private struct OrbPress: ButtonStyle {
    let size: CGFloat

    func makeBody(configuration: Configuration) -> some View { Pressed(configuration: configuration, size: size) }

    private struct Pressed: View {
        let configuration: ButtonStyle.Configuration
        let size: CGFloat
        #if os(tvOS)
        @Environment(\.isFocused) private var focused
        #else
        private let focused = false
        #endif

        var body: some View {
            configuration.label
                .overlay(Circle().stroke(Theme.accent, lineWidth: 6).frame(width: size + 24, height: size + 24).opacity(focused ? 1 : 0))
                .scaleEffect(configuration.isPressed ? 0.96 : (focused ? 1.06 : 1))
                .animation(.spring(response: 0.3, dampingFraction: 0.6), value: configuration.isPressed)
                .animation(.easeOut(duration: 0.15), value: focused)
        }
    }
}
