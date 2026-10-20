# Shroudly for Android

The Android app: a VPN that hands every other app's connections to the same
engine the desktop runs (`core/`).

    apps -> VPN interface -> hev-socks5-tunnel -> engine (SOCKS5 on 127.0.0.1)
         -> the network, with the engine's techniques

- `app/src/main/java/me/codeshare/shroudly/` is the app: `ShroudlyVpnService`
  (the VPN, the engine and the tunnel), `DohForwarder` (encrypted DNS for the
  engine), `MainActivity` (the window) and `ShroudlyTileService` (the Quick
  Settings tile).
- The engine is built from `core/` as an executable named
  `libshroudlycore.so`, so Android installs it where an app may run it.
- hev-socks5-tunnel is fetched at a pinned release and built with the NDK into
  `libhev-socks5-tunnel.so`.
- The strings are the desktop's (`locales/*.json`, 31 languages). The app
  follows the system language, and on Android 13 and later the per-app
  language setting; it has no language choice of its own.

## Building

Needs Node.js, JDK 17 or later, and the Android SDK with platform 36,
build-tools 36.0.0 and NDK 28.2.13676358 (`ANDROID_HOME` set). From the
repository's root:

    node scripts/build-core-android.js          # the engine, for every ABI
    node android/scripts/fetch-hev.js           # hev-socks5-tunnel at its pin
    node android/scripts/gen-strings.js         # strings from locales/*.json
    node android/scripts/gen-block-ips.js       # known block-page addresses
    cd android && ./gradlew assembleDebug       # app/build/outputs/apk/debug/

`gen-strings.js` and `gen-block-ips.js` take `--check` to fail when their
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
nothing crashes, switches protection on, checks that names resolve to mapped
addresses (198.19.0.0/16), that TCP and UDP go through the engine, that the
engine's port refuses a client without the session's password (skipped, and
said so, with an engine built before `--auth-file`), and that everything works
directly again after Stop. Then it opens the window: installed from a file it
looks for updates on GitHub; installed as Google Play would
(`pm install -i com.android.vending`) it does not; both link the privacy
policy. It needs the emulator, platform-tools, cmdline-tools and
`system-images;android-35;google_apis;<abi>`; its log is saved to
`android/smoke-out/`.

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
  SOCKS5 user name and password, writes them to a file only it can read, and
  starts the engine with `--auth-file <path>`. hev, the encrypted DNS and the
  update check use them. An engine built before `--auth-file` existed is
  detected and started without it, and everything works as before.
- **Engine restarts.** An engine that exits, or does not answer for a minute
  (it is then ended with SIGKILL), is restarted, up to five times in a row.
  The tunnel pauses as soon as the engine is gone, so nothing is sent to the
  old port while someone else could take it. The new engine gets a new port
  and a new password, and the tunnel is started again with them. If an
  engine cannot be ended, protection stops and a notification says so;
  no second engine is started beside it. An engine left by an earlier run
  of the app is ended before a new one starts.
- **Mapped addresses.** Apps get stand-in addresses from 198.19.0.0/16 (the
  benchmarking range, which no real host uses); the VPN interface and its DNS
  server are 198.18.0.1 and 198.18.0.2. A stand-in address is valid only
  while the tunnel that handed it out runs: an engine restart or a network
  change (IPv6 coming or going, acted on once the network has been quiet for
  3 seconds) restarts the tunnel, and its name table starts over. The engine
  is started with `--fake-net 198.18.0.0/15` (when it takes that option), so
  a connection to an address from before fails at once, and the app looks
  the name up again; with an older engine it fails after the connect timeout.
  Connections open at the time of a restart are cut.
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
- **Foreground service.** The VPN service runs in the foreground as
  `systemExempted`, the type Android 14+ gives a VPN the user has allowed;
  there is no `specialUse` fallback (Google Play reviews that type by hand).
  So the service is started only once `VpnService.prepare()` has nothing to
  ask (`ShroudlyVpnService.start` returns false otherwise, and the window
  says the VPN permission is missing); if Android still refuses, the start
  ends with the same message instead of a crash.
