#!/bin/sh
# Installs a built Linux package on its own distribution and checks that it
# really works there: the package manager resolves every dependency, the app
# finds every library it links against, and the installed engine starts.
# Run inside a clean container of that distribution (see release.yml).
#   sh scripts/ci-linux-package-test.sh dist/Shroudly-*-Linux-x64.pacman
set -eu
PKG=$(ls $1 | head -n 1)
echo "== installing $PKG on $(. /etc/os-release && echo "$PRETTY_NAME")"
case "$PKG" in
  *.pacman) pacman -Syu --noconfirm >/dev/null && pacman -U --noconfirm "$PKG" ;;
  *.rpm)    if command -v zypper >/dev/null; then zypper --non-interactive refresh >/dev/null && zypper --non-interactive --no-gpg-checks install "$PKG"; else dnf install -y "$PKG"; fi ;;
  *.deb)    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y "./$PKG" ;;
  *) echo "unknown package type: $PKG"; exit 2 ;;
esac

APP=/opt/Shroudly
CORE="$APP/resources/app.asar.unpacked/electron/tools/core/linux-x64"
fail() { echo "FAIL: $*"; exit 1; }

[ -x "$APP/shroudly" ] || fail "app binary missing at $APP/shroudly"
echo "ok  app installed at $APP"

missing=$(ldd "$APP/shroudly" | grep 'not found' || true)
[ -z "$missing" ] || fail "libraries the app needs are not installed: $missing"
echo "ok  every library the app links against is present"

[ -x "$CORE/shroudly-core" ] || fail "engine missing at $CORE"
missing=$(ldd "$CORE/shroudly-core" | grep 'not found' || true)
[ -z "$missing" ] || fail "engine libraries missing: $missing"
out=$( (sleep 2; echo STOP) | "$CORE/shroudly-core" --listen 127.0.0.1 --port 18765 --strategy 'split(sni)' 2>&1 | head -n 1 )
echo "$out" | grep -q '"ready"' || fail "engine did not start: $out"
echo "ok  installed engine starts ($out)"

if [ -x "$CORE/shroudly-core-adv" ]; then
  # Nothing to install first: the queue is spoken over netlink (core/src/nfq.c),
  # so a fresh system has every library the Advanced engine needs.
  missing=$(ldd "$CORE/shroudly-core-adv" | grep 'not found' || true)
  [ -z "$missing" ] || fail "Advanced mode engine misses libraries on a fresh system: $missing"
  ldd "$CORE/shroudly-core-adv" | grep -qE 'libnetfilter|libmnl|libnfnetlink' && fail "Advanced mode engine still links a netfilter library"
  echo "ok  Advanced mode engine needs nothing installed (glibc only)"
fi

ls /usr/share/applications | grep -qi shroudly || fail "no desktop entry"
echo "ok  desktop entry installed"
[ -f /usr/share/icons/hicolor/256x256/apps/shroudly.png ] || ls /usr/share/icons/hicolor/*/apps/ | grep -qi shroudly || fail "no icon"
echo "ok  icon installed"
echo "== $PKG passed"
