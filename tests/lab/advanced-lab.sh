#!/usr/bin/env bash
# The Advanced mode engine on a real packet path (Linux, root): this machine is
# the client, a router namespace in the middle holds a filter, a server
# namespace behind it answers. The filter is iptables' string match, which
# looks at one packet at a time, the way many DPI boxes do: any packet that
# carries the blocked name is dropped.
#
#   client (root ns) 10.77.1.1 ── 10.77.1.2 router (filter) 198.51.100.1 ── 198.51.100.2 server
#                                                          10.77.3.1    ── 10.77.3.2    the same
#
# The server answers on two addresses behind the same filter: 198.51.100.2 (a
# documentation range, which the engine treats as the internet) and 10.77.3.2
# (a private range, a machine on the local network, which the engine must
# leave alone).
#
# What is checked, each against the engine actually running with NFQUEUE:
#   - without the engine the blocked name never loads and others do (the
#     filter works);
#   - with the default cut, the blocked name loads over TLS and plain HTTP, in
#     full, and the others still do;
#   - the same with the cut sent last part first (disorder);
#   - with the cut switched off, the decoy alone does not get past this
#     filter (so it is the cut that does it);
#   - on the private address the engine changes nothing: the filtered name
#     stays stopped there while the engine runs, and the raw_stats line it
#     writes at stop counts those packets as skipped;
#   - when the engine stops, none of its firewall rules are left.
#
#   sudo env "PATH=$PATH" bash tests/lab/advanced-lab.sh <shroudly-core-adv>
set -uo pipefail

ENGINE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
SRV_PID=""; SRV2_PID=""; ENG_PID=""
FAILS=0
PUB=198.51.100.2   # the server as seen on the internet
PRIV=10.77.3.2     # the same server on a private (local network) address
AT=$PUB            # where loads() connects

ok()   { echo "  ok  $*"; }
bad()  { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }

cleanup() {
  [ -n "$ENG_PID" ] && { touch "$WORK/status.log.stop"; sleep 1; kill "$ENG_PID" 2>/dev/null; }
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  [ -n "$SRV2_PID" ] && kill "$SRV2_PID" 2>/dev/null
  ip netns del shlab-r 2>/dev/null; ip netns del shlab-s 2>/dev/null; ip link del shlab-c 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── the network ─────────────────────────────────────────────────────────────
ip netns add shlab-r
ip netns add shlab-s
ip link add shlab-c type veth peer name shlab-r0
ip link set shlab-r0 netns shlab-r
ip -n shlab-r link add shlab-r1 type veth peer name shlab-s0
ip -n shlab-r link set shlab-s0 netns shlab-s
ip addr add 10.77.1.1/24 dev shlab-c && ip link set shlab-c up
ip -n shlab-r addr add 10.77.1.2/24 dev shlab-r0 && ip -n shlab-r link set shlab-r0 up
ip -n shlab-r addr add 198.51.100.1/24 dev shlab-r1
ip -n shlab-r addr add 10.77.3.1/24 dev shlab-r1 && ip -n shlab-r link set shlab-r1 up
ip -n shlab-r link set lo up
ip -n shlab-s addr add $PUB/24 dev shlab-s0
ip -n shlab-s addr add $PRIV/24 dev shlab-s0 && ip -n shlab-s link set shlab-s0 up
ip -n shlab-s link set lo up
ip -n shlab-s route add default via 198.51.100.1
ip route add 198.51.100.0/24 via 10.77.1.2
ip route add 10.77.3.0/24 via 10.77.1.2
ip netns exec shlab-r sysctl -qw net.ipv4.ip_forward=1
# The filter: one packet at a time, the name anywhere in it.
for port in 443 80; do
  ip netns exec shlab-r iptables -A FORWARD -p tcp --dport $port -m string --algo bm --string "blocked.lab" -j DROP
done

ip netns exec shlab-s node "$HERE/lab-server.js" $PUB > "$WORK/server.log" 2>&1 &
SRV_PID=$!
ip netns exec shlab-s node "$HERE/lab-server.js" $PRIV > "$WORK/server2.log" 2>&1 &
SRV2_PID=$!
for _ in $(seq 50); do grep -q "lab server" "$WORK/server.log" 2>/dev/null && grep -q "lab server" "$WORK/server2.log" 2>/dev/null && break; sleep 0.1; done

loads()  { node "$HERE/lab-client.js" "$AT" "$1" "${2:-tls}" "${3:-8000}"; }
expect_load() { local out; out=$(loads "$@"); if [ $? -eq 0 ]; then ok "$LABEL: $out"; else bad "$LABEL: $out"; fi; }
expect_fail() { local out; out=$(loads "$@"); if [ $? -ne 0 ]; then ok "$LABEL: $out"; else bad "$LABEL: $out"; fi; }

start_engine() {
  rm -f "$WORK/status.log" "$WORK/status.log.stop"
  "$ENGINE" --advanced --fake-ttl 4 --status-file "$WORK/status.log" --parent-pid $$ \
    --drop-rst 1 --autottl 1 --seqovl 0 --split "$1" --desync-mode fake --queue 200 &
  ENG_PID=$!
  for _ in $(seq 100); do grep -q '"raw_ready"' "$WORK/status.log" 2>/dev/null && break; sleep 0.1; done
  if grep -q '"raw_ready"' "$WORK/status.log" 2>/dev/null; then
    ok "engine up (split $1): $(grep -m1 '"raw_ready"' "$WORK/status.log")"
  else
    bad "engine did not come up (split $1): $(tail -5 "$WORK/status.log" 2>/dev/null)"
  fi
}
stop_engine() {
  touch "$WORK/status.log.stop"
  for _ in $(seq 50); do kill -0 "$ENG_PID" 2>/dev/null || break; sleep 0.1; done
  kill "$ENG_PID" 2>/dev/null; wait "$ENG_PID" 2>/dev/null; ENG_PID=""
}
# The counter $1 of the raw_stats line the engine wrote at stop, or "" when
# there is none.
stat_of() {
  grep '"type":"raw_stats"' "$WORK/status.log" 2>/dev/null | tail -1 | sed -n "s/.*\"$1\":\([0-9][0-9]*\).*/\1/p"
}

# ── 1. the filter, no engine ────────────────────────────────────────────────
LABEL="no engine, an unfiltered name loads";            expect_load www.allowed.lab tls
LABEL="no engine, the filtered name is stopped (TLS)";  expect_fail www.blocked.lab tls 5000
LABEL="no engine, the filtered name is stopped (HTTP)"; expect_fail www.blocked.lab http 5000
AT=$PRIV
LABEL="no engine, private address: an unfiltered name loads";   expect_load www.allowed.lab tls
LABEL="no engine, private address: the filtered name is stopped"; expect_fail www.blocked.lab tls 5000
AT=$PUB

# ── 2. the default: decoy, then the real first segment cut ─────────────────
start_engine on
LABEL="cut: the filtered name loads in full (TLS)";  expect_load www.blocked.lab tls
LABEL="cut: the filtered name loads in full (HTTP)"; expect_load www.blocked.lab http
LABEL="cut: a bare name loads (TLS)";                expect_load blocked.lab tls
LABEL="cut: an unfiltered name still loads";         expect_load www.allowed.lab tls
# The same filter in front of a machine on the local network: the engine
# leaves that traffic alone, so the filtered name stays stopped there.
AT=$PRIV
LABEL="cut, private address: the filtered name is left alone (TLS)";  expect_fail www.blocked.lab tls 5000
LABEL="cut, private address: the filtered name is left alone (HTTP)"; expect_fail www.blocked.lab http 5000
LABEL="cut, private address: an unfiltered name loads";              expect_load www.allowed.lab tls
AT=$PUB
stop_engine
skipped=$(stat_of skipped); desynced=$(stat_of desynced)
if [ -z "$skipped" ]; then
  bad "no raw_stats line at stop: $(tail -3 "$WORK/status.log" 2>/dev/null)"
else
  ok "at stop: $(grep '"type":"raw_stats"' "$WORK/status.log" | tail -1)"
  if [ "$skipped" -gt 0 ]; then ok "the private address was skipped ($skipped)"; else bad "skipped is $skipped after the private address"; fi
  if [ "${desynced:-0}" -gt 0 ]; then ok "the public address was desynced ($desynced)"; else bad "desynced is ${desynced:-none} after the public address"; fi
fi

# ── 3. the cut sent last part first ─────────────────────────────────────────
start_engine disorder
LABEL="disorder: the filtered name loads in full (TLS)";  expect_load www.blocked.lab tls
LABEL="disorder: the filtered name loads in full (HTTP)"; expect_load www.blocked.lab http
LABEL="disorder: an unfiltered name still loads";         expect_load www.allowed.lab tls
stop_engine

# ── 4. no cut: the decoy alone does not get past this filter ───────────────
start_engine off
LABEL="no cut: the filtered name is still stopped"; expect_fail www.blocked.lab tls 5000
LABEL="no cut: an unfiltered name loads";            expect_load www.allowed.lab tls
stop_engine

# ── 5. nothing left behind ──────────────────────────────────────────────────
left=$( (iptables -t mangle -S 2>/dev/null; nft list ruleset 2>/dev/null) | grep -c -E 'NFQUEUE|queue num|shroudly' )
if [ "$left" -eq 0 ]; then ok "after stopping, no firewall rule of the engine is left"; else bad "$left firewall rules left after stopping"; fi

if [ "$FAILS" -eq 0 ]; then echo "advanced-lab: all passed"; exit 0; fi
echo "advanced-lab: $FAILS failed"; exit 1
