#!/usr/bin/env bash
#
# End-to-end check of the debug APK on an emulator: without the VPN consent
# nothing starts (and nothing crashes); with it protection goes on, the engine
# runs inside the app's process (no process of its own), the VPN is not its
# own underlying network, apps' names resolve through the VPN's mapped DNS,
# TCP and UDP go through the engine, its SOCKS5 port refuses a client without
# the session's password, and the app counts the connections. Then what goes
# wrong on phones, one at a time, and the phone must keep its internet:
#   - the engine stops under the service: it is back on the same port, the
#     tunnel goes on, and an address an app was given still works;
#   - Private DNS set to a name (strict, dns.google; Android 9+): names
#     resolve, and still do after the tunnel has been restarted;
#   - the network changes (Wi-Fi off and on, airplane mode on and off);
#   - (with root, google_apis images) the app's own network is cut, as a
#     phone maker's per-app network switch does: protection ends by itself,
#     with a notice, and other apps connect directly again.
# After Stop everything works directly again. Then "Proxy only": no VPN and
# no VPN consent, the engine on 127.0.0.1 for apps set to use it. Last, the
# window: installed
# from a file it looks for updates on GitHub; installed as Google Play would
# (pm install -i com.android.vending) it does not; it links the privacy policy
# and offers "Share logs".
#
#   android/scripts/emulator-smoke.sh [--abi arm64-v8a|x86_64] [--api 35] [--tag google_apis]
#                                     [--apk path] [--port 5580] [--keep]
#
# Needs ANDROID_HOME with platform-tools, emulator, cmdline-tools and the system
# image "system-images;android-<api>;<tag>;<abi>" installed. The ABI defaults
# to the host's (arm64-v8a on Apple silicon, x86_64 elsewhere; CI uses x86_64
# with KVM). The AVD lives in android/smoke-out/avd unless ANDROID_AVD_HOME is
# set; the emulator listens on --port (and the next one; default 5580) and is
# shut down at the end unless --keep is given. The full log is saved to
# android/smoke-out/logcat.txt, the app's own log to android/smoke-out/app-log.txt.

set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
case "$(uname -m)" in arm64|aarch64) ABI=arm64-v8a ;; *) ABI=x86_64 ;; esac
API=35
TAG=google_apis
APK="$here/app/build/outputs/apk/debug/app-debug.apk"
KEEP=0
PORT=5580
while [ $# -gt 0 ]; do
  case "$1" in
    --abi) ABI="$2"; shift 2 ;;
    --api) API="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --apk) APK="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

: "${ANDROID_HOME:?ANDROID_HOME must point at the Android SDK}"
PKG=me.codeshare.shroudly
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
  adb_ shell run-as "$PKG" cat files/log.txt > "$OUT/app-log.txt" 2>/dev/null || true
  # What the test changed on the device, back to Android's defaults.
  adb_ shell "settings delete global private_dns_mode; settings delete global private_dns_specifier" >/dev/null 2>&1 || true
  adb_ shell "settings delete secure always_on_vpn_app; settings delete secure always_on_vpn_lockdown" >/dev/null 2>&1 || true
  adb_ shell "svc wifi enable" >/dev/null 2>&1 || true
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

# Android 8's logcat sometimes fails to clear on the first try.
clear_log() {
  local i
  for i in 1 2 3 4 5; do adb_ logcat -c >/dev/null 2>&1 && return 0; sleep 1; done
  fail "could not clear the log"
}
applog() { adb_ logcat -d -s Shroudly:I 2>/dev/null | tr -d '\r' || true; }
# (grep -q on a pipe can end the writer early, which pipefail counts as a failure.)
has_log() { grep -q -- "$1" <<<"$(applog)"; }

# An HTTP request to example.com over plain TCP, from the shell (which, like
# every app, goes through the VPN while it is up). toybox nc hangs up when its
# input ends, so the input stays open while the answer comes; timeout is the
# device's own, so a stuck nc cannot hang the test.
http_get() {
  sh_ "(printf 'GET / HTTP/1.1\r\nHost: example.com\r\nUser-Agent: shroudly-smoke\r\nConnection: close\r\n\r\n'; sleep 6) | timeout 20 $NC -q 1 -w 15 example.com 80 | head -1"
}

# The same to another name, port 80 (the engine sees the name: the tunnel
# hands apps stand-in addresses and passes the name on).
http_host() {
  sh_ "(printf 'GET / HTTP/1.1\r\nHost: $1\r\nUser-Agent: shroudly-smoke\r\nConnection: close\r\n\r\n'; sleep 6) | timeout 20 $NC -q 1 -w 15 $1 80 | head -1"
}

# A DNS query for example.com straight to 8.8.8.8 over UDP: not the VPN's own
# DNS, so it has to go through the engine's UDP relay. Prints the reply's hex.
udp_dns() {
  sh_ "(printf '\\022\\064\\001\\000\\000\\001\\000\\000\\000\\000\\000\\000\\007example\\003com\\000\\000\\001\\000\\001'; sleep 3) | timeout 10 $NC -u -q 1 8.8.8.8 53 | od -An -tx1 | head -1"
}

# The address ping resolved a name (default example.com) to; ping may show
# the name it is an alias of instead.
resolved() { sh_ "ping -c1 -W2 ${1:-example.com}" | sed -n 's/^PING [^ ]* (\([0-9.]*\)).*/\1/p' | head -1; }

# The same request to an address (an app that kept the address it was given).
http_get_at() {
  sh_ "(printf 'GET / HTTP/1.1\r\nHost: example.com\r\nUser-Agent: shroudly-smoke\r\nConnection: close\r\n\r\n'; sleep 6) | timeout 20 $NC -q 1 -w 15 $1 80 | head -1"
}

ctl() { sh_ "am start -n $PKG/.DebugControlActivity --es cmd $1" >/dev/null; }
# Makes one part fail while protection is on (debug builds: ShroudlyVpnService.ACTION_TEST).
fault() { sh_ "am start -n $PKG/.DebugControlActivity --es cmd test --es what $1" >/dev/null; }
vpn_up() { grep -q "198.18.0.1" <<<"$(sh_ "ip addr")"; }

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
SDK="$(sh_ getprop ro.build.version.sdk | tr -dc 0-9)"
# Android 8 has netcat in toybox but no "nc" of its own.
NC="$(sh_ 'command -v nc >/dev/null 2>&1 && echo nc || echo toybox nc')"

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
clear_log
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
clear_log
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
if grep -q 'Unknown option u' <<<"$udp"; then
  say "this Android's netcat has no UDP (-u): UDP check skipped"
else
  grep -q '^ *12 34 81' <<<"$udp" || fail "UDP DNS through the engine failed: '$udp'"
  say "UDP through the engine: DNS reply $udp"
fi

# Loopback does not go through the VPN: the shell reaches the engine's port
# directly, as any other app could.
on_line="$(applog | grep -m1 'Protection on')"
eport="$(sed -n 's/.*engine on 127\.0\.0\.1:\([0-9]*\).*/\1/p' <<<"$on_line")"
[ -n "$eport" ] || fail "no engine port in '$on_line'"
noauth="$(sh_ "(printf '\\005\\001\\000'; sleep 2) | timeout 6 $NC -q 1 127.0.0.1 $eport | od -An -tx1 | head -1")"
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

# ── "Block ads and trackers" ─────────────────────────────────────────────
# Apps' lookups get stand-in addresses from the tunnel (198.19.0.0/16) and the
# name reaches the engine with the connection, so on a phone a listed name is
# stopped there: its connection is ended inside the engine (an HTTP request
# gets 403), other names are untouched. Off by default; on: the list is
# fetched through the engine and checked by it; off again: no restart.
ad_before="$(http_host doubleclick.net)"
case "$ad_before" in *403*|"") fail "doubleclick.net stopped while ad blocking is off ($ad_before)";; esac
ctl adblock-on
wait_for 120 has_log "Ad blocking: a list of" || fail "ad blocking: the list was not fetched and put to use ($(applog | grep 'Ad blocking' | tail -2 | tr '\n' ' '))"
ad_on="$(http_host doubleclick.net)"
case "$ad_on" in *403*) ;; *) fail "ad blocking on: doubleclick.net answered '$ad_on', not 403 from the engine";; esac
ok_on="$(http_get)"
case "$ok_on" in *" 200 "*|*" 30"*) ;; *) fail "ad blocking on: example.com did not load ($ok_on)";; esac
say "ad blocking: $(applog | grep 'Ad blocking: a list of' | tail -1 | sed 's/.*Ad blocking/Ad blocking/'); doubleclick.net: ${ad_on%%$'\r'}; example.com: ${ok_on%%$'\r'}"
ctl adblock-off
sleep 2
ad_off="$(http_host doubleclick.net)"
case "$ad_off" in *403*|"") fail "ad blocking off: doubleclick.net still stopped ($ad_off)";; esac
say "ad blocking off again: doubleclick.net: ${ad_off%%$'\r'}, no restart"

# ── "Apps that skip Shroudly" ────────────────────────────────────────────
# This shell is an app too (com.android.shell, uid 2000): set to skip
# Shroudly, Android leaves its uid out of the VPN network (dumpsys shows the
# VPN's uid ranges) and its requests still load, straight out; back in, its
# uid is in the VPN again. (The engine's own counters cannot tell: other apps
# on the phone keep using it meanwhile.)
# The VPN network's line says "VPN CONNECTED" (Android 12+) or "type: VPN[],
# state: CONNECTED" (up to 11); its ranges read "Uids: <{0-1999, 2001-99999}>"
# (one set, ranges split by commas). All in one step: a pipe cut short by head
# counts as a failure under pipefail, and set -e would end the test without
# a word.
vpn_has_uid() {
  python3 -c '
import re, sys
vpn = [l for l in sys.stdin.read().splitlines() if re.search(r"VPN CONNECTED|type: VPN\[[^]]*\], state: CONNECTED", l) and "Uids: <" in l]
uids = re.search(r"Uids: <([^>]*)>", vpn[0]) if vpn else None
if not uids: sys.exit(2)
u = int(sys.argv[1])
for a, b in re.findall(r"(\d+)(?:-(\d+))?", uids.group(1)):
    if int(a) <= u <= int(b or a): sys.exit(0)
sys.exit(1)' "$1" <<<"$(sh_ "dumpsys connectivity")"
}
vpn_has_uid 2000 || fail "before: the shell's uid 2000 is not in the VPN"
sh_ "am start -n $PKG/.DebugControlActivity --es cmd exclude --es pkg com.android.shell" >/dev/null
wait_for 20 has_log "Apps that skip Shroudly changed" || fail "the app list change did not renew the VPN interface"
wait_for 20 eval '! vpn_has_uid 2000' || fail "an app set to skip Shroudly is still in the VPN"
skip="$(http_get)"
case "$skip" in *" 200 "*|*" 30"*) ;; *) fail "an app that skips Shroudly lost its internet ($skip)";; esac
sh_ "am start -n $PKG/.DebugControlActivity --es cmd exclude --es pkg ''" >/dev/null
wait_for 20 vpn_has_uid 2000 || fail "back in: the shell's uid 2000 is not in the VPN again"
back="$(http_get)"
case "$back" in *" 200 "*|*" 30"*) ;; *) fail "back through Shroudly, the shell's request failed ($back)";; esac
say "apps that skip Shroudly: uid 2000 left out of the VPN and loading straight out (${skip%%$'\r'}), in the VPN again once back (${back%%$'\r'})"

# ── inside the app's process ─────────────────────────────────────────────
# Up to 2.6.1 the engine was a process of its own, which Android 12+ and
# phone makers end or freeze ("phantom processes"), leaving the VPN pointing
# at nothing. Now it is a library in the app's process.
procs="$(sh_ "ps -A -o NAME" | grep -c libshroudlycore || true)"
[ "${procs:-0}" = 0 ] || fail "an engine process of its own is running"
say "the engine runs inside the app's process (no libshroudlycore process)"
# 2.6.1 passed the VPN itself to setUnderlyingNetworks.
conn="$(sh_ "dumpsys connectivity")"
vpnid="$(grep -o 'network{[0-9]*}  handle{[0-9]*}  ni{VPN' <<<"$conn" | sed 's/network{\([0-9]*\)}.*/\1/' | head -1 || true)"
if [ -n "$vpnid" ]; then
  grep -q "underlying{\[$vpnid\]}" <<<"$conn" && fail "the VPN (network $vpnid) is its own underlying network"
  say "the VPN (network $vpnid) is not its own underlying network"
  # Metered exactly when the network underneath is (Wi-Fi here).
  vcaps="$(grep -o 'ni{VPN CONNECTED.*' <<<"$conn" | grep -o 'Transports: [A-Z|]* Capabilities: [A-Z_&]*' | head -1)"
  if grep -q 'WIFI' <<<"$vcaps"; then
    grep -q 'NOT_METERED' <<<"$vcaps" || fail "the VPN is metered on Wi-Fi: $vcaps"
    say "the VPN on Wi-Fi is not metered: $vcaps"
  fi
else
  say "this Android's dumpsys does not show the VPN's underlying networks; check skipped"
fi
wait_for 30 has_log "Path check (.*): through the engine to" || fail "no successful path check through the engine"
say "$(applog | grep 'Path check' | tail -1 | sed 's/.*Path check/Path check/')"

# ── the engine stops under the service ───────────────────────────────────
# It comes back on the same port with the same password, the tunnel goes on,
# and an address an app was given before still works.
before="$(resolved)"
fault engine-stop
wait_for 30 has_log "Engine back on 127.0.0.1:$eport; the tunnel went on" || fail "the engine did not come back on its port with the tunnel going on"
kept_works() { grep -q '^HTTP/1' <<<"$(http_get_at "$before")"; }
wait_for 30 kept_works || fail "an address given before the engine restart ($before) no longer reaches example.com"
say "engine stopped under the service: back on port $eport, the tunnel went on, $before still reaches example.com"

# ── Private DNS by name (strict) ─────────────────────────────────────────
# Android then looks names up over DNS-over-TLS to dns.google, through the
# tunnel, by the stand-in address the VPN's DNS gave for dns.google. After a
# tunnel restart that address is the old tunnel's: the app has Android look
# the server up again (reportNetworkConnectivity), or every name would fail.
real_name() { local ip; ip="$(resolved "$1")"; [ -n "$ip" ] && case "$ip" in 198.1[89].*) false ;; *) true ;; esac; }
if [ "${SDK:-0}" -ge 28 ]; then
  sh_ "settings put global private_dns_mode hostname; settings put global private_dns_specifier dns.google" >/dev/null
  wait_for 60 real_name example.org || fail "with Private DNS strict (dns.google), names do not resolve through the VPN"
  say "Private DNS strict: example.org -> $(resolved example.org) (DNS-over-TLS through the tunnel)"
  wait_for 30 net_up || fail "HTTP with Private DNS strict failed"
  fault tunnel-stop
  wait_for 30 has_log "Tunnel started again" || fail "the tunnel did not start again"
  wait_for 30 real_name www.iana.org || fail "with Private DNS strict, names no longer resolve after a tunnel restart"
  wait_for 30 net_up || fail "HTTP with Private DNS strict failed after a tunnel restart"
  say "Private DNS strict after a tunnel restart: www.iana.org -> $(resolved www.iana.org); $(applog | grep -m1 'Asking Android' | sed 's/.*Asking/asked/')"
  sh_ "settings delete global private_dns_mode; settings delete global private_dns_specifier" >/dev/null
  mapped_again() { case "$(resolved)" in 198.19.*) true ;; *) false ;; esac; }
  wait_for 60 mapped_again || fail "names not mapped again after Private DNS went back to automatic"
else
  fault tunnel-stop
  wait_for 30 has_log "Tunnel started again" || fail "the tunnel did not start again"
  wait_for 30 net_up || fail "HTTP failed after a tunnel restart"
  say "Android $SDK has no Private DNS: tunnel restart checked alone"
fi
fresh="$(resolved)"
[ "$fresh" != "$before" ] || fail "the restarted tunnel gave out the old stand-in address $before again"
stale="$(http_get_at "$before")"
grep -q '^HTTP/1' <<<"$stale" && fail "a stand-in address from the old tunnel ($before) still reached something"
say "tunnel restarted: example.com -> $fresh; the old $before is refused, never another site"

# ── the network changes ──────────────────────────────────────────────────
# Wi-Fi off only where mobile data is up to take over (an emulator's radio
# is not always up).
mobile_up() { grep -qE 'MOBILE[^}]*CONNECTED' <<<"$(sh_ "dumpsys connectivity")"; }
if grep -q 'inet ' <<<"$(sh_ "ip addr show wlan0")" && mobile_up; then
  sh_ "svc wifi disable" >/dev/null; sleep 5
  wait_for 90 net_up || fail "no internet through the VPN on mobile data after Wi-Fi went off"
  say "Wi-Fi off: through the VPN on mobile data: $(http_get)"
  sh_ "svc wifi enable" >/dev/null
  wlan_up() { grep -q 'inet ' <<<"$(sh_ "ip addr show wlan0")"; }
  wait_for 90 wlan_up || fail "Wi-Fi did not come back"
  sleep 5
  wait_for 90 net_up || fail "no internet through the VPN after Wi-Fi came back"
  say "Wi-Fi back: through the VPN: $(http_get)"
else
  say "no Wi-Fi, or no mobile data, on this emulator: Wi-Fi switch skipped"
fi
if [ "${SDK:-0}" -ge 30 ]; then
  sh_ "cmd connectivity airplane-mode enable" >/dev/null; sleep 6
  sh_ "cmd connectivity airplane-mode disable" >/dev/null
  wait_for 120 net_up || fail "no internet through the VPN after airplane mode"
  say "airplane mode on and off: through the VPN: $(http_get)"
fi
vpn_up || fail "protection ended during the network changes"
has_log "Protection off" && fail "protection ended during the network changes"

# ── Doze, and what "Share logs" says ─────────────────────────────────────
# Deep idle (Doze) for a minute and back: time passing with nothing
# answering is no failure. Protection stays on, nothing is restarted, and the
# internet works after.
no_false_alarm() {
  local bad
  for bad in "Ending protection" "giving up" "stopped answering" "does not accept connections" "starting everything anew" "Tunnel .*; restarting it"; do
    has_log "$bad" && fail "$1: \"$bad\""
  done
  return 0
}
clear_log
sh_ "dumpsys battery unplug" >/dev/null
sh_ "dumpsys deviceidle force-idle" >/dev/null
sleep 60
sh_ "dumpsys deviceidle unforce" >/dev/null
sh_ "dumpsys battery reset" >/dev/null
wait_for 90 net_up || fail "no internet through the VPN after Doze"
vpn_up || fail "protection ended in Doze"
no_false_alarm "after Doze"
say "Doze for 60 s and back: protection stayed on, nothing restarted, works after: $(http_get)"
ctl report
wait_for 20 has_log "report: Protection: on for [0-9]* min; always-on VPN no, lockdown no; IPv6 " || fail "Share logs' report does not say how protection runs"
say "Share logs: $(applog | grep -m1 'report: Protection:' | sed 's/.*report: //')"

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

# ── "Proxy only" (Settings) ──────────────────────────────────────────────
# The second mode: the engine as a proxy on 127.0.0.1 and no VPN at all, so
# another VPN app keeps the phone's one VPN slot (issue #31). It never asks
# for the VPN (asking would end the other app's connection), so it starts
# here with the consent taken back. Android then shows no VPN; an app set to
# use the proxy gets through it by HTTP CONNECT and by SOCKS5 with a name
# (the engine looks the name up itself, over encrypted DNS); the ad blocker
# stops a listed name there too; the engine is back on the same port after
# it stops under the service; Stop closes the port.
mode() { sh_ "am start -n $PKG/.DebugControlActivity --es cmd mode --es mode $1" >/dev/null; }
# A client that speaks at once, as browsers do (the engine reads a first
# payload for a moment only).
via_connect() {
  sh_ "(printf 'CONNECT $1:80 HTTP/1.1\r\nHost: $1:80\r\n\r\n'; sleep 0.2; printf 'GET / HTTP/1.1\r\nHost: $1\r\nUser-Agent: shroudly-smoke\r\nConnection: close\r\n\r\n'; sleep 6) | timeout 20 $NC -q 1 -w 15 127.0.0.1 $pport | grep -a '^HTTP/1' | tr '\n' ' '"
}
via_socks() {
  sh_ "(printf '\\005\\001\\000'; sleep 0.3; printf '\\005\\001\\000\\003\\013example.com\\000\\120'; sleep 0.3; printf 'GET / HTTP/1.1\r\nHost: example.com\r\nUser-Agent: shroudly-smoke\r\nConnection: close\r\n\r\n'; sleep 6) | timeout 20 $NC -q 1 -w 15 127.0.0.1 $pport | grep -a -o 'HTTP/1.[01] [0-9]*' | head -1"
}
listening() { grep -qi " 0100007F:$(printf '%04X' "$1") 00000000:0000 0A " <<<"$(sh_ "cat /proc/net/tcp")"; }
wait_for 60 vpn_refused || fail "could not take back the VPN consent for proxy only"
mode proxy
clear_log
ctl start
wait_for 30 has_log "Proxy only: Shroudly listens on 127.0.0.1:" || fail "proxy only did not start without the VPN consent ($(applog | grep -i 'proxy only' | tail -2 | tr '\n' ' '))"
pport="$(applog | sed -n 's/.*Proxy only: Shroudly listens on 127\.0\.0\.1:\([0-9]*\).*/\1/p' | head -1)"
[ -n "$pport" ] || fail "proxy only: no port in the log"
vpn_up && fail "proxy only brought up a VPN interface"
grep -q "VPN CONNECTED" <<<"$(sh_ "dumpsys connectivity")" && fail "proxy only: Android shows a VPN"
listening "$pport" || fail "proxy only: nothing listens on 127.0.0.1:$pport"
say "proxy only: on 127.0.0.1:$pport with the VPN consent taken back; no VPN on the phone"
pc="$(via_connect example.com)"
case "$pc" in *"200 Connection established"*"HTTP/1."*" 200 "*|*"200 Connection established"*"HTTP/1."*" 30"*) ;; *) fail "proxy only: HTTP CONNECT to example.com failed ($pc)";; esac
ps="$(via_socks)"
case "$ps" in *" 200"|*" 30"*) ;; *) fail "proxy only: SOCKS5 by name to example.com failed ($ps)";; esac
say "proxy only: HTTP CONNECT: $pc; SOCKS5 by name: $ps"
clear_log
ctl adblock-on
wait_for 30 has_log "Ad blocking: a list of" || fail "proxy only: ad blocking was not put to use ($(applog | grep 'Ad blocking' | tail -2 | tr '\n' ' '))"
pad="$(via_connect doubleclick.net)"
case "$pad" in *" 403 "*) ;; *) fail "proxy only, ad blocking on: doubleclick.net answered '$pad', not 403 from the engine";; esac
ctl adblock-off
say "proxy only: ad blocking stops doubleclick.net ($pad)"
clear_log
fault engine-stop
wait_for 30 has_log "Restarting engine in" || fail "proxy only: the engine was not started again"
wait_for 30 has_log "Starting engine: --listen 127.0.0.1 --port $pport " || fail "proxy only: the engine came back on another port than $pport, which apps are set to"
wait_for 30 eval 'grep -q " 200 " <<<"$(via_connect example.com)"' || fail "proxy only: nothing through the engine after its restart"
ctl stats
wait_for 15 has_log "stats: on" || fail "proxy only: no stats line"
pstats="$(applog | grep 'stats: on' | tail -1 | sed 's/.*stats: /stats: /')"
[ "$(sed -n 's/.*connections \([0-9]*\) total.*/\1/p' <<<"$pstats")" -ge 1 ] || fail "proxy only: the engine counted no connections ($pstats)"
say "proxy only: the engine back on $pport after it stopped; $pstats"
ctl stop
wait_for 30 has_log "Proxy only: off" || fail "proxy only did not go off"
wait_for 15 eval '! listening $pport' || fail "proxy only: 127.0.0.1:$pport still open after Stop"
mode vpn
wait_for 60 vpn_allowed || fail "could not allow the VPN again after proxy only"
say "proxy only: off, the port closed; back to the VPN mode"

# ── the app's own network cut ────────────────────────────────────────────
# What a phone maker's per-app network switch (or a firewall app) does: the
# engine reaches nothing while Android's own check of the network passes.
# Up to 2.6.1 every app then got nothing until the user found the switch.
# Needs root for iptables (google_apis images; not google_apis_playstore).
if [ "$("$ADB" -s "$SERIAL" root 2>&1 | grep -c 'cannot run as root')" = 0 ]; then
  sleep 3; adb_ wait-for-device
  wait_for 60 boot_done || fail "adbd did not come back as root"
  uid="$(sh_ "pm list packages -U $PKG" | sed -n 's/.*uid:\([0-9]*\).*/\1/p' | head -1)"
  [ -n "$uid" ] || fail "no uid for $PKG"
  clear_log
  ctl start
  wait_for 60 has_log "Protection on" || fail "protection did not come on again"
  wait_for 30 has_log "Path check (.*): through the engine to" || fail "no path check after start"
  cut() { sh_ "iptables -$1 OUTPUT -m owner --uid-owner $uid ! -o lo -j DROP; ip6tables -$1 OUTPUT -m owner --uid-owner $uid ! -o lo -j DROP" >/dev/null; }
  cut I
  t0=$(date +%s)
  # Apps keep trying meanwhile, as they do.
  direct_again() { http_get >/dev/null; ! vpn_up && grep -q '^HTTP/1' <<<"$(http_get)"; }
  if ! wait_for 300 direct_again; then cut D; fail "with the app's network cut, protection did not end: other apps got nothing"; fi
  cut D
  has_log "Ending protection so apps connect directly" || fail "protection ended, but not for the cut network"
  notice="$(sh_ "dumpsys notification --noredact" | grep -c "pkg=$PKG" || true)"
  say "app's network cut: protection ended by itself after $(( $(date +%s) - t0 )) s, other apps connect directly ($notice notices of the app)"

  # The network itself down (its own egress dropped, while Android still
  # calls it working for a while): not Shroudly's doing, so protection stays.
  clear_log
  ctl start
  wait_for 60 has_log "Protection on" || fail "protection did not come on again"
  wait_for 30 has_log "Path check (.*): through the engine to" || fail "no path check after start"
  outage() { sh_ "for t in iptables ip6tables; do for i in wlan0 eth0; do \$t -$1 OUTPUT -o \$i -j DROP; done; done" >/dev/null; }
  outage I
  t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt 100 ]; do http_get >/dev/null; done
  outage D
  vpn_up || fail "protection ended during an outage of the network itself"
  has_log "Ending protection" && fail "protection ended during an outage of the network itself"
  wait_for 90 net_up || fail "no internet through the VPN after the outage"
  say "network outage of $(( $(date +%s) - t0 )) s: protection stayed on ($(applog | grep -c 'the network is down') checks found the network down), works after: $(http_get)"

  # The clock moved an hour ahead, then back, as a phone setting its time
  # from the network does: nothing restarts, encrypted DNS goes on.
  clear_log
  sh_ "settings put global auto_time 0" >/dev/null
  dev_now="$(sh_ "date +%s" | tr -dc 0-9)"
  host_then=$(date +%s)
  set_clock() { sh_ "date -u $(sh_ "date -u -d @$1 +%m%d%H%M%Y.%S")" >/dev/null; }
  # The device's own time again: what it was, plus what went by since.
  clock_back() { set_clock $(( dev_now + $(date +%s) - host_then )); }
  set_clock $(( dev_now + 3600 )); sleep 30
  wait_for 60 net_up || { clock_back; fail "no internet after the clock moved ahead an hour"; }
  clock_back; sleep 30
  sh_ "settings put global auto_time 1" >/dev/null
  wait_for 60 net_up || fail "no internet after the clock was set back"
  vpn_up || fail "protection ended when the clock changed"
  no_false_alarm "after the clock changed"
  [ -n "$(resolved example.org)" ] || fail "names do not resolve after the clock changed"
  say "clock an hour ahead and back: protection stayed on, nothing restarted, names resolve, works after: $(http_get)"

  # Always-on VPN with "Block connections without VPN" (lockdown, Android
  # 10+): ending protection would leave apps nothing, so with the app's
  # network cut it must stay on, keep trying and say so; and come back once
  # the cut is gone. Set as Settings does, then the framework restarted.
  if [ "${SDK:-0}" -ge 29 ]; then
    ctl stop
    wait_for 30 tun_gone || fail "VPN still up before the always-on check"
    framework() {
      # Settings and app ops reach storage a moment after they are set; the
      # framework is ended without a chance to write them.
      sh_ "appops write-settings" >/dev/null; sleep 5
      # sys.boot_completed stays 1 through a framework restart: cleared by
      # hand, it says when the framework is back.
      sh_ "setprop sys.boot_completed 0" >/dev/null
      sh_ stop >/dev/null; sleep 2; sh_ start >/dev/null; sleep 8
      wait_for 300 boot_done || fail "the framework did not come back"
      sleep 15
    }
    sh_ "settings put secure always_on_vpn_app $PKG; settings put secure always_on_vpn_lockdown 1" >/dev/null
    clear_log
    framework
    wait_for 120 vpn_up || fail "Android did not start the always-on VPN"
    wait_for 60 net_up || fail "no internet through the always-on VPN"
    clear_log
    cut I
    t0=$(date +%s)
    while [ $(( $(date +%s) - t0 )) -lt 200 ]; do http_get >/dev/null; done
    lockdown_holds() { has_log "Lockdown (Android blocks connections without the VPN): staying on"; }
    if ! vpn_up || ! lockdown_holds; then cut D; fail "under lockdown, protection ended or did not say it holds on"; fi
    has_log "Ending protection" && { cut D; fail "under lockdown, protection ended"; }
    say "lockdown, app's network cut for 200 s: protection stayed on and keeps trying ($(applog | grep -c 'Trying everything again') retries)"
    cut D
    wait_for 400 has_log "The way through works again" || fail "under lockdown, protection did not come back after the cut"
    wait_for 60 net_up || fail "no internet under lockdown after the cut"
    say "lockdown, cut gone: back by itself: $(http_get)"
    # The tunnel stops twice in a row under lockdown: everything is tried
    # again on its plan. A path check meanwhile (this app to the engine,
    # never through the tunnel) passes, and must not call that off.
    clear_log
    fault tunnel-stop
    wait_for 30 has_log "Tunnel started again" || fail "under lockdown, the tunnel did not start again"
    wait_for 60 net_up || fail "under lockdown, no internet after the tunnel restarted"
    fault tunnel-stop
    wait_for 30 has_log "Tunnel stopped unexpectedly, again; giving up" || fail "under lockdown, the second tunnel stop was not seen"
    wait_for 30 lockdown_holds || fail "under lockdown, protection did not hold on after the tunnel stopped twice"
    fault path-check
    wait_for 30 has_log "Path check (.*): through the engine to" || fail "no path check while the tunnel was down"
    wait_for 120 has_log "Trying everything again" || fail "under lockdown, a passing path check called off the retry: the tunnel was never started again"
    wait_for 90 net_up || fail "under lockdown, no internet after everything was started again"
    say "lockdown, tunnel stopped twice: a passing path check did not call off the retry; everything started again: $(http_get)"
    sh_ "settings delete secure always_on_vpn_app; settings delete secure always_on_vpn_lockdown" >/dev/null
    framework
    "$ADB" -s "$SERIAL" root >/dev/null 2>&1 || true; sleep 3; adb_ wait-for-device
    wait_for 60 boot_done || fail "adbd did not come back as root"
    # Android may start the service again by itself after the restart (it was
    # always-on, and is sticky): protection is switched off once it is up.
    sleep 20
    if vpn_up; then ctl stop; wait_for 30 tun_gone || fail "VPN still up after always-on was switched off"; fi
  fi
else
  say "no root on this image: the cut-network check is skipped"
fi

# ── the window: update source and privacy policy ─────────────────────────
# Debug builds log which updates the window offers each time it starts.
window() {
  # Off: while on, the counters change every second and uiautomator never
  # sees the window idle.
  if vpn_up; then ctl stop; wait_for 30 tun_gone || fail "protection did not go off before the window checks"; fi
  clear_log
  sh_ "am force-stop $PKG" >/dev/null
  sh_ "am start -W -n $PKG/.MainActivity" >/dev/null
  # After the always-on check, Android may still bring the VPN back by itself
  # once the app runs again: off once more, and the window to the front.
  sleep 6
  if vpn_up; then
    ctl stop
    wait_for 30 tun_gone || fail "protection did not go off before the window checks"
    sh_ "am start -W -n $PKG/.MainActivity" >/dev/null
  fi
}
ui_has() { sh_ "uiautomator dump /sdcard/ui.xml" >/dev/null; grep -q -- "$1" <<<"$(sh_ "cat /sdcard/ui.xml")"; }
# The rows are at the bottom, more than a small screen shows at once: from
# the top, a little further down each time until the text is on screen.
ui_seek() {
  local i
  for _ in 1 2 3; do sh_ "input swipe 160 150 160 600 200" >/dev/null; done
  for i in 1 2 3 4 5 6 7 8 9 10; do
    ui_has "$1" && return 0
    sh_ "input swipe 160 450 160 250 400" >/dev/null
    sleep 1
  done
  return 1
}
window
wait_for 20 has_log "Updates: GitHub" || fail "installed from a file, the window does not look for updates on GitHub"
wait_for 40 ui_seek 'text="Release notes"' || fail "no GitHub releases link"
wait_for 40 ui_seek 'text="Privacy policy"' || fail "no privacy policy link"
say "installed from a file: updates from GitHub, links Release notes and Privacy policy"
adb_ install -r -i com.android.vending "$APK" >/dev/null || fail "install as Google Play failed"
say "installer now: $(sh_ "dumpsys package $PKG" | grep -m1 'installerPackageName=' | sed 's/^ *//')"
window
wait_for 20 has_log "Updates: Google Play" || fail "installed by Google Play, the window still looks for updates on GitHub"
wait_for 40 ui_seek 'text="Source code on GitHub"' || fail "installed by Google Play, the window still links the GitHub releases"
ui_has 'text="Release notes"' && fail "installed by Google Play, the window still links the GitHub releases"
say "installed by Google Play: no GitHub update check, links the source code instead"
# "Share logs": the row is there and opens Android's share sheet.
wait_for 40 ui_seek 'text="Share logs"' || fail "no Share logs row"
bounds="$(grep -o 'text="Share logs"[^>]*bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' <<<"$(sh_ "cat /sdcard/ui.xml")" | grep -o '\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]' | head -1)"
xy="$(sed 's/\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]/\1 \2 \3 \4/' <<<"$bounds" | awk '{ print int(($1+$3)/2), int(($2+$4)/2) }')"
sh_ "input tap $xy" >/dev/null
chooser() { grep -qi 'chooser\|intentresolver\|ResolverActivity' <<<"$(sh_ "dumpsys window" | grep -i 'mCurrentFocus\|mFocusedApp')"; }
wait_for 20 chooser || fail "Share logs did not open the share sheet"
say "Share logs opens the share sheet"
sh_ "input keyevent KEYCODE_BACK" >/dev/null
sh_ "am force-stop $PKG" >/dev/null

say "PASSED ($ABI, API $API)"
