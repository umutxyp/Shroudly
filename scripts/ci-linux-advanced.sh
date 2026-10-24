#!/usr/bin/env bash
# Builds the Linux Advanced mode engine for one architecture with zig, against
# glibc 2.28, the oldest the app supports. Built natively it would link against
# the CI runner's much newer glibc and refuse to start on Ubuntu 22.04, Debian
# 12 and older ("GLIBC_2.38 not found").
#
# Nothing else is linked: the packet queue is spoken over netlink with the
# kernel's own headers (core/src/nfq.c), which zig carries.
#   bash scripts/ci-linux-advanced.sh amd64|arm64
set -euo pipefail

case "${1:-}" in
  amd64) KEY=linux-x64 ;;
  arm64) KEY=linux-arm64 ;;
  *) echo "usage: $0 amd64|arm64"; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node "$ROOT/scripts/build-core-advanced.js" --target "$KEY"
echo "$KEY advanced engine built against glibc 2.28"
