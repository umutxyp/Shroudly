#!/usr/bin/env bash
# Builds the Linux Advanced mode engine for one architecture with zig, against
# glibc 2.28, the oldest the app supports. Built natively it would link against
# the CI runner's much newer glibc and refuse to start on Ubuntu 22.04, Debian
# 12 and older ("GLIBC_2.38 not found").
#
# libnetfilter_queue and friends come from Ubuntu's own packages, unpacked
# into a sysroot; only their headers and link stubs are used, the real
# libraries are the user's.
#   bash scripts/ci-linux-advanced.sh amd64|arm64
set -euo pipefail

ARCH="$1"
case "$ARCH" in
  amd64) BASE="http://archive.ubuntu.com/ubuntu/pool/main"; KEY=linux-x64; VAR=SHROUDLY_SYSROOT_LINUX_X64 ;;
  arm64) BASE="http://ports.ubuntu.com/ubuntu-ports/pool/main"; KEY=linux-arm64; VAR=SHROUDLY_SYSROOT_LINUX_ARM64 ;;
  *) echo "usage: $0 amd64|arm64"; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYS="$ROOT/.ci-sysroot-$ARCH"
rm -rf "$SYS"; mkdir -p "$SYS/debs" "$SYS/root"

PKGS=(
  "libn/libnetfilter-queue/libnetfilter-queue-dev"
  "libn/libnetfilter-queue/libnetfilter-queue1"
  "libm/libmnl/libmnl-dev"
  "libm/libmnl/libmnl0"
  "libn/libnfnetlink/libnfnetlink-dev"
  "libn/libnfnetlink/libnfnetlink0"
)

cd "$SYS/debs"
for p in "${PKGS[@]}"; do
  name="$(basename "$p")"
  # These moved from main to universe over the years: take the newest revision
  # for this architecture found in either.
  best=""; bestdir=""
  for comp in main universe; do
    dir="${BASE%/main}/$comp/$(dirname "$p")/"
    f="$(curl -sSfL "$dir" 2>/dev/null | grep -oE "${name}_[^\"<]*_${ARCH}\.deb" | sort -uV | tail -1 || true)"
    if [ -n "$f" ] && { [ -z "$best" ] || [ "$(printf '%s\n%s\n' "$best" "$f" | sort -V | tail -1)" = "$f" ]; }; then best="$f"; bestdir="$dir"; fi
  done
  [ -n "$best" ] || { echo "no $name for $ARCH"; exit 1; }
  echo "  $best"
  curl -sSfLO "$bestdir$best"
done
for d in *.deb; do dpkg-deb -x "$d" "$SYS/root"; done

export "$VAR"="$SYS/root"
node "$ROOT/scripts/build-core-advanced.js" --target "$KEY"
echo "$KEY advanced engine built against glibc 2.28"
