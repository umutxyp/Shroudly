#!/usr/bin/env bash
#
# End-to-end check of the debug APK on an emulator: without the VPN consent
# nothing starts (and nothing crashes); with it protection goes on, apps'
# names resolve through the VPN's mapped DNS, TCP and UDP go through the
# engine, the app counts the connections, and after Stop everything works
# directly again. With an engine that takes --auth-file, its SOCKS5 port must
# also refuse a client without the session's password; with an older engine
# that check is skipped and said so. Last, the window: installed from a file
# it looks for updates on GitHub; installed as Google Play would
# (pm install -i com.android.vending) it does not; it links the privacy policy.
#
#   android/scripts/emulator-smoke.sh [--abi arm64-v8a|x86_64] [--api 35] [--tag google_apis]
#                                     [--apk path] [--keep]
#
# Needs ANDROID_HOME with platform-tools, emulator, cmdline-tools and the system
# image "system-images;android-<api>;<tag>;<abi>" installed. The ABI defaults
# to the host's (arm64-v8a on Apple silicon, x86_64 elsewhere; CI uses x86_64
# with KVM). The AVD lives in android/smoke-out/avd unless ANDROID_AVD_HOME is
# set; the emulator is shut down at the end unless --keep is given. The full
# log is saved to android/smoke-out/logcat.txt.

set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
case "$(uname -m)" in arm64|aarch64) ABI=arm64-v8a ;; *) ABI=x86_64 ;; esac
API=35
TAG=google_apis
APK="$here/app/build/outputs/apk/debug/app-debug.apk"
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --abi) ABI="$2"; shift 2 ;;
    --api) API="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --apk) APK="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

: "${ANDROID_HOME:?ANDROID_HOME must point at the Android SDK}"
PKG=me.codeshare.shroudly
PORT=5580
SERIAL="emulator-$PORT"
OUT="$here/smoke-out"
AVD="shroudly-smoke-$API-$ABI"
mkdir -p "$OUT"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$OUT/avd}"
mkdir -p "$ANDROID_AVD_HOME"
ADB="$ANDROID_HOME/platform-tools/adb"
EMULATOR="$ANDROID_HOME/emulator/emulator"
AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
[ -f "$APK" ] || { echo "no APK at $APK (build it with ./gradlew assembleDebug)" >&2; exit 2; }

adb_() { "$ADB" -s "$SERIAL" "$@"; }
# Never fails: what the command printed is what counts.
sh_() { adb_ shell "$@" 2>&1 | tr -d '\r' || true; }
say() { printf '[smoke] %s\n' "$*"; }
EMU_PID=""

cleanup() {
  adb_ logcat -d > "$OUT/logcat.txt" 2>/dev/null || true
  if [ "$KEEP" = 0 ]; then
    adb_ emu kill >/dev/null 2>&1 || true
    [ -n "$EMU_PID" ] && { sleep 3; kill "$EMU_PID" 2>/dev/null || true; }
  fi
}
trap cleanup EXIT

fail() {
  say "FAILED: $*"
  say "app log:"
  adb_ logcat -d -s Shroudly:V 2>/dev/null | tail -40 || true
  exit 1
}

# wait_for <seconds> <command...>: until the command succeeds.
wait_for() {
  local t="$1"; shift
  local end=$(( $(date +%s) + t ))
  until "$@" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$end" ] || return 1
    sleep 2
  done
}

applog() { adb_ logcat -d -s Shroudly:I 2>/dev/null | tr -d '\r' || true; }
# (grep -q on a pipe can end the writer early, which pipefail counts as a failure.)
has_log() { grep -q -- "$1" <<<"$(applog)"; }

# An HTTP request to example.com over plain TCP, from the shell (which, like
# every app, goes through the VPN while it is up). toybox nc hangs up when its
# input ends, so the input stays open while the answer comes; timeout is the
# device's own, so a stuck nc cannot hang the test.
http_get() {
  sh_ "(printf 'GET / HTTP/1.1\r\nHost: example.com\r\nUser-Agent: shroudly-smoke\r\nConnection: close\r\n\r\n'; sleep 6) | timeout 20 nc -q 1 -w 15 example.com 80 | head -1"
}

# A DNS query for example.com straight to 8.8.8.8 over UDP: not the VPN's own
# DNS, so it has to go through the engine's UDP relay. Prints the reply's hex.
udp_dns() {
  sh_ "(printf '\\022\\064\\001\\000\\000\\001\\000\\000\\000\\000\\000\\000\\007example\\003com\\000\\000\\001\\000\\001'; sleep 3) | timeout 10 nc -u -q 1 8.8.8.8 53 | od -An -tx1 | head -1"
}

# The address ping resolved example.com to.
resolved() { sh_ "ping -c1 -W2 example.com" | sed -n 's/^PING example.com (\([0-9.]*\)).*/\1/p' | head -1; }

ctl() { sh_ "am start -n $PKG/.DebugControlActivity --es cmd $1" >/dev/null; }

# ── emulator ─────────────────────────────────────────────────────────────
IMAGE="system-images;android-$API;$TAG;$ABI"
"$ADB" start-server >/dev/null
if [ "$("$ADB" -s "$SERIAL" get-state 2>/dev/null)" = device ]; then
  say "using the emulator already running as $SERIAL"
else
  say "AVD $AVD from $IMAGE"
  echo no | "$AVDMANAGER" create avd -n "$AVD" -k "$IMAGE" --force >/dev/null
  "$EMULATOR" -avd "$AVD" -port "$PORT" -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect \
    -no-snapshot -no-metrics > "$OUT/emulator.txt" 2>&1 &
  EMU_PID=$!
  say "booting (pid $EMU_PID)"
  wait_for 180 adb_ wait-for-device || fail "emulator did not come up"
fi
boot_done() { [ "$(sh_ getprop sys.boot_completed)" = 1 ]; }
wait_for 600 boot_done || fail "emulator did not finish booting"
say "booted: $(sh_ getprop ro.build.fingerprint)"

# The network may come up a little after boot.
net_up() { grep -q '^HTTP/1' <<<"$(http_get)"; }
wait_for 120 net_up || fail "no network on the emulator before the test"
say "direct HTTP before: $(http_get)"

# ── install and switch on ────────────────────────────────────────────────
adb_ install -r -g "$APK" >/dev/null || fail "install failed"
# The package manager may still be settling right after the install, and
# "appops set" says nothing when it does not take: set it until the system
# reports it allowed (what VpnService.prepare() reads), and show it.
installed() { sh_ "pm path $PKG" | grep -q package:; }
wait_for 60 installed || fail "package not installed"

# Without the VPN consent the service is not started at all: it could not
# run in the foreground (systemExempted needs that consent on Android 14+).
vpn_refused() { sh_ "appops set $PKG ACTIVATE_VPN ignore" >/dev/null 2>&1; ! sh_ "appops get $PKG ACTIVATE_VPN" | grep -qi "allow"; }
wait_for 60 vpn_refused || fail "could not take back the VPN consent: $(sh_ "appops get $PKG ACTIVATE_VPN" 2>&1)"
adb_ logcat -c
ctl start
wait_for 20 has_log "Not started: the VPN is not allowed yet" || fail "started without the VPN consent"
sleep 3
crash="$(adb_ logcat -d -b crash 2>/dev/null | tr -d '\r' | grep -A3 "Process: $PKG" || true)"
[ -z "$crash" ] || fail "the app crashed without the VPN consent: $crash"
has_log "Protection on" && fail "protection came on without the VPN consent"
say "without the VPN consent: not started, no crash"

vpn_allowed() { sh_ "appops set $PKG ACTIVATE_VPN allow" >/dev/null 2>&1; sh_ "appops get $PKG ACTIVATE_VPN" | grep -qi "allow"; }
wait_for 60 vpn_allowed || fail "could not allow the VPN for the app: $(sh_ "appops get $PKG ACTIVATE_VPN" 2>&1)"
say "VPN consent: $(sh_ "appops get $PKG ACTIVATE_VPN" | tr -d '\r' | head -1)"
adb_ logcat -c
ctl start
wait_for 60 has_log "Protection on" || fail "protection did not come on"
say "$(applog | grep -m1 'Protection on' | sed 's/.*: Protection/Protection/')"
grep -q "198.18.0.1" <<<"$(sh_ "ip addr show tun0")" || fail "no VPN interface"
say "VPN interface tun0 is up"

# ── through the VPN ──────────────────────────────────────────────────────
ip="$(resolved)"
case "$ip" in
  198.19.*) say "example.com -> $ip (mapped by the VPN's DNS)" ;;
  *) fail "example.com resolved to '$ip', not a mapped address" ;;
esac

first="$(http_get)"
grep -q '^HTTP/1' <<<"$first" || fail "HTTP through the engine failed: '$first'"
say "HTTP through the engine: $first"

udp="$(udp_dns)"
grep -q '^ *12 34 81' <<<"$udp" || fail "UDP DNS through the engine failed: '$udp'"
say "UDP through the engine: DNS reply $udp"

# Loopback does not go through the VPN: the shell reaches the engine's port
# directly, as any other app could.
on_line="$(applog | grep -m1 'Protection on')"
eport="$(sed -n 's/.*engine on 127\.0\.0\.1:\([0-9]*\).*/\1/p' <<<"$on_line")"
[ -n "$eport" ] || fail "no engine port in '$on_line'"
noauth="$(sh_ "(printf '\\005\\001\\000'; sleep 2) | timeout 6 nc -q 1 127.0.0.1 $eport | od -An -tx1 | head -1")"
if grep -q '(password)' <<<"$on_line"; then
  grep -q '^ *05 00' <<<"$noauth" && fail "the engine let in a client without the password"
  say "engine port 127.0.0.1:$eport refuses a client without the password (reply: ${noauth:-none})"
else
  say "engine without --auth-file: its port takes no password (reply: ${noauth:-none}); password check skipped"
fi

ctl stats
wait_for 15 has_log "stats: on" || fail "no stats line"
stats="$(applog | grep 'stats: on' | tail -1 | sed 's/.*stats: /stats: /')"
say "$stats"
total="$(echo "$stats" | sed -n 's/.*connections \([0-9]*\) total.*/\1/p')"
[ "${total:-0}" -ge 1 ] || fail "the engine counted no connections"
dns="$(applog | grep 'Encrypted DNS answering via' | tail -1 | sed 's/.*Encrypted/Encrypted/' || true)"
[ -n "$dns" ] && say "$dns"

# ── switch off ───────────────────────────────────────────────────────────
ctl stop
wait_for 30 has_log "Protection off" || fail "protection did not go off"
say "$(applog | grep 'Protection off' | tail -1 | sed 's/.*Protection off/Protection off/')"
tun_gone() { ! grep -q "198.18.0.1" <<<"$(sh_ "ip addr show tun0")"; }
wait_for 20 tun_gone || fail "VPN interface still there after Stop"
direct_dns() { ip="$(resolved)"; [ -n "$ip" ] && case "$ip" in 198.1[89].*) false ;; *) true ;; esac; }
wait_for 30 direct_dns || fail "names still resolve to mapped addresses after Stop"
say "example.com -> $(resolved) after Stop"
wait_for 30 net_up || fail "no direct network after Stop"
say "direct HTTP after: $(http_get)"

# ── the window: update source and privacy policy ─────────────────────────
# Debug builds log which updates the window offers each time it starts.
window() {
  adb_ logcat -c
  sh_ "am force-stop $PKG" >/dev/null
  sh_ "am start -W -n $PKG/.MainActivity" >/dev/null
  # The links are at the bottom: scroll there (small screens).
  for _ in 1 2 3; do sh_ "input swipe 160 550 160 80 300" >/dev/null; done
}
ui_has() { sh_ "uiautomator dump /sdcard/ui.xml" >/dev/null; grep -q -- "$1" <<<"$(sh_ "cat /sdcard/ui.xml")"; }
window
wait_for 20 has_log "Updates: GitHub" || fail "installed from a file, the window does not look for updates on GitHub"
wait_for 20 ui_has 'text="Release notes"' || fail "no GitHub releases link"
wait_for 20 ui_has 'text="Privacy policy"' || fail "no privacy policy link"
say "installed from a file: updates from GitHub, links Release notes and Privacy policy"
adb_ install -r -i com.android.vending "$APK" >/dev/null || fail "install as Google Play failed"
say "installer now: $(sh_ "dumpsys package $PKG" | grep -m1 'installerPackageName=' | sed 's/^ *//')"
window
wait_for 20 has_log "Updates: Google Play" || fail "installed by Google Play, the window still looks for updates on GitHub"
wait_for 20 ui_has 'text="Source code on GitHub"' || fail "installed by Google Play, the window still links the GitHub releases"
ui_has 'text="Release notes"' && fail "installed by Google Play, the window still links the GitHub releases"
say "installed by Google Play: no GitHub update check, links the source code instead"
sh_ "am force-stop $PKG" >/dev/null

say "PASSED ($ABI, API $API)"
