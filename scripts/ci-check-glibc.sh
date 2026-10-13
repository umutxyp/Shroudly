#!/usr/bin/env bash
# No Linux engine may need a newer glibc than the app promises to run on:
# 2.17 for the default engine, 2.28 for the Advanced mode engine. A native
# build on a new CI runner silently raises it; this stops the build instead.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
check() {  # file limit
  local need
  need="$(objdump -T "$1" | grep -oE 'GLIBC_[0-9]+\.[0-9]+(\.[0-9]+)?' | sed 's/GLIBC_//' | sort -V | tail -1)"
  if [ "$(printf '%s\n%s\n' "$need" "$2" | sort -V | tail -1)" != "$2" ]; then
    echo "FAIL $1 needs glibc $need (limit $2)"; fail=1
  else
    echo "ok   $1 needs glibc $need (limit $2)"
  fi
}
for a in x64 arm64; do
  d="$ROOT/electron/tools/core/linux-$a"
  [ -f "$d/shroudly-core" ] && check "$d/shroudly-core" 2.17
  [ -f "$d/shroudly-core-adv" ] && check "$d/shroudly-core-adv" 2.28
done
exit $fail
