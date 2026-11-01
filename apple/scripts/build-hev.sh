#!/bin/bash
#
# Builds hev-socks5-tunnel, the tun2socks the packet tunnel runs, into
# apple/third_party/HevSocks5Tunnel.xcframework: iPhone and iPad (arm64), the
# iOS simulator (arm64, x86_64) and macOS (arm64, x86_64), each a static
# library with hev's own header and module map (import HevSocks5Tunnel).
#
# The source is apple/third_party/hev-socks5-tunnel at the pinned release
# (scripts/fetch-hev.js fetches it; it is checked file by file here first).
# It is built in a copy, with hev's own Makefile as its build-apple.sh does,
# so the checked tree stays exactly as it was fetched.
#
# Does nothing when the framework there was built from the same pin by this
# same script; delete it to build again.
#
#   apple/scripts/build-hev.sh

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
third="$here/../third_party"
src="$third/hev-socks5-tunnel"
out="$third/HevSocks5Tunnel.xcframework"
work="$third/build/hev"

# The deployment targets of the app (Config/Shroudly.xcconfig).
IOS_MIN=16.0
MACOS_MIN=13.0

node "$here/fetch-hev.js" --verify
pin="$(cat "$src/.shroudly-pin") $(shasum -a 256 "$0" | cut -d' ' -f1)"
if [ -f "$out/.shroudly-pin" ] && [ "$(cat "$out/.shroudly-pin")" = "$pin" ]; then
  echo "[hev] $out is up to date"
  exit 0
fi

rm -rf "$work" "$out"
mkdir -p "$work"

# build <sdk> <arch> <min-version flag>
build() {
  local sdk=$1 arch=$2 min=$3 dir="$work/$1-$2"
  echo "[hev] building for $sdk $arch"
  mkdir -p "$dir"
  (cd "$src" && tar --exclude .git --exclude .shroudly-pin -cf - .) | (cd "$dir" && tar -xf -)
  local cc="xcrun --sdk $sdk clang"
  # REV_ID: the pinned commit, not whatever git finds around the copy.
  make -s -C "$dir" PP="$cc" CC="$cc" REV_ID=d9dca26 \
    CFLAGS="-arch $arch $min -fvisibility=hidden" LFLAGS="-arch $arch $min" static >/dev/null
  libtool -static -no_warning_for_no_symbols -o "$dir/libhev-socks5-tunnel.a" \
    "$dir/bin/libhev-socks5-tunnel.a" \
    "$dir/third-part/lwip/bin/liblwip.a" \
    "$dir/third-part/yaml/bin/libyaml.a" \
    "$dir/third-part/hev-task-system/bin/libhev-task-system.a"
}

build iphoneos arm64 "-mios-version-min=$IOS_MIN"
build iphonesimulator arm64 "-mios-simulator-version-min=$IOS_MIN"
build iphonesimulator x86_64 "-mios-simulator-version-min=$IOS_MIN"
build macosx arm64 "-mmacosx-version-min=$MACOS_MIN"
build macosx x86_64 "-mmacosx-version-min=$MACOS_MIN"

mkdir -p "$work/sim" "$work/mac" "$work/include/HevSocks5Tunnel"
lipo -create "$work/iphonesimulator-arm64/libhev-socks5-tunnel.a" "$work/iphonesimulator-x86_64/libhev-socks5-tunnel.a" \
  -output "$work/sim/libhev-socks5-tunnel.a"
lipo -create "$work/macosx-arm64/libhev-socks5-tunnel.a" "$work/macosx-x86_64/libhev-socks5-tunnel.a" \
  -output "$work/mac/libhev-socks5-tunnel.a"
cp "$src/src/hev-main.h" "$src/module.modulemap" "$work/include/HevSocks5Tunnel/"

xcodebuild -create-xcframework \
  -library "$work/iphoneos-arm64/libhev-socks5-tunnel.a" -headers "$work/include" \
  -library "$work/sim/libhev-socks5-tunnel.a" -headers "$work/include" \
  -library "$work/mac/libhev-socks5-tunnel.a" -headers "$work/include" \
  -output "$out" >/dev/null
echo "$pin" > "$out/.shroudly-pin"
rm -rf "$work"
echo "[hev] $out ready"
