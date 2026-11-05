'use strict';

/*
 * The Tor Project's own builds the last way out uses (Tor Expert Bundle):
 * where they are, their pinned SHA-256 (from the Tor Project's signed list
 * for this version, checked against the Tor Browser Developers' key when
 * pinned), and which files of each are needed. One table for the build
 * script (scripts/fetch-tor.js: Android) and the app (tor-download.js: the
 * computers fetch Tor the first time a site needs it, issue #75).
 */
const VERSION = '16.0';
const SOURCES = [
  `https://dist.torproject.org/torbrowser/${VERSION}/`,
  // The same files, for a network that will not reach the first.
  `https://archive.torproject.org/tor-package-archive/torbrowser/${VERSION}/`,
];
const SHA256 = {
  'macos-aarch64': 'b8da251eccbe9e82f3681ee3af3c97fb4291c4a4e153e5b824bde48a1117cd6a',
  'windows-i686': '24036933df360e6581e26653eccb9f3d069ab1f5e0aa5b80e716cbf6030f84dc',
  'macos-x86_64': '5b1860215c26f2d408392d1d79e798a2f81d65eb939510bb94c11f237bd0bfc3',
  'linux-x86_64': 'cc950ebe9acb80188325c3a2cd8817def7dd7237d6fdcd861bb87b234a0cb2fd',
  'linux-aarch64': 'bed98744e093a0dc3a22be0eecfdce7a33cb36866d3f15fcf011a35bf3513d0d',
  'windows-x86_64': '2ee123e9167318a3742778ff704e75f01d4780f05a14522d451fe011011077c4',
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

const fileName = (bundle) => `tor-expert-bundle-${bundle}-${VERSION}.tar.gz`;

module.exports = { VERSION, SOURCES, SHA256, PT, DESKTOP, ANDROID, COMMON, fileName };
