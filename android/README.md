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
    android/scripts/emulator-smoke.sh [--abi arm64-v8a|x86_64] [--api 35]

The unit tests run on the JVM. The smoke test installs the debug APK on an
emulator, switches protection on, checks that names resolve to mapped
addresses (198.19.0.0/16), that TCP and UDP go through the engine, that the
engine's port refuses a client without the session's password (skipped, and
said so, with an engine built before `--auth-file`), and that everything works
directly again after Stop. It needs the emulator, platform-tools,
cmdline-tools and `system-images;android-35;google_apis;<abi>`; its log is
saved to `android/smoke-out/`.

## Release signing

A release build is signed only when these are set; without them
`assembleRelease` makes an unsigned APK:

| Variable | What |
| --- | --- |
| `ANDROID_KEYSTORE` | path to the keystore (`.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore's password |
| `ANDROID_KEY_ALIAS` | the key's alias |
| `ANDROID_KEY_PASSWORD` | the key's password |

In CI they come from the secrets `ANDROID_KEYSTORE_B64` (the keystore,
base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and
`ANDROID_KEY_PASSWORD`. The release workflow checks the signed APK against
the release certificate before publishing it. Its SHA-256 is

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
- **Mapped addresses.** Apps get stand-in addresses from 198.19.0.0/16 (the
  benchmarking range, which no real host uses); the VPN interface and its DNS
  server are 198.18.0.1 and 198.18.0.2. The tunnel keeps running when the
  engine restarts, so these stay valid.
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
