#!/bin/sh
# Starts a built AppImage the way someone on a fresh Ubuntu 24.04 does: with
# FUSE 3 and no libfuse2 (Ubuntu 22.04 and later, Debian 12 and later carry
# only FUSE 3), and without extracting it first. An AppImage on the old FUSE 2
# runtime stops right there ("AppImages require FUSE to run") and a
# double-click does nothing visible; one on the static runtime
# (build.toolsets.appimage in package.json) mounts itself with the system's
# fusermount3. Extracting needs no FUSE, so it would hide exactly this.
# Run as root inside a clean ubuntu:24.04 container given /dev/fuse (see
# release.yml).
#   sh scripts/ci-appimage-start-test.sh 'dist/*-Linux-x86_64.AppImage'
set -eu
F=$(ls $1 | head -n 1)
fail() { echo "FAIL: $*"; exit 1; }
echo "== starting $F on $(. /etc/os-release && echo "$PRETTY_NAME")"

# FUSE 3 and the libraries a desktop has for Electron, as on a stock install.
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  fuse3 xvfb xauth libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libxss1 libxtst6 libnotify4 libsecret-1-0 >/dev/null
if ldconfig -p | grep 'libfuse\.so\.2'; then fail "libfuse2 is installed: not the system this is about"; fi
echo "ok  FUSE 3 only, no libfuse2 ($(fusermount3 --version 2>&1 | head -n 1))"

cp "$F" /tmp/Shroudly.AppImage
chmod +x /tmp/Shroudly.AppImage
echo "    runtime: $(/tmp/Shroudly.AppImage --appimage-version 2>&1 | head -n 1)"

# --restore-proxy: Shroudly starts, finds no system proxy left to put back,
# and exits 0 (main.js). --no-sandbox: Chromium's sandbox refuses root.
out=$(cd /tmp && timeout 120 xvfb-run -a ./Shroudly.AppImage --no-sandbox --restore-proxy 2>&1) && code=0 || code=$?
[ -n "$out" ] && echo "$out" | tail -n 20
echo "$out" | grep -q 'libfuse\|FUSE to run\|FUSE setup\|fusermount' && fail "the AppImage could not mount itself with FUSE 3"
[ "$code" = 0 ] || fail "the AppImage did not start (exit $code)"
echo "ok  started from the AppImage itself and exited cleanly"
echo "== $F starts on FUSE 3 alone"
