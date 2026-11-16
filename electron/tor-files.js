'use strict';

/*
 * The Tor Project's own builds the last way out uses (Tor Expert Bundle):
 * where they are, their pinned SHA-256 (from the Tor Project's signed list
 * for this version, checked against the Tor Browser Developers' key when
 * pinned), and which files of each are needed. One table for the build
 * script (scripts/fetch-tor.js: Android) and the app (tor-download.js: the
 * computers fetch Tor the first time a site needs it, issue #75).
 */
const VERSION = '16.0.1';
// Android stays on 16.0: the Tor Project's Android build of 16.0.1 asks for
// libz.so.1, which no Android has, so Tor ended with code 1 the moment it
// started (2.6.80: Qatar, Iran, Jordan). scripts/fetch-tor.js now refuses
// such a bundle; move on with a version whose Android build passes it.
const ANDROID_VERSION = '16.0';
const versionOf = (bundle) => (String(bundle).startsWith('android-') ? ANDROID_VERSION : VERSION);
const sourcesFor = (version) => [
  `https://dist.torproject.org/torbrowser/${version}/`,
  // The same files on Shroudly's GitHub, for a network that cuts
  // torproject.org (Russia: both names below cut, Tor never fetched, the
  // last way out never there). Checked against the same pinned SHA-256, so
  // only the Tor Project's own file is ever used. One release per version:
  // tor-<version>, made when a version is pinned.
  `https://github.com/umutxyp/Shroudly/releases/download/tor-${version}/`,
  `https://archive.torproject.org/tor-package-archive/torbrowser/${version}/`,
];
const SOURCES = sourcesFor(VERSION);
const SHA256 = {
  'macos-aarch64': '0b7d022017c31e3f972d06465bcd7ac50feb66ac825547419a934914fe4bb156',
  'windows-i686': '4aa4bed8397349612c7dda0e13697b92f40059763a7158d037be7bed5429232c',
  'macos-x86_64': '15464d99adc3bb4de1308260d79878336b04a1ac1aeff83e10f192de7d235946',
  'linux-x86_64': '7039cb16060ab22e669852e55774d894b55f25ea8bd0ab7194d3478429a58725',
  'linux-aarch64': '67040520d44c87ccaaf5aa7df0dc1ff122eb938dbb600ae7722e8b6b75282a4b',
  'windows-x86_64': '9eed3c3ff1fe43df034ce360196c9ec95472560d77ff55614d0cd5120edea27b',
  'android-aarch64': 'bf8f4c63652fd7daa62288713c7fa512f244a5b972808f6251450e5fdfca9120',
  'android-armv7': '13befa352b64c32ba460b63066179bb1c9eaf6c3ea7057ae860dcdd22b8acf7b',
  'android-x86_64': 'ab3152ba164bcd49e50175086c62e40ffa2bf9002a4f6473f77111bd88b0462b',
};
const PT = 'tor/pluggable_transports';
const MAC = { 'tor/tor': 'tor', 'tor/libevent-2.1.7.dylib': 'libevent-2.1.7.dylib', [`${PT}/lyrebird`]: 'lyrebird' };
const LINUX = { 'tor/tor': 'tor', 'tor/libcrypto.so.3': 'libcrypto.so.3', 'tor/libssl.so.3': 'libssl.so.3', 'tor/libevent-2.1.so.7': 'libevent-2.1.so.7', [`${PT}/lyrebird`]: 'lyrebird' };
const WIN = { 'tor/tor.exe': 'tor.exe', [`${PT}/lyrebird.exe`]: 'lyrebird.exe' };
// Windows on ARM runs the x64 build (Tor ships no ARM64 one for Windows).
const DESKTOP = {
  'darwin-arm64': { bundle: 'macos-aarch64', files: MAC },
  'darwin-x64': { bundle: 'macos-x86_64', files: MAC },
  'linux-x64': { bundle: 'linux-x86_64', files: LINUX },
  'linux-arm64': { bundle: 'linux-aarch64', files: LINUX },
  'win32-x64': { bundle: 'windows-x86_64', files: WIN },
  'win32-arm64': { bundle: 'windows-x86_64', files: WIN },
  // 32-bit Windows 10 and 11. 32-bit ARM Linux: Tor ships no build for it.
  'win32-ia32': { bundle: 'windows-i686', files: WIN },
};
const ANDROID = { 'arm64-v8a': 'android-aarch64', 'armeabi-v7a': 'android-armv7', 'x86_64': 'android-x86_64' };
const COMMON = { [`${PT}/pt_config.json`]: 'pt_config.json', 'docs/tor.txt': 'LICENSE-tor.txt', 'docs/lyrebird.txt': 'LICENSE-lyrebird.txt' };

const fileName = (bundle) => `tor-expert-bundle-${bundle}-${versionOf(bundle)}.tar.gz`;

module.exports = { VERSION, ANDROID_VERSION, versionOf, sourcesFor, SOURCES, SHA256, PT, DESKTOP, ANDROID, COMMON, fileName };
