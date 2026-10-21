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
#   - a server that answers a ClientHello carrying a decoy with a TLS alert
#     (198.51.100.3, the way a nearby server does when the decoy reaches it)
#     gets no decoy on the next ClientHello, while another server still does:
#     the router counts the low-TTL decoys per address. Needs the engine's
#     inbound alert rule (the u32 match, or nft's payload match); skipped,
#     and said so, without it;
#   - UDP, against a voice server (198.51.100.4, UDP only): Discord's IP
#     discovery request and a STUN Binding request each get their decoys, and
#     the server sees the decoys arrive before the real request; a call's own
#     datagrams (RTP) and QUIC short headers all arrive, with no decoy; a QUIC
#     Initial is dropped; nothing is sent ahead of a request to the private
#     address; and, where the kernel has the u32 match, the engine is never
#     even handed the call's datagrams (its raw_stats udp_seen counts only the
#     requests). Without u32 that last check is skipped, and said so;
#   - when the engine stops, none of its firewall rules are left.
#
#   sudo env "PATH=$PATH" bash tests/lab/advanced-lab.sh <shroudly-core-adv>
set -uo pipefail

ENGINE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
SRV_PID=""; SRV2_PID=""; SRV3_PID=""; UDP_PID=""; UDP2_PID=""; ENG_PID=""
FAILS=0
PUB=198.51.100.2   # the server as seen on the internet
PRIV=10.77.3.2     # the same server on a private (local network) address
ALERT=198.51.100.3 # a server that answers every ClientHello with a TLS alert
VOICE=198.51.100.4 # a voice / STUN server, UDP only: no TCP goes there, so the
                   # decoys keep the fixed TTL and reach it, in the order sent
AT=$PUB            # where loads() connects

ok()   { echo "  ok  $*"; }
bad()  { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }

cleanup() {
  [ -n "$ENG_PID" ] && { touch "$WORK/status.log.stop"; sleep 1; kill "$ENG_PID" 2>/dev/null; }
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  [ -n "$SRV2_PID" ] && kill "$SRV2_PID" 2>/dev/null
  [ -n "$SRV3_PID" ] && kill "$SRV3_PID" 2>/dev/null
  [ -n "$UDP_PID" ] && kill "$UDP_PID" 2>/dev/null
  [ -n "$UDP2_PID" ] && kill "$UDP2_PID" 2>/dev/null
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
ip -n shlab-s addr add $ALERT/24 dev shlab-s0
ip -n shlab-s addr add $VOICE/24 dev shlab-s0
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
ip netns exec shlab-s node "$HERE/lab-server.js" $ALERT alert > "$WORK/server3.log" 2>&1 &
SRV3_PID=$!
ip netns exec shlab-s node "$HERE/lab-udp.js" serve $VOICE 443 3478 50003 > "$WORK/udp.log" 2>&1 &
UDP_PID=$!
ip netns exec shlab-s node "$HERE/lab-udp.js" serve $PRIV 50003 > "$WORK/udp2.log" 2>&1 &
UDP2_PID=$!
for _ in $(seq 50); do grep -q "lab server" "$WORK/server.log" 2>/dev/null && grep -q "lab server" "$WORK/server2.log" 2>/dev/null && grep -q "lab server" "$WORK/server3.log" 2>/dev/null \
  && grep -q "lab udp" "$WORK/udp.log" 2>/dev/null && grep -q "lab udp" "$WORK/udp2.log" 2>/dev/null && break; sleep 0.1; done
# The router counts the decoys going to each public address: a decoy's TTL is
# set to run out about here, a real segment's is not. They die at the router
# (TTL), but PREROUTING sees them first.
DECOY_COUNT=1
for a in $ALERT $PUB; do
  ip netns exec shlab-r iptables -t mangle -A PREROUTING -d $a -p tcp --dport 443 -m ttl --ttl-lt 16 || DECOY_COUNT=0
done
# The same for UDP decoys (a real datagram leaves with TTL 64, a decoy with 4).
for a in $VOICE $PRIV; do
  ip netns exec shlab-r iptables -t mangle -A PREROUTING -d $a -p udp -m ttl --ttl-lt 16 || DECOY_COUNT=0
done
# Decoys seen so far going to address $1, or "" when the router cannot count.
decoys_to() {
  [ "$DECOY_COUNT" = 1 ] || return 0
  ip netns exec shlab-r iptables-save -c -t mangle 2>/dev/null | grep -F -- "-d $1/32 " | grep -F -- "--ttl-lt" \
    | sed -n 's/^\[\([0-9][0-9]*\):.*/\1/p' | head -1
}

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

# ── 5. a server the decoy upsets gets no decoy next time ───────────────────
start_engine on
watch=$(grep -m1 '"raw_ready"' "$WORK/status.log" 2>/dev/null | sed -n 's/.*"alert_watch":\([01]\).*/\1/p')
if [ "$watch" != 1 ]; then
  ok "alert fallback: skipped, the inbound alert rule is not available here (alert_watch=${watch:-none})"
  stop_engine
elif [ -z "$(decoys_to $ALERT)" ]; then
  ok "alert fallback: skipped, the router cannot count decoys (no ttl match)"
  stop_engine
else
  AT=$ALERT
  a0=$(decoys_to $ALERT)
  LABEL="alert server: the first ClientHello is refused"; expect_fail www.allowed.lab tls 3000
  a1=$(decoys_to $ALERT)
  if [ "$a1" -gt "$a0" ]; then ok "the first ClientHello carried a decoy ($a0 -> $a1)"; else bad "no decoy on the first ClientHello ($a0 -> $a1)"; fi
  LABEL="alert server: the next ClientHello is refused too"; expect_fail www.allowed.lab tls 3000
  a2=$(decoys_to $ALERT)
  if [ "$a2" -eq "$a1" ]; then ok "the next ClientHello to that server carried no decoy ($a1 -> $a2)"; else bad "the next ClientHello still carried a decoy ($a1 -> $a2)"; fi
  AT=$PUB
  p0=$(decoys_to $PUB)
  LABEL="alert fallback: the filtered name still loads elsewhere"; expect_load www.blocked.lab tls
  p1=$(decoys_to $PUB)
  if [ "$p1" -gt "$p0" ]; then ok "another server still gets its decoy ($p0 -> $p1)"; else bad "another server got no decoy ($p0 -> $p1)"; fi
  stop_engine
  hurt=$(stat_of decoy_hurt); nodecoy=$(stat_of nodecoy)
  ok "at stop: $(grep '"type":"raw_stats"' "$WORK/status.log" | tail -1)"
  if [ "${hurt:-0}" -ge 1 ]; then ok "decoy_hurt is $hurt"; else bad "decoy_hurt is ${hurt:-none}"; fi
  if [ "${nodecoy:-0}" -ge 1 ]; then ok "nodecoy is $nodecoy"; else bad "nodecoy is ${nodecoy:-none}"; fi
fi

# ── 6. UDP: decoys ahead of a call's first datagrams, the call left alone ───
udp_send() { node "$HERE/lab-udp.js" send "$@" > /dev/null; sleep 0.5; }
# What the voice server saw on port $1, in order: R for the real request
# (its first four bytes are $2), d for anything else (a decoy).
order_on() { awk -v p="$1" -v r="$2" '$1 == p { printf "%s", ($3 == r ? "R" : "d") }' "$WORK/udp.log"; }
# Datagrams the voice server saw on port $1, $2 bytes long, whose first byte
# is $3 (the length keeps a decoy that happens to start the same apart).
count_on() { awk -v p="$1" -v l="$2" -v b="$3" '$1 == p && $2 == l && substr($3, 1, 2) == b { n++ } END { print n + 0 }' "$WORK/udp.log"; }
start_engine on
match=$(grep -m1 '"raw_ready"' "$WORK/status.log" 2>/dev/null | sed -n 's/.*"udp_match":\([01]\).*/\1/p')
ok "UDP payload tests in the kernel: udp_match=${match:-none}"

v0=$(decoys_to $VOICE)
udp_send $VOICE 50003 discovery
v1=$(decoys_to $VOICE)
o=$(order_on 50003 00010046)
if [[ "$o" =~ ^d+R$ ]]; then ok "IP discovery: $(( ${#o} - 1 )) decoys reached the server before the real request ($o)"; else bad "IP discovery: the server saw '$o' (d: decoy, R: the request)"; fi
if [ -z "$v0" ] || [ $((v1 - v0)) -ge 6 ]; then ok "IP discovery: the router counted ${v0:+$((v1 - v0)) }low-TTL datagrams"; else bad "IP discovery: the router counted $((v1 - v0)) low-TTL datagrams"; fi

udp_send $VOICE 3478 stun
o=$(order_on 3478 00010000)
if [[ "$o" =~ ^d+R$ ]]; then ok "STUN Binding request: $(( ${#o} - 1 )) decoys before the real request ($o)"; else bad "STUN Binding request: the server saw '$o'"; fi

v2=$(decoys_to $VOICE)
udp_send $VOICE 50003 rtp 40
v3=$(decoys_to $VOICE)
n=$(count_on 50003 172 80)
if [ "$n" -eq 40 ]; then ok "a call's own datagrams: all 40 arrived"; else bad "a call's own datagrams: $n of 40 arrived"; fi
if [ "$v3" = "$v2" ]; then ok "and none of them got a decoy"; else bad "they got decoys ($v2 -> $v3)"; fi

udp_send $VOICE 443 quic-initial
udp_send $VOICE 443 quic-short 10
if [ "$(count_on 443 1200 c3)" -eq 0 ]; then ok "a QUIC Initial is dropped (the browser takes TCP)"; else bad "a QUIC Initial reached the server"; fi
n=$(count_on 443 60 41)
if [ "$n" -eq 10 ]; then ok "QUIC short headers all arrive"; else bad "QUIC short headers: $n of 10 arrived"; fi

p0=$(decoys_to $PRIV)
udp_send $PRIV 50003 discovery
p1=$(decoys_to $PRIV)
if grep -q '^50003 74 00010046' "$WORK/udp2.log" && [ "$p1" = "$p0" ]; then ok "private address: the request arrives, nothing sent ahead of it"; else bad "private address: decoys $p0 -> $p1, $(cat "$WORK/udp2.log" | tail -3)"; fi
stop_engine
ok "at stop: $(grep '"type":"raw_stats"' "$WORK/status.log" | tail -1)"
ud=$(stat_of udp_decoys); us=$(stat_of udp_seen); qd=$(stat_of quic_dropped)
if [ "${ud:-0}" -ge 12 ]; then ok "udp_decoys is $ud"; else bad "udp_decoys is ${ud:-none}"; fi
if [ "${qd:-0}" -ge 1 ]; then ok "quic_dropped is $qd"; else bad "quic_dropped is ${qd:-none}"; fi
if [ "$match" = 1 ]; then
  # Handed over: the discovery requests, the STUN request and the QUIC
  # Initial; not the 40 RTP datagrams nor the 10 short headers.
  if [ "${us:-99}" -lt 10 ]; then ok "the engine was handed only the requests ($us datagrams), never the call"; else bad "the engine was handed ${us:-none} datagrams: the call went through the queue"; fi
else
  ok "udp_seen is ${us:-none}: skipped, the kernel has no u32 match here, so the ports alone are queued"
fi

# ── 7. nothing left behind ──────────────────────────────────────────────────
left=$( (iptables -t mangle -S 2>/dev/null; nft list ruleset 2>/dev/null) | grep -c -E 'NFQUEUE|queue num|shroudly' )
if [ "$left" -eq 0 ]; then ok "after stopping, no firewall rule of the engine is left"; else bad "$left firewall rules left after stopping"; fi

if [ "$FAILS" -eq 0 ]; then echo "advanced-lab: all passed"; exit 0; fi
echo "advanced-lab: $FAILS failed"; exit 1
