# Shroudly for iPhone, iPad and Mac

The Apple app: a packet tunnel (a VPN on the device, no server) that hands
every other app's connections to the same engine the desktop and Android run
(`core/`). One SwiftUI app for iOS 16+ and macOS 13+, from one set of
targets; the Mac build is for the Mac App Store.

    apps -> tunnel (utun) -> hev-socks5-tunnel -> engine (SOCKS5 on 127.0.0.1)
         -> the network, with the engine's techniques

It mirrors the Android app (`android/README.md`): the engine runs on threads
of the tunnel's own process (`engine_main` from `core/src/main.c`, built with
`SHROUDLY_NO_MAIN`), hev-socks5-tunnel turns the tunnel's packets back into
connections and gives apps stand-in addresses for names (198.19.0.0/16, a
new quarter for every hev, refused by the engine with `--fake-net` once
stale), and the engine resolves names over encrypted DNS through a local
forwarder.

## Layout

| Path | What |
| --- | --- |
| `App/` | The window (SwiftUI): `ContentView` (one big Start/Stop and the status), `SettingsView`, `AboutView`, `NoticeView` (said once before the first start), `TunnelController` (the VPN configuration, start, stop, status), `RatingPrompt`, `Diagnostics` ("Share logs"), `Assets.xcassets` (icons), `PrivacyInfo.xcprivacy` |
| `Tunnel/` | The packet tunnel app extension: `PacketTunnelProvider` (start, stop, watching), `Engine` (one run of the engine), `Hev` (hev-socks5-tunnel), `DohForwarder` (encrypted DNS for the engine), `PrivacyInfo.xcprivacy` |
| `Shared/` | Compiled into the app, the tunnel and the tests: settings, the tunnel's and the engine's settings (`TunnelConfig`), DNS wire format, the shared log, the rating schedule, the store flag, `tr()` |
| `Native/` | C glue the tunnel calls (`import ShroudlyNative`): the engine's run with a pipe each way, and the tunnel's utun descriptor |
| `Localization/` | `<language>.lproj/Localizable.strings` and `InfoPlist.strings`, generated from `locales/*.json` (never edit them) |
| `Tests/` | XCTest unit tests (run on an iOS simulator and on macOS) |
| `Config/` | Build settings (`Shroudly.xcconfig`), signing (`Signing.xcconfig`), Info.plists, entitlements |
| `scripts/` | `fetch-hev.js`, `build-hev.sh`, `gen-strings.js`, `gen-version.js`, `gen-icons.swift`, `test.sh` |
| `Shroudly.xcodeproj` | The project: plain `xcodebuild`, no generator. Its folders are synchronized with the disk, so a new file in `App/`, `Tunnel/`, `Shared/` or `Tests/` (or a new `.c` in `core/src`) is part of the build without touching the project |

Targets: `Shroudly` (the app), `ShroudlyTunnel` (the packet tunnel,
embedded in the app), `ShroudlyEngine` (a static library: every `.c` of
`core/src`, as the desktop and Android build them, and `Native/`), and
`ShroudlyTests`. Each builds for iOS, the iOS simulator and macOS.

Bundle ids: `me.codeshare.shroudly` and `me.codeshare.shroudly.tunnel`. The
app group the two share (settings, logs) is `group.me.codeshare.shroudly` on
iOS and `<team id>.me.codeshare.shroudly` on macOS (`SHROUDLY_APP_GROUP`).

## Building

Needs Xcode 16 or later and Node.js. From the repository's root:

    node apple/scripts/fetch-hev.js      # hev-socks5-tunnel at the Android app's pin, checked
    apple/scripts/build-hev.sh           # -> apple/third_party/HevSocks5Tunnel.xcframework
    node apple/scripts/gen-strings.js    # strings from locales/*.json
    node apple/scripts/gen-version.js    # version from package.json (Config/Version.xcconfig)
    open apple/Shroudly.xcodeproj

`fetch-hev.js` uses `android/scripts/fetch-hev.js` with another folder, so
both apps carry exactly the same hev release (pinned by commit and by a hash
over every file). `build-hev.sh` builds it in a copy, with hev's own Makefile,
for iPhone and iPad, the simulator and the Mac; it does nothing when the
framework there was built from the same pin.

`gen-strings.js` takes every key the Swift sources pass to `tr()` (and the
strategies' `labelKey`s), as `android/scripts/gen-strings.js` does for
Android; `--check` fails when the files are out of date or the project does
not list a language. After changing a string, change it in every
`locales/*.json` and run it again. The version is `package.json`'s, and the
build number Android's version code (major*10000 + minor*100 + patch);
`Config/Version.xcconfig` is not committed, so run `gen-version.js` before
any build that leaves the machine.

Without signing (no team yet, CI):

    cd apple
    xcodebuild -project Shroudly.xcodeproj -scheme Shroudly -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
    xcodebuild -project Shroudly.xcodeproj -scheme Shroudly -destination 'generic/platform=macOS' CODE_SIGNING_ALLOWED=NO build

Signing, App Store Connect and review: [APP_STORE.md](APP_STORE.md) (in
Turkish).

## Tests

    apple/scripts/test.sh            # what CI runs
    apple/scripts/test.sh --quick    # the unit tests on this Mac only

The unit tests run on the newest iPhone simulator and on macOS:

- settings, the engine's arguments and hev's settings, SOCKS credentials,
  the DNS wire format and the forwarder's choice of resolvers;
- the rating schedule (every condition, and the back-off over five years of
  hourly checks), the store flag (parsing, cache, failures);
- the strings: every language in the bundle, the same keys and placeholders
  as English, right-to-left languages;
- the engine built for the platform, in the test's own process as the tunnel
  runs it: a SOCKS5 relay with the session's password, another password
  refused, a stand-in address refused at once, STATS, stopping and starting
  again in the same process, and its memory with the tunnel's full load of
  busy connections;
- the tunnel's whole path without a tunnel: hev on one end of a socket pair
  (each packet framed as utun frames it), with the tunnel's settings, in
  front of the engine; a DNS question gets a stand-in address, and a TCP
  connection to it reaches a local server by name through the engine and
  back.

A packet tunnel itself runs only in a signed app on a device (or a signed Mac
app), so starting one, the system's VPN prompt and on-demand are tested by
hand on a device once the account is approved (APP_STORE.md, step 6).

## Notes

- **Memory.** iOS ends a packet tunnel that holds more than about 50 MB. hev
  takes at most 160 sessions at once, with its own small-memory settings
  (24 KB stacks, 4 KB TCP buffers), and the engine is built here with at most
  192 connections and 192 UDP associations (`MAX_CONNS`, `UDP_ASSOC_MAX`,
  `SHROUDLY_ENGINE_LIMITS` in `Config/Shroudly.xcconfig`; the desktop and
  Android keep 2048 and 1024). A busy connection holds up to about 140 KB in
  the engine; `Tests/MemoryTests.swift` measures 160 of them.
- **The tunnel's descriptor.** hev reads and writes the utun descriptor
  directly rather than through `packetFlow`, found as WireGuard's app finds
  it (`Native/tun_fd.c`).
- **The engine's port** gets a new random SOCKS5 user name and password every
  session, read by the engine from a file that is deleted at once, as on
  Android.
- **Encrypted DNS.** The forwarder asks five operators by address over
  HTTPS (HTTP/2 through URLSession), races them in waves, rests the ones that
  fail and remembers the one that answered. Its connections, like the
  engine's, never go through the tunnel itself.
- **Watching.** An engine whose run returns is started again on its port with
  its password (up to five times in a row); hev is started again once; an
  engine that stops answering for 50 s ends protection with an error, and
  apps then connect directly.
- **IPv6** is routed into the tunnel only while the network underneath has
  it (and "Turn IPv6 off" is off); the tunnel's settings follow it 3 s after
  it comes or goes.
- **Store copy rules**, as for Google Play: no ad blocking, no donation links
  (guideline 3.1.1), no update check (the App Store updates it). A rating is
  asked for only with Apple's own prompt (guideline 5.6.1), when Shroudly is
  live on its store (`stores.json` at the repository's root, on main),
  installed for 3 days, protection came on successfully on 3 different days
  and is on and working now; at most once per run, and after each request
  14, then 28, 56, 112... days pass first.
- **Notice.** Before protection is first turned on, a screen says what the
  VPN configuration is for and that nothing is collected (guideline 5.4).
- **Logs.** "Share logs" sends, only when the user shares it, the version,
  the system and device model, the settings, the last 300 lines of the app's
  and the tunnel's logs, and, while protection is on, the site lines the
  tunnel keeps in memory only.
- **To check on a device** once signing works: that the extension's own DNS
  lookups (used only for names public DNS does not know, such as a router's)
  are not answered by the tunnel's DNS; the memory of the extension under
  load (Xcode's memory gauge); on-demand after a restart.
