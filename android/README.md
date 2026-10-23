# Shroudly for Android

The Android app: a VPN that hands every other app's connections to the same
engine the desktop runs (`core/`).

    apps -> VPN interface -> hev-socks5-tunnel -> engine (SOCKS5 on 127.0.0.1)
         -> the network, with the engine's techniques

- `app/src/main/java/me/codeshare/shroudly/` is the app: `ShroudlyVpnService`
  (the VPN, the engine and the tunnel, and watching that they work),
  `Engine` (one run of the engine), `Health` (the checks), `DohForwarder`
  (encrypted DNS for the engine), `CustomDns` (the user's own DNS server:
  DoH, DoT, TCP or UDP), `ProxyCheck` (a network proxy on the phone where
  nothing runs), `MainActivity` (the window),
  `ShroudlyTileService` (the Quick Settings tile), `AppLog` and `Diagnostics`
  ("Share logs"), and `OnlineCount` (the live user count: the desktop's
  request, byte for byte, through the engine while protection is on).
- The engine is built from `core/` by the Gradle build (ndk-build,
  `app/src/main/cpp/Android.mk`) into `libshroudlycore_jni.so`, and runs
  inside the app's process on threads of its own: `engine_main` in
  `core/src/main.c`, the same run as the desktop's `shroudly-core` program,
  with a pipe each way instead of stdin and stdout
  (`app/src/main/cpp/engine_jni.c`).
- hev-socks5-tunnel is fetched at a pinned release and built with the NDK into
  `libhev-socks5-tunnel.so`.
- The strings are the desktop's (`locales/*.json`, 31 languages). The app
  follows the system language, and on Android 13 and later the per-app
  language setting; it has no language choice of its own.

## Building

Needs Node.js, JDK 17 or later, and the Android SDK with platform 36,
build-tools 36.0.0 and NDK 28.2.13676358 (`ANDROID_HOME` set). From the
repository's root:

    node android/scripts/fetch-hev.js           # hev-socks5-tunnel at its pin
    node android/scripts/gen-strings.js         # strings from locales/*.json
    node android/scripts/gen-block-ips.js       # known block-page addresses
    node android/scripts/gen-raw-apps.js        # services' addresses, to name apps
    cd android && ./gradlew assembleDebug       # app/build/outputs/apk/debug/

Gradle builds the engine from `core/src` (every `.c` there, as the desktop
build does) and hev for every ABI; a change in `core/` is in the next build.

`gen-strings.js`, `gen-block-ips.js` and `gen-raw-apps.js` take `--check` to fail when their
output is out of date instead of writing it (CI runs them so). After changing
a string in `locales/en.json`, change it in every `locales/*.json` and run
`gen-strings.js` again; never edit `res/values*/strings.xml` by hand.

The version (`versionName`, and `versionCode` as major*10000 + minor*100 +
patch) comes from the repository's `package.json`.

Every build first checks `third_party/hev-socks5-tunnel` file by file against
the tree hash recorded in `scripts/fetch-hev.js` (the `verifyHev` task runs
`fetch-hev.js --verify`). A tree that was edited, restored from a cache, or
accepted with `SHROUDLY_HEV_TRUST=1` stops the build until it is fetched again
or its hash is recorded.

## Tests

    cd android && ./gradlew testDebugUnitTest lintDebug assembleDebug assembleRelease
    cd android && ./gradlew -Pshroudly.store=play bundleRelease
    android/scripts/check-16k.sh android/app/build/outputs/apk/release/*.apk \
        android/app/build/outputs/bundle/release/app-release.aab
    android/scripts/emulator-smoke.sh [--abi arm64-v8a|x86_64] [--api 35]

The unit tests run on the JVM. `check-16k.sh` is Google Play's 16 KB page
size check: `zipalign -c -P 16 -v 4` passes and every LOAD segment of every
64-bit `lib*.so` (the engine and hev) is aligned to 0x4000, in the APK and in
every APK bundletool makes from the bundle (it downloads bundletool at a
pinned version and SHA-256 unless `BUNDLETOOL` names the jar); it also checks
that those keep `extractNativeLibs="true"`. The smoke test installs the debug
APK on an emulator, checks that without the VPN consent nothing starts and
nothing crashes, switches protection on, checks that the engine runs inside
the app's process, that the VPN is not its own underlying network, that names
resolve to mapped addresses (198.19.0.0/16), that TCP and UDP go through the
engine, that the engine's port refuses a client without the session's
password, and that a path check through the engine passed; then the user's
own DNS server (DNS over TLS to 1.1.1.1) answers the engine's lookups, and one
that does not answer leaves the built-in one answering. Then it makes
parts fail one at a time (debug builds take `--es cmd test --es what
engine-stop|tunnel-stop|path-check` on `DebugControlActivity`): the engine
stopping under the service (it is back on the same port and an address an app
kept still works), Private DNS by name (strict, `dns.google`, Android 9+),
before and after a tunnel restart, Wi-Fi off and on, airplane mode on and off
(Android 11+), and, on images with root, the app's own network cut with
iptables, after which protection must end by itself and other apps connect
directly. Then everything must work directly after Stop; Proxy only turned
off while the phone's proxy points at it posts a notice to set it back; and
the window: a phone proxy where nothing runs is said; installed from a file it looks for updates on GitHub; installed as Google
Play would (`pm install -i com.android.vending`) it does not; both link the
privacy policy, and "Share logs" opens the share sheet. It needs the
emulator, platform-tools, cmdline-tools and
`system-images;android-<api>;google_apis;<abi>`; `--port` picks the
emulator's port; its log and the app's own are saved to `android/smoke-out/`.

## Two channels: the APK and Google Play

One source tree, one package (`me.codeshare.shroudly`), one `versionCode`:

- **The APK** on GitHub Releases (`assembleRelease`): signed with the app
  signing key, looks for updates on GitHub (`UpdateCheck`).
- **The bundle** for Google Play (`-Pshroudly.store=play bundleRelease`):
  `BuildConfig.STORE_BUILD` is true, so it never asks GitHub, and it is signed
  with the upload key. Play re-signs what it delivers with the same app
  signing key as the APK, so a Play update installs over a GitHub APK and the
  other way round.

At run time `InstallSource` also asks Android who installed the app, every
time the window opens: a copy installed or updated by Google Play
(`com.android.vending`) makes no update check and links the source code
instead of the releases, even when it began as the GitHub APK. The release
workflow keeps the signed bundle as a workflow artifact (`play-bundle`, 90
days), never on the release. The steps in Play Console:
[PLAY_STORE.md](PLAY_STORE.md) (in Turkish).

## Release signing

A release build is signed only when these are set; without them
`assembleRelease` makes an unsigned APK:

| Variable | What |
| --- | --- |
| `ANDROID_KEYSTORE` | path to the keystore (`.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore's password |
| `ANDROID_KEY_ALIAS` | the key's alias |
| `ANDROID_KEY_PASSWORD` | the key's password |

The Play bundle (`-Pshroudly.store=play`) is signed with the upload key
instead: `ANDROID_UPLOAD_KEYSTORE`, `ANDROID_UPLOAD_KEYSTORE_PASSWORD`,
`ANDROID_UPLOAD_KEY_ALIAS` and `ANDROID_UPLOAD_KEY_PASSWORD`.

In CI they come from the secrets `ANDROID_KEYSTORE_B64` (the keystore,
base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and
`ANDROID_KEY_PASSWORD`, and for the bundle `ANDROID_UPLOAD_KEYSTORE_B64`,
`ANDROID_UPLOAD_KEYSTORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS` and
`ANDROID_UPLOAD_KEY_PASSWORD` (without them the bundle is signed with the app
signing key, and the workflow says so). The app signing key never changes:
Play and every installed copy know the app by it. The release workflow
checks the signed APK against the release certificate before publishing it.
Its SHA-256 is

    23ac014b7226343b74c7c9c0a4fd6f1ded97518a3bfd35bcde65b6c1eca8bd76

Anyone can check a downloaded APK the same way:

    apksigner verify --print-certs Shroudly-<version>-Android.apk

and compare "Signer #1 certificate SHA-256 digest" with the value above.

## Notes

- **The engine's port.** For each protection session the app makes a random
  SOCKS5 user name and password, writes them to a file only it can read,
  starts the engine with `--auth-file <path>`, and deletes the file once the
  engine has read it. hev, the encrypted DNS, the health checks and the
  update check use them.
- **The engine inside the app.** Up to 2.6.1 the engine was a program of its
  own, started with ProcessBuilder. Android 12 and later count such a program
  as a "phantom process" of the app and end it (when the phone has more than
  32 of them, or it uses CPU in the background); phone makers' battery
  managers end or freeze it as well (Xiaomi's above all). The VPN then stayed
  up with nothing behind it: a frozen engine left every app without internet
  until it was found hung, a minute later. It now runs on threads of the
  app's process and lives exactly as long as the VPN service.
- **Health.** While protection is on, every app depends on it, so it is
  watched (`Health.kt`): hev's thread runs; the engine's run has not
  returned, it answers STATS within 30 s, and it accepts a SOCKS5 connection
  on its port every 20 s; hev answers what apps send it (packets going in
  with none coming out for 10 s means it is stuck) and is not full (the
  engine holding 95% of hev's session cap for a minute); and a connection
  through the engine reaches the internet (Google's, Cloudflare's, Apple's
  and Microsoft's check hosts, by name). That last check is made soon after
  a start, a restart or a network change, when apps keep sending into the
  tunnel and nothing comes back for 12 s, and while apps are busy at most
  every two minutes; an idle phone is never checked. A failure counts only
  when the network underneath works for everyone but Shroudly: the same
  hosts are tried from the app's own socket, outside the VPN, and when they
  do not answer there either, Android is asked to check the network again
  (`reportNetworkConnectivity`); if Android then finds no internet, it is an
  outage or a slow handover, not Shroudly, and protection stays on. When
  only the way through Shroudly is broken (for instance the phone maker's
  per-app network switch has cut it off), everything is started anew once;
  if that does not help, protection ends, a notification says why, and apps
  connect directly. A stuck or full hev is started again once, then the
  same. The phone is never left "Protected" with no internet.
- **Always-on VPN.** With Android's "Block connections without VPN"
  (lockdown, Android 10+), ending protection would not let apps connect
  directly: Android lets nothing out without the VPN. Protection then never
  ends on its own: it starts everything anew again and again, with a pause
  that doubles from 15 s up to 5 minutes, and a notification and the window
  say honestly that apps are offline until it works. Always-on without
  lockdown ends as usual; if Android starts it again within ten minutes, one
  failed check ends it again, without a second notice. A stuck engine or
  tunnel under always-on ends the app's process, and Android starts the
  VPN again.
- **Engine restarts.** An engine whose run returns, or that stops answering,
  is restarted, up to five times in a row, on the port it had and with the
  password it had, so the tunnel goes on as it was and the addresses apps
  were given stay valid. When the port cannot be had back, or the engine did
  not take connections, or nothing got through it, the new engine gets a new
  port and a new password and the tunnel is started again with them. A run
  that does not return when told to stop cannot be ended from outside: the
  service then ends protection with a notice and ends the app's process, so
  the next start is clean.
- **Mapped addresses.** Apps get stand-in addresses from 198.19.0.0/16 (the
  benchmarking range, which no real host uses); the VPN interface and its DNS
  server are 198.18.0.1 and 198.18.0.2. A stand-in address is valid only
  while the tunnel that handed it out runs. hev hands them out in order from
  the start of its range, so each tunnel gets the next quarter of the range
  (TunnelConfig): an address an app kept from an earlier tunnel is in none of
  the new one's names, the engine refuses it at once (`--fake-net
  198.18.0.0/15`), and the app looks the name up again; it never reaches
  another site. The tunnel is started again only when it has to be: when hev
  stopped, when the engine needed a new port, or when IPv6 comes or goes on
  the network (acted on once the network has been quiet for 3 seconds).
  Connections open at the time are cut.
- **The network underneath** is this app's default network, which is left
  out of the VPN, never the VPN itself; Android follows the system's default
  network for the VPN on its own (`setUnderlyingNetworks` is not called) and
  the VPN is metered when that network is (`setMetered(false)` on Android
  10+, where a VPN otherwise counts as metered even on Wi-Fi). Up to 2.6.1
  the VPN was made its own underlying network, and on any network with
  IPv6 the VPN interface was rebuilt three seconds after every start (it
  judged IPv6 by the VPN's own addresses), cutting every connection and
  mixing up apps' stand-in addresses.
- **Private DNS.** With Android's Private DNS on "automatic", Android tries
  DNS-over-TLS to the VPN's DNS server first, which the engine refuses at
  once, and uses the VPN's DNS. Set to a name ("strict", e.g. `dns.google`),
  Android looks that name up through the VPN, gets a stand-in address and
  speaks DNS-over-TLS (or DNS-over-HTTPS) to it through the tunnel. After the
  tunnel is started again, that address is the old tunnel's and Android does
  not look the server up again by itself, so every name would fail: the app
  then asks Android to check the VPN network again
  (`reportNetworkConnectivity`), which looks it up anew.
- **Battery.** On phones whose maker ends or freezes apps Android itself lets
  run (Xiaomi, Huawei, Samsung and others), or when the user has restricted
  Shroudly's background use, the window asks to let it run without battery
  restrictions and opens the app's page in Settings, where every Android
  version and maker has that setting. No permission is used for it.
- **Share logs** (About) sends, through Android's share sheet and only when
  the user taps it, the app's version, the Android version, phone model and
  build, the network (kind, IPv4/IPv6, 464XLAT, Private DNS (a server's
  name with its first label hidden, unless it is a public resolver's, as
  some services put the user's id there), metered), the
  battery settings, and the last 300 lines of the app's log and the last 300
  site lines. Site lines are kept in memory only; the app's own lines are also
  kept in its private files, so a log from before a crash is still there.
- **No Gradle dependency verification.** The plugins and tools (AGP, Kotlin,
  R8, aapt2, lint) are not checked against `gradle/verification-metadata.xml`.
  aapt2 is published per OS, so the file has to be generated on Linux (CI),
  macOS and Windows and merged, and regenerated with every AGP or Kotlin
  update; one generated on one OS alone breaks the build on the others. The
  Gradle wrapper and its distribution are pinned by SHA-256 (CI checks the
  wrapper jar), and Google's repository is asked only for Google's groups
  (`settings.gradle.kts`).
- **Backups.** Nothing of the app is backed up or copied to a new device
  (`allowBackup="false"` and `res/xml/data_extraction_rules.xml`): its
  settings include which blocked sites were opened.
- **Logs.** Release builds write no site names to the system log.
- **MTU.** The VPN interface's MTU stays 8500, hev's own setting (its TCP
  segments are up to 8191 bytes): TCP from apps ends inside hev and goes on
  over the engine's own sockets, which use the real path's MTU, and a UDP
  datagram larger than a phone's network takes is cut into fragments by the
  engine's socket, as it would be without the VPN.
- **Foreground service.** The VPN service runs in the foreground as
  `systemExempted`, the type Android 14+ gives a VPN the user has allowed;
  there is no `specialUse` fallback (Google Play reviews that type by hand).
  So the service is started only once `VpnService.prepare()` has nothing to
  ask (`ShroudlyVpnService.start` returns false otherwise, and the window
  says the VPN permission is missing); if Android still refuses, the start
  ends with the same message instead of a crash.
