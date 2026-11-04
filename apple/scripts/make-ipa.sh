#!/bin/bash
#
# The iPhone and iPad app as an .ipa, for installing it outside the App Store
# until the App Store has it: with TrollStore, or signed again with one's own
# Apple developer account (AltStore, SideStore, Sideloadly…). The app and its
# packet tunnel are signed ad hoc with their entitlements (the VPN extension,
# the app group): TrollStore keeps them, re-signing tools put the account's
# in their place. The App Store's copies are signed by Apple instead
# (release.yml, the apple job, once the developer account is approved).
#
# Then the .ipa is checked: the version is package.json's, the packet tunnel
# is inside, both are arm64 and carry their entitlements, the engine is in.
#
#   apple/scripts/make-ipa.sh <out.ipa>
#
# The build goes to apple/build/ipa (not committed).

set -euo pipefail

[ $# -eq 1 ] || { echo "usage: make-ipa.sh <out.ipa>" >&2; exit 2; }
out_dir="$(cd "$(dirname "$1")" && pwd)"
out="$out_dir/$(basename "$1")"
cd "$(dirname "$0")/../.."
version="$(node -p "require('./package.json').version")"
node apple/scripts/fetch-hev.js
node apple/scripts/fetch-tor.js
apple/scripts/build-hev.sh
node apple/scripts/gen-strings.js --check
node apple/scripts/gen-version.js

cd apple
xcodebuild -project Shroudly.xcodeproj -scheme Shroudly -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath build/ipa CODE_SIGNING_ALLOWED=NO -quiet build
app="build/ipa/Build/Products/Release-iphoneos/Shroudly.app"
ext="$app/PlugIns/ShroudlyTunnel.appex"
[ -d "$ext" ] || { echo "[ipa] the packet tunnel is not in the app" >&2; exit 1; }

# The entitlements as Xcode writes them for a device, its variables filled in.
group="$(xcodebuild -project Shroudly.xcodeproj -target Shroudly -configuration Release -sdk iphoneos -showBuildSettings 2>/dev/null \
  | sed -n 's/^ *SHROUDLY_APP_GROUP = //p' | head -1)"
[ -n "$group" ] || { echo "[ipa] no app group in the build settings" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# The keychain group the widgets share has no team prefix here (ad hoc).
fill() { sed -e "s/\$(SHROUDLY_APP_GROUP)/$group/" -e 's/\$(AppIdentifierPrefix)//' "$1"; }
fill Config/Tunnel-iOS.entitlements > "$work/tunnel.entitlements"
fill Config/App-iOS.entitlements > "$work/app.entitlements"
fill Config/Widgets-iOS.entitlements > "$work/widgets.entitlements"

# Ad hoc signatures, the extensions first (the app's seals them).
codesign --force --sign - --timestamp=none --entitlements "$work/tunnel.entitlements" "$ext"
widgets="$app/PlugIns/ShroudlyWidgets.appex"
if [ -d "$widgets" ]; then codesign --force --sign - --timestamp=none --entitlements "$work/widgets.entitlements" "$widgets"; fi
codesign --force --sign - --timestamp=none --entitlements "$work/app.entitlements" "$app"

mkdir "$work/Payload"
cp -R "$app" "$work/Payload/"
rm -f "$out"
(cd "$work" && zip -qry "$out" Payload)

# ── checked, from the .ipa itself ──
check="$work/check"
mkdir "$check"
unzip -q "$out" -d "$check"
a="$check/Payload/Shroudly.app"
e="$a/PlugIns/ShroudlyTunnel.appex"
fail() { echo "[ipa] FAIL $*" >&2; exit 1; }
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$a/Info.plist")" = "$version" ] || fail "the app's version is not $version"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$a/Info.plist")" = "me.codeshare.shroudly" ] || fail "the app's id"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$e/Info.plist")" = "me.codeshare.shroudly.tunnel" ] || fail "the tunnel's id"
[ "$(/usr/libexec/PlistBuddy -c 'Print :NSExtension:NSExtensionPointIdentifier' "$e/Info.plist")" = "com.apple.networkextension.packet-tunnel" ] || fail "the tunnel is not a packet tunnel"
for bin in "$a/Shroudly" "$e/ShroudlyTunnel"; do
  lipo -archs "$bin" | grep -qw arm64 || fail "$(basename "$bin") is not arm64"
  ents="$(codesign -d --entitlements - --xml "$(dirname "$bin")" 2>/dev/null || codesign -d --entitlements :- "$(dirname "$bin")" 2>/dev/null)"
  echo "$ents" | grep -q "packet-tunnel-provider" || fail "$(basename "$bin") has no VPN entitlement"
  echo "$ents" | grep -q "$group" || fail "$(basename "$bin") has no app group"
done
# The engine is linked into the tunnel, this version's (its own server and
# decoy name options are in it).
for s in shroudly-core --upstream-file --decoy-name; do
  grep -aq -- "$s" "$e/ShroudlyTunnel" || fail "the engine is not in the tunnel ($s)"
done
codesign --verify --deep --strict "$a" || fail "the signature does not verify"
size=$(stat -f %z "$out")
echo "[ipa] $out ($((size / 1024)) KB): version $version, packet tunnel, arm64, entitlements ($group), engine in: ok"
