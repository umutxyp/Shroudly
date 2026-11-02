#!/bin/sh
# "shroudly --help-others" from an installed or unpacked Shroudly with no
# display at all, as on a server (electron/helper-server.js): it starts, its
# hidden page runs and reports back. Tor's broker stands in at an address
# where nothing answers, so nothing leaves this machine; the page says the
# broker does not answer, which only a page that runs can say.
#   sh scripts/ci-helper-test.sh /opt/Shroudly/shroudly [--no-sandbox]
set -eu
APP=$1
shift
OUT=$(mktemp)
DIR=$(mktemp -d)
env -u DISPLAY -u WAYLAND_DISPLAY SHROUDLY_E2E=1 \
  SHROUDLY_SNOWFLAKE_TEST='{"broker":"http://127.0.0.1:9/","relay":"ws://127.0.0.1:9/","relayPattern":"^127.0.0.1","pollMs":300}' \
  "$APP" --help-others --ozone-platform=headless --data-dir="$DIR" "$@" >"$OUT" 2>&1 &
PID=$!
i=0
while [ $i -lt 60 ]; do
  grep -q "does not answer" "$OUT" && break
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
  i=$((i + 1))
done
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
cat "$OUT"
grep -q "helping people in censored countries (a Snowflake proxy for Tor)" "$OUT" || { echo "FAIL: the helper did not start"; exit 1; }
grep -q "does not answer" "$OUT" || { echo "FAIL: the helper's hidden page did not run"; exit 1; }
grep -q "Stopping." "$OUT" || { echo "FAIL: the helper did not stop when told to"; exit 1; }
echo "ok  --help-others runs with no display, its page reports back, and it stops when told to"
