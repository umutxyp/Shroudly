# shroudly-core — capability & threat model

Shroudly's engine is a **userspace SOCKS5 proxy** that reshapes the first client
payload (TLS ClientHello / HTTP request). This design is intentional: it needs no
kernel driver and runs identically and unprivileged on Windows, macOS and Linux.

That design choice defines exactly what it can and cannot defeat. Being honest
about this matters more than marketing.

## What it defeats (proven by tests)

**Stateless SNI/Host DPI** — the kind deployed by most ISPs, including Turkey and
many others. These middleboxes inspect packets individually and do not reassemble
the TCP stream. Splitting / reordering the ClientHello so the SNI never appears
whole in one segment defeats them.

Verified with a deterministic inline DPI simulator:

| DPI type              | no bypass | split(sni) | disorder(sni) |
|-----------------------|-----------|------------|---------------|
| Stateless (Turkey-like) | BLOCKED  | **PASS**   | **PASS**      |

Also defeats DNS-based blocking via the anti-poisoning resolver (multiple
resolvers + bogon filtering), without changing system DNS.

## What it does NOT defeat on its own

**Stateful, reassembling DPI** — Iran and China's GFW perform full TCP
reassembly before inspecting, so pure fragmentation does not help:

| DPI type              | no bypass | split(sni) | disorder(sni) |
|-----------------------|-----------|------------|---------------|
| Stateful (Iran/China) | BLOCKED  | BLOCKED    | BLOCKED       |

Defeating stateful DPI requires a **"fake packet" desync**: a decoy segment that
reaches the DPI (poisoning its reassembly state) but expires before the real
server — typically via a low TTL or a bad checksum. This is impossible to do
correctly from a userspace stream proxy, because the decoy must be injected
out-of-band at the packet layer with the live connection's sequence numbers.

The reference tool for this space, **zapret**, confirms the same split:
- its proxy component (`tpws`) does only split/disorder — exactly our engine;
- its packet component (`nfqws`) does `fake`/`rst` via NFQUEUE + raw sockets,
  and its own docs note the fake packet "doesn't go through FORWARD chain".

So a fake-packet mode is necessarily platform-specific kernel integration:
Linux NFQUEUE, Windows WinDivert, macOS pf/divert. That is the one place where
"no driver, works everywhere" cannot also mean "beats Iran/China". We choose the
portable, driver-free path as the default and document the limit rather than
pretending otherwise.

## Roadmap for stateful DPI (optional, platform-specific)

A future `SHROUDLY_RAW` build can add a packet-layer desync backend per OS. It is
intentionally NOT wired into the default build, because it would reintroduce the
driver/privilege dependency we removed. The engine's strategy parser already
accepts `fake(...)` ops so such a backend can be slotted in without changing the
UI or control protocol.

## Update: Advanced mode (packet-layer) — IMPLEMENTED for Linux

The optional advanced backend now exists and is tested:

- `core/src/raw_linux.c` — NFQUEUE + raw-socket fake-packet injection (low TTL,
  bad TCP checksum, scrambled SNI), built as `shroudly-core-adv` via
  `npm run build:core:advanced`. Needs root / CAP_NET_ADMIN + CAP_NET_RAW.
- `electron/advanced-mode.js` — installs/removes the NFQUEUE firewall rule and
  manages the backend; always reverts the rule on stop/crash/exit.
- UI: when a probe reports a site stays blocked (`suggest:"advanced"`), Settings
  offers "Try Advanced mode". Verified end-to-end (rule install/remove, fake
  packet injected with correct low TTL + XOR-scrambled SNI, real connection
  unaffected).

Windows (WinDivert) and macOS (pf/divert) advanced backends are still TODO; on
those platforms the UI reports advanced mode as unavailable with a clear reason,
and the default driver-free engine (stateless DPI) continues to work.

Flow: default engine always runs (no privileges). Advanced mode is opt-in, only
surfaced after a failed probe, and only where a packet backend is built.

## Update 2: Advanced backends — Windows and Linux (macOS not possible)

| OS      | Backend                         | File              | Privilege        |
|---------|---------------------------------|-------------------|------------------|
| Linux   | NFQUEUE + raw socket            | raw_linux.c       | CAP_NET_ADMIN/RAW|
| Windows | WinDivert 2.2 (signed driver)   | raw_windows.c     | Administrator    |

Both: intercept the first TLS/HTTP data packet, inject a low-TTL +
bad-checksum FAKE copy with XOR-scrambled SNI (reaches the DPI, dies before the
server), then let the real packet proceed. This defeats stateful DPI.

Windows has no ARM64 backend: WinDivert ships no ARM64 driver.

**macOS has no backend.** An earlier `raw_macos.c` targeted pf `divert-to` and
BSD divert sockets, but neither exists on current macOS: `pfctl` rejects both
`divert-to` and `divert-packet` as syntax errors, and divert sockets left the
kernel with ipfw. Intercepting packets on macOS needs a Network Extension,
which requires an Apple-signed, entitled app. zapret reaches the same
conclusion (only its proxy, `tpws`, runs on macOS).

### Elevation and lifecycle (supervise.c)

The app runs unprivileged. Advanced mode starts `shroudly-core-adv` through a
UAC prompt (Windows) or `pkexec` (Linux). Because an unprivileged process can
neither pipe nor signal an elevated one, the engine is driven through files:

- `--status-file F`: the engine writes its JSON lines (and stderr) to `F`.
- `F.stop`: the app creates it to ask the engine to stop.
- `--parent-pid P`: the engine exits by itself when the app is gone.

On Linux the engine installs its own NFQUEUE rule (iptables, else nftables)
and removes it on every stop path. Its injected fakes carry fwmark
`0x10000000`, which the rule skips, so a decoy is never re-queued. The rule uses
queue-bypass, so even a crashed engine never blocks traffic. On Windows the
WinDivert filter disappears with the engine's handle when it exits.

Build: `npm run build:core:advanced` (native) or `:all` (cross via zig; Linux
cross-builds need a libnetfilter_queue sysroot, see the script header).
Windows packaging also needs `npm run fetch:windivert`, which downloads the
official release, checks its pinned SHA-256 and copies `WinDivert.dll`,
`WinDivert64.sys` and the license next to the x64 engine.

## Update 3: where things stand (2.4.3)

The sections above are kept as they were written; this is the current state.

**Default engine (no privileges)**
- `tlsrec` re-frames the ClientHello as two TLS records. Filters that reassemble
  TCP but read a single record are beaten by it, which plain `split`/`disorder`
  could not do (the "Stateful" row in the first table predates it). It leads
  the auto-probe ladder, alone and combined with `split`, `disorder` and `oob`.
- On Linux the default engine also has a decoy first segment (`fake(md5,…)`):
  a TCP signature option makes the server discard it while the filter reads it.
  Needs no privileges; last in the ladder because it is the least portable.

**Connections that are cut after the handshake**
Some filters let the handshake through and stop the data (Iran's, and
Russia's 16 KB throttling). The relay now watches TLS connections for a stall
halfway through a record, a reset, or a request never answered, reports a
`cut` event, and the next connection to that host uses the next technique.
Tested against a fake censor in `tests/net/engine-cut.test.js`, and against
hostile servers under AddressSanitizer in `engine-hostile.test.js`.

**DNS**
The app's DoH forwarder has 17 routes from 6 operators over HTTP/2, some by
address with no SNI, some by name through the engine on shared CDN addresses,
with per-route health and failover. Plain-DNS answers pointing at ~180 known
block pages (OONI fingerprints, 24 countries) are refused via `--block-ip`, in
addition to bogons.

**Still not defeated by any technique here**
Blocking by server address, protocol whitelisting and shutdowns. The app says
so plainly when it sees the signs, instead of looking like it works.

## Update 4: Advanced mode UDP — QUIC forced to TCP, Discord voice decoys (2.5.5)

Both advanced backends now also handle outbound IPv4 UDP (IPv6 UDP is
re-injected unchanged; the backend builds IPv4 fakes only). The kernel-queue
filter stays narrow (proto + port); payloads are classified in code
(`core/src/udpdpi.c`, unit-tested in `core/test/test_udpdpi.c`). Every UDP
datagram that is not an exact match is re-injected unchanged, and every error
path re-injects the real datagram — the only deliberate drop is the QUIC Initial.

- **QUIC forced to TCP.** Browsers send HTTP/3 over QUIC (UDP/443), which never
  enters the TCP proxy and so is filtered directly, breaking YouTube/Google even
  with Shroudly on. The backend drops the QUIC **Initial** packet (long header,
  real version v1 / v2 / `ff0000xx` draft; Version Negotiation and short-header
  packets pass), so the browser falls back to TCP — the same move GoodbyeDPI and
  zapret make. The engine has no routed-by-IP map at the packet layer (routing
  is by SNI/host in the userspace proxy), so the drop is unconditional while the
  feature is on; non-blocked sites merely lose QUIC's latency benefit and keep
  working over TCP. Switchable (`--no-quic-block`), on by default.
- **Decoy packets for Discord voice.** A censor can fingerprint the first voice
  datagrams — Discord's 74-byte IP-discovery request and RFC 5389 STUN binding
  requests — on the media ports (50000-65535) and STUN ports (3478, 19302-19309).
  Ahead of the first one or two datagrams of each flow (tracked in a bounded
  256-entry, 10 s table), the backend injects N (default 6) decoy datagrams to
  the same 5-tuple: random payload of the same length, the configured low fake
  TTL, valid IPv4+UDP checksums (so a checksum-validating middlebox still
  ingests them; the low TTL alone stops them before the server). The real
  datagram is then re-injected unchanged. Switchable (`--no-udp-fake`), on by
  default; count via `--fake-repeats`.

On Linux the UDP NFQUEUE rule (iptables, else nftables) is installed at start
and removed on every stop path exactly like the TCP rule, over the same queue;
injected fakes carry fwmark `0x10000000` and the rule skips them. On Windows the
UDP clauses join the WinDivert filter; WinDivert tags its own injected packets
(WFP), so decoys are never re-captured.

**Only a network-level block.** These help only where the *network* filters QUIC
or the voice packets. A hard IP block of the servers is unaffected — the app
still says so and points to a VPN.

## Update 5: SOCKS5 UDP ASSOCIATE — plain datagram relay (for Android)

The Android app sends the whole phone's traffic through a tun2socks into the
engine, and phones need UDP (games, voice calls, apps' own DNS). The engine now
answers SOCKS5 `UDP ASSOCIATE` (RFC 1928 section 7, `udp_associate` in
`engine.c`; the header parse/build is the pure `socksudp.c`, unit-tested in
`core/test/test_socksudp.c`, end to end in `tests/net/engine-udp.test.js`).

- Only a loopback client may ask; it gets a relay port on `127.0.0.1` of its
  own. The association lives as long as its TCP control connection, or until
  120 s pass with no datagram either way. At most 256 at once; one more is
  refused (reply 0x01).
- Only datagrams from the control connection's own address are taken.
  Fragments (FRAG != 0) and malformed headers are dropped. A destination may be
  IPv4, IPv6 or a name (resolved by the engine's own resolver, as CONNECT does).
- Each association sends from outbound sockets of its own (one per address
  family) and returns replies, headed with their source, only to the client
  address that sent last: nothing goes anywhere that did not send first.
- Up to 65507 bytes of payload. No desync: a plain relay. Nothing on the
  desktop uses it (the engine listens on loopback only), so it changes nothing
  there.
