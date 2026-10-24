#!/usr/bin/env bash
# What Shroudly's engine does on the kinds of networks people report from, on
# a real packet path (Linux, root): this machine is the client, a router
# namespace in the middle filters the way a censor does, a server namespace
# behind it answers every name (tests/lab/lab-server.js). The engine runs as
# it does in the app: a SOCKS proxy that apps go through, with encrypted DNS
# (the app's forwarder standing in, tests/lab/lab-dns.js) and the network's
# own DNS for getaddrinfo (a lab resolver, in a mount namespace of the
# engine's own so the machine's is left alone).
#
#   client 10.77.1.1 ── 10.77.1.2 router (the filters) 198.51.100.1 ── server 198.51.100.x
#
# Each network kind, with what must come of it:
#   - a filter that drops any packet carrying the name (DPI on the first
#     packet, silently): the page loads through the engine on the first
#     connection, which says a technique opened it (this lab found that the
#     first five techniques all left the domain whole, and that 15 s of
#     silent tries ran out before the sixth: the mid-name cut is now first);
#   - one that resets the connection instead (an injected RST): the same;
#   - the site's addresses from encrypted DNS blocked outright, the
#     network's own DNS giving one that works (a CDN's cache in the country,
#     issue #37): it loads on the first connection (#40), at that address;
#   - the same with a network DNS that takes 3 s to answer (#43): it still
#     loads;
#   - the network's DNS giving the very address that is blocked: it does not
#     load, and the engine says why (the same addresses; unreachable);
#   - a name nobody filters: it loads, and nothing is said about it.
#
#   sudo env "PATH=$PATH" bash tests/lab/censor-lab.sh <shroudly-core>
set -uo pipefail

ENGINE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
PIDS=()
ENG_PID=""
FAILS=0
WEB=198.51.100.2       # the server, reachable
BLOCKED_IP=198.51.100.7 # an address the network drops outright
NETDNS=198.51.100.5     # the network's DNS
FWD_PORT=5398           # the encrypted-DNS forwarder standing in
SOCKS=19180

ok()  { echo "  ok  $*"; }
bad() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }

cleanup() {
  [ -n "$ENG_PID" ] && kill "$ENG_PID" 2>/dev/null
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  ip netns del shcl-r 2>/dev/null; ip netns del shcl-s 2>/dev/null; ip link del shcl-c 2>/dev/null
  ip route del 198.51.100.0/24 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── the network ─────────────────────────────────────────────────────────────
ip netns add shcl-r
ip netns add shcl-s
ip link add shcl-c type veth peer name shcl-r0
ip link set shcl-r0 netns shcl-r
ip -n shcl-r link add shcl-r1 type veth peer name shcl-s0
ip -n shcl-r link set shcl-s0 netns shcl-s
ip addr add 10.77.1.1/24 dev shcl-c && ip link set shcl-c up
ip -n shcl-r addr add 10.77.1.2/24 dev shcl-r0 && ip -n shcl-r link set shcl-r0 up
ip -n shcl-r addr add 198.51.100.1/24 dev shcl-r1 && ip -n shcl-r link set shcl-r1 up
ip -n shcl-r link set lo up
for a in $WEB $BLOCKED_IP $NETDNS; do ip -n shcl-s addr add $a/24 dev shcl-s0; done
ip -n shcl-s link set shcl-s0 up
ip -n shcl-s link set lo up
ip -n shcl-s route add default via 198.51.100.1
ip route add 198.51.100.0/24 via 10.77.1.2
ip netns exec shcl-r sysctl -qw net.ipv4.ip_forward=1

# ── the censor ──────────────────────────────────────────────────────────────
R() { ip netns exec shcl-r iptables "$@"; }
# DPI on one packet at a time: the name anywhere in it.
R -A FORWARD -p tcp --dport 443 -m string --algo bm --string "drop.lab" -j DROP
R -A FORWARD -p tcp --dport 443 -m string --algo bm --string "reset.lab" -j REJECT --reject-with tcp-reset
# An address blocked outright, whatever is sent to it.
R -A FORWARD -d $BLOCKED_IP -j DROP

# ── the far end ─────────────────────────────────────────────────────────────
for a in $WEB $BLOCKED_IP; do
  ip netns exec shcl-s node "$HERE/lab-server.js" $a > "$WORK/server-$a.log" 2>&1 &
  PIDS+=($!)
done
# The network's DNS: a cache in the country for cdn.lab, the same for
# slow.lab but after 3 s, and the blocked address itself for same.lab.
ip netns exec shcl-s node "$HERE/lab-dns.js" network $NETDNS \
  cdn.lab=$WEB slow.lab=$WEB@3000 same.lab=$BLOCKED_IP > "$WORK/netdns.log" 2>&1 &
PIDS+=($!)
# Encrypted DNS (the forwarder): the real addresses, as abroad sees them.
node "$HERE/lab-dns.js" forwarder $FWD_PORT \
  www.drop.lab=$WEB www.reset.lab=$WEB www.free.lab=$WEB \
  cdn.lab=$BLOCKED_IP slow.lab=$BLOCKED_IP same.lab=$BLOCKED_IP > "$WORK/fwd.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 50); do
  [ "$(cat "$WORK"/server-*.log 2>/dev/null | grep -c 'lab server')" -ge 2 ] && grep -q ready "$WORK/netdns.log" && grep -q ready "$WORK/fwd.log" && break
  sleep 0.1
done

# The filter works: straight to the server, the filtered names never load.
LABEL="no engine: a name nobody filters loads"
out=$(node "$HERE/lab-client.js" $WEB www.free.lab tls 5000) && ok "$LABEL ($out)" || bad "$LABEL ($out)"
for n in www.drop.lab www.reset.lab; do
  out=$(node "$HERE/lab-client.js" $WEB $n tls 5000) && bad "no engine: $n should be stopped ($out)" || ok "no engine: $n is stopped ($out)"
done
out=$(node "$HERE/lab-client.js" $BLOCKED_IP www.free.lab tls 4000) && bad "no engine: the blocked address should be dropped ($out)" || ok "no engine: the blocked address is dropped ($out)"

# ── the engine, as in the app ───────────────────────────────────────────────
printf 'nameserver %s\noptions timeout:5 attempts:1\n' $NETDNS > "$WORK/resolv.conf"
# Plain DNS from resolv.conf, not systemd-resolved (Ubuntu's NSS asks it first).
printf 'hosts: files dns\n' > "$WORK/nsswitch.conf"
mkfifo "$WORK/stdin"
# The engine stops when its stdin closes: held open by a sleeper.
sleep 600 > "$WORK/stdin" &
PIDS+=($!)
unshare --mount bash -c "mount --bind '$WORK/resolv.conf' /etc/resolv.conf && mount --bind '$WORK/nsswitch.conf' /etc/nsswitch.conf && exec '$ENGINE' --listen 127.0.0.1 --port $SOCKS --auto --doh --doh-port $FWD_PORT" \
  < "$WORK/stdin" > "$WORK/engine.log" 2> "$WORK/engine.err" &
ENG_PID=$!
for _ in $(seq 100); do grep -q '"ready"' "$WORK/engine.log" 2>/dev/null && break; sleep 0.1; done
grep -q '"ready"' "$WORK/engine.log" && ok "engine up: $(grep -m1 '"ready"' "$WORK/engine.log")" || { bad "engine did not start: $(tail -3 "$WORK/engine.err")"; exit 1; }

# The engine's lines about one name, since mark $1 (a line count).
lines_for() { tail -n +"$(( $1 + 1 ))" "$WORK/engine.log" | grep -F "\"$2\"" || true; }
mark() { wc -l < "$WORK/engine.log"; }
through() { node "$HERE/socks-client.js" $SOCKS "$1" "${2:-30000}"; }

m=$(mark); out=$(through www.free.lab)
if [ $? -eq 0 ] && [ -z "$(lines_for "$m" www.free.lab | grep -E '"type":"(bypass|blocked|unreachable|netdns)"')" ]; then ok "a name nobody filters: loads, nothing said ($out)"; else bad "a name nobody filters ($out): $(lines_for "$m" www.free.lab)"; fi

for n in drop reset; do
  m=$(mark); out=$(through www.$n.lab)
  if [ $? -eq 0 ]; then ok "DPI that ${n}s: loads through the engine ($out)"; else bad "DPI that ${n}s: $out"; fi
  l=$(lines_for "$m" www.$n.lab | grep '"type":"bypass"' | head -1)
  [ -n "$l" ] && ok "  and says a technique opened it: $l" || bad "  no bypass line: $(lines_for "$m" www.$n.lab | head -3)"
  # Learned: the next connection opens at once.
  out=$(through www.$n.lab 5000) && ok "  and the next connection opens at once ($out)" || bad "  the next connection: $out"
done

m=$(mark); out=$(through cdn.lab)
if [ $? -eq 0 ]; then ok "address blocked, the network's DNS has one that works: loads on the first connection ($out)"; else bad "address blocked, network DNS has one: $out"; fi
l=$(lines_for "$m" cdn.lab | grep '"type":"netdns"' | tr '\n' ' ')
echo "$l" | grep -q '"stage":"try"' && ok "  at the network DNS's address: $l" || bad "  no netdns try: $(lines_for "$m" cdn.lab | head -3)"

m=$(mark); out=$(through slow.lab 40000)
if [ $? -eq 0 ]; then ok "the same with a network DNS that takes 3 s (#43): loads ($out)"; else bad "slow network DNS (#43): $out"; fi

m=$(mark); out=$(through same.lab 40000)
if [ $? -ne 0 ]; then ok "the network's DNS gives the blocked address too: does not load ($out)"; else bad "same.lab should not load: $out"; fi
l=$(lines_for "$m" same.lab | grep -E '"stage":"same"|"type":"unreachable"' | tr '\n' ' ')
echo "$l" | grep -q '"stage":"same"' && echo "$l" | grep -q '"type":"unreachable"' && ok "  and says why: $l" || bad "  the engine did not say why: $(lines_for "$m" lab | tail -4)"

# The engine stops on STOP (or when its input closes), not on a signal.
echo STOP > "$WORK/stdin"
for _ in $(seq 50); do kill -0 "$ENG_PID" 2>/dev/null || break; sleep 0.1; done
kill "$ENG_PID" 2>/dev/null; ENG_PID=""
echo
if [ "$FAILS" -eq 0 ]; then echo "censor lab: all passed"; exit 0; fi
echo "censor lab: $FAILS FAILED"; echo "--- engine output"; tail -40 "$WORK/engine.log"; tail -10 "$WORK/engine.err"
exit 1
