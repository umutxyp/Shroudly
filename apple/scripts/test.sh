#!/bin/bash
#
# What CI does for the Apple app (.github/workflows/test.yml, job "apple"),
# on a Mac with Xcode: hev at its pin, the generated files, then without
# signing the app and its packet tunnel built for the iOS simulator, iOS
# devices and macOS, and the unit tests run on an iOS simulator and on this
# Mac (the engine and hev among them, in the test's own process).
#
#   apple/scripts/test.sh            everything
#   apple/scripts/test.sh --quick    the unit tests on this Mac only
#
# The build goes to apple/build (not committed).

set -euo pipefail

cd "$(dirname "$0")/../.."
node apple/scripts/fetch-hev.js
apple/scripts/build-hev.sh
node apple/scripts/gen-strings.js --check
node apple/scripts/gen-version.js

cd apple
xcb() {
  xcodebuild -project Shroudly.xcodeproj -scheme Shroudly -derivedDataPath build \
    CODE_SIGNING_ALLOWED=NO -quiet "$@"
}

if [ "${1:-}" = "--quick" ]; then
  xcb -destination "platform=macOS,arch=$(uname -m)" test
  exit 0
fi

# The newest iPhone simulator this Xcode has.
sim="$(xcrun simctl list devices available --json | node -e '
  const all = JSON.parse(require("fs").readFileSync(0, "utf8")).devices;
  const ios = Object.keys(all).filter((r) => /SimRuntime\.iOS-/.test(r))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const r of ios) {
    const d = all[r].find((x) => /^iPhone/.test(x.name));
    if (d) { console.log(d.udid); process.exit(0); }
  }
  process.exit(1);
')" || { echo "[apple] no iPhone simulator available" >&2; exit 1; }

echo "[apple] unit tests on the iOS simulator ($sim)"
xcb -destination "id=$sim" test
echo "[apple] unit tests on macOS"
xcb -destination "platform=macOS,arch=$(uname -m)" test
echo "[apple] release builds for iPhone and iPad, and for the Mac"
xcb -configuration Release -destination 'generic/platform=iOS' build
xcb -configuration Release -destination 'generic/platform=macOS' build
echo "[apple] all passed"
