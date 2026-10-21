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
  own, an ephemeral one the system picks. The association lives as long as its TCP control connection, or until
  120 s pass with no datagram either way. At most 256 at once; one more is
  refused (reply 0x01).
- An association belongs to one client endpoint, address and port: the one
  the request names (a non-zero port, with 0.0.0.0 or the control connection's
  own address), else the one the first well-formed datagram comes from. It is
  fixed from then on; datagrams from any other port are dropped, so another
  program on the machine can neither send through it nor take its replies.
  hev-socks5-tunnel (Android) asks with 0.0.0.0:0, so there the first
  well-formed datagram pins it. Between the reply and that datagram another
  local program that found the new port could send first; the port is
  ephemeral, on loopback, told only to the client that asked, and with
  `--auth-file` only an authenticated client can create an association at
  all. That residual window is accepted.
  Fragments (FRAG != 0) and malformed headers are dropped. A destination may be
  IPv4, IPv6 or a name (resolved by the engine's own resolver, as CONNECT does),
  but never loopback or unspecified (127/8, 0.0.0.0/8, ::1, ::, and their
  IPv4-mapped forms): no relay can feed another, or itself.
- Plain DNS (a query to port 53) goes to the encrypted-DNS forwarder instead,
  when the engine runs with `--doh` and `--doh-port`; the answer comes back
  headed with the address the app asked, so an app with its own resolver gets
  encrypted DNS too. Only a well-formed standard query (QR clear, opcode 0,
  one question) is taken; one for a resolver at a private or link-local
  address, or about a name only the LAN knows, and anything else on port 53
  go where they were sent. Each query carries an id of its own to the
  forwarder (the app's comes back on the answer), so two queries with the
  same id cannot get each other's answers. One the forwarder has not
  answered within 2.5 s is also sent where it was headed, in plaintext, and
  that answer relayed. An answer over 512 bytes to a query without EDNS comes
  back as the question with TC set; the app asks again over TCP.
- Each association sends from outbound sockets of its own (one per address
  family) and returns replies, headed with their source, only to its client:
  nothing goes anywhere that did not send first.
- Up to 65507 bytes of payload. No desync: a plain relay. Nothing on the
  desktop uses it (the engine listens on loopback only), so it changes nothing
  there.

## Update 6: optional SOCKS5 username/password; intranet names

- `--auth-file <path>`: the file holds `user:pass` (one line, read once at
  start, so the secret is not on the command line). Every SOCKS5 client must
  then offer username/password (RFC 1929) and give exactly those, compared in
  constant time; a wrong one gets status 1, a client offering no 0x02 gets
  0xFF, and SOCKS4 (no password) is refused. A file that cannot be used stops
  the engine. Without the option nothing changes; the desktop app does not use
  it. `tests/net/engine-auth.test.js`.
- Names only the local network knows (one label, `.local`, `.lan`,
  `.home.arpa`, `.internal`, ...) are asked of the system resolver alone, and
  its private answer is taken. Only those names: a public-looking name
  answered only with a private address is refused, whether encrypted DNS says
  it does not exist or publishes just that address (a censor's answer, or a
  page pointing a public name at the LAN to rebind). A known block page is
  always refused.
  `core/test/test_bogon.c`.

## Update 7: stand-in addresses; the engine's pid

- `--fake-net <CIDR>` (repeatable, or several joined by commas; IPv4 or
  IPv6): a CONNECT to an address inside is refused at once (SOCKS5 0x02,
  SOCKS4 0x5B) and a datagram to one is dropped. The Android app passes its
  tunnel's name-to-address pool (198.18.0.0/15), so a stand-in address that
  outlived its mapping fails fast instead of waiting out a connect timeout.
  A range that does not parse stops the engine. The desktop does not use it.
  `tests/net/engine-fakenet.test.js`.
- The ready line names the engine's own process id
  (`{"type":"ready","port":...,"techniques":...,"pid":...}`), so a
  supervisor without a process handle can kill a hung engine. Readers take
  the fields they know and ignore the rest.

## Update 8: Advanced mode — no decoy for a server the decoy reaches

The decoy (a copy of the first segment with the name scrambled, a bad TCP
checksum and a TTL meant to run out on the way) can still reach a server only
a few hops away, such as a CDN edge, on a path that does not drop bad
checksums. The server takes it into the stream and the handshake fails (a
handshake_failure alert from the server, or a bad record MAC on the client).
Seen on CI's Windows runners; a user close to a CDN can hit the same.

- Both backends watch for that on flows whose ClientHello carried a decoy in
  the last 5 s, to a server desynced in that time: a plaintext TLS alert from
  the server, a plaintext alert from the client, or a TLS 1.3 encrypted alert
  (a 19-byte application_data record) from the client as the very next thing
  after its ClientHello. A close_notify at the end of a short, healthy
  connection is the same 19 bytes but sits after the Finished, so it does not
  count.
- Such a server goes into a "no decoy" table (256 addresses, 10 minutes). Its
  first segments are still cut (split or disorder; the fakedsplit modes cut
  too) but get no decoy, no fakedsplit junk and no seqovl prefix: nothing the
  server could take for data. The first attempt fails; the next one loads.
- Windows: one more narrow WinDivert clause captures inbound TCP from 443
  whose payload starts 15 03, re-injected unchanged. Linux: one more INPUT
  rule queues the same (iptables u32 match, or nft's payload match), best
  effort; without it only the client's side is watched. `raw_ready` says
  which with `"alert_watch"`.
- `raw_stats` adds `"nodecoy"` (first segments sent without a decoy because of
  the table) and `"decoy_hurt"` (times the harm was seen).
  `core/test/test_rawscope.c`, `tests/lab/advanced-lab.sh` (section 5),
  `tests/lab/advanced-windows.js`.

## Update 9: Advanced mode — a call's own datagrams stay in the kernel

Update 4 queued every outbound datagram to the voice and STUN ports (and to
UDP 443) and classified it in the packet loop. A call sends 50 datagrams a
second, each waiting its turn in a loop that also takes every outgoing web
data segment, and on Linux behind a queue that drops when it is full: a busy
moment there is a gap in the user's voice, while the loop only ever acts on
the first one or two datagrams of a flow.

- The kernel now takes only what the loop acts on: on UDP 443 a QUIC long
  header (first byte 0x80 or more); on the voice / STUN ports Discord's IP
  discovery request (UDP length 82, payload 00 01 00 46) or a STUN Binding
  request (00 01, cookie 21 12 a4 42 at offset 4). RTP, DTLS, SRTP and QUIC
  short headers never leave the kernel. The classifiers in `udpdpi.c` still
  decide; the kernel test is only a pre-filter, never stricter than them.
- Windows: single-byte `udp.Payload[i]` tests in the WinDivert filter
  (`udp_windivert_clause`). Linux: one iptables rule per kind with the u32
  match, or nft raw payload expressions; the expressions live in `udpdpi.h`
  and `core/test/test_udpdpi.c` runs the u32 ones against real datagrams (an
  evaluator of the u32 language, as the kernel runs it). A kernel that refuses
  a payload test gets the ports alone, as before. `raw_ready` says which with
  `"udp_match"`, and the app logs a line when it is 0.
- The decoys' TTL is the measured one when the address answered a TCP
  handshake lately (autottl), else the fixed one.
- `raw_stats` adds `"udp_seen"` (datagrams the loop was handed),
  `"udp_decoys"` (decoy datagrams sent) and `"quic_dropped"`.
  `tests/lab/advanced-lab.sh` (section 6: the decoys reach a server before the
  real request, 40 RTP datagrams arrive with none, and with u32 the loop is
  handed only the requests) and `tests/lab/advanced-windows.js` (a real STUN
  server still answers; RTP and short headers never reach the loop).

## Update 10: `--watch` — the app hears about a call starting

The default engine never sees a call's sound (UDP), only the voice server's
WebSocket, and a technique learnt for the site is reused without a word, so
the app had no way to know a call was starting. `--watch <domain>`
(repeatable) makes the engine print `{"type":"seen","host":...}` for a
connection to that domain or a name under it, once per name every 10 minutes,
changing nothing about the connection. The desktop app watches
`discord.media` and takes a call only from a voice server's own name (one
server in one region, `c-fra06-1a2b3c4d`), never from the names every open
client fetches there (`latency.discord.media`, which ranks the regions): on a
network known to block Discord, the autopilot then asks for Advanced mode
(`electron/autopilot.js`). `core/test/test_engine.c` (section 13),
`tests/net/engine-watch.test.js`, `tests/net/autopilot.test.js`.

## Update 4: streams that are not TLS or HTTP

Apps with a protocol of their own (Telegram's MTProto, other messengers,
games) reach the engine as SOCKS connections to an address, with a first
payload that has no name in it. Until now they were relayed untouched.

**What the engine does now.** Their first payload cannot be replayed on a
second connection (nothing says doing it twice is harmless for an unknown
protocol), so the search for a technique runs across the app's own
connections: a destination whose untouched connection is refused, or left
unanswered until the app gives up, has its next connection cut with the first
raw technique, the next with the next, and the first one answered is learned
(per address, tried first for its /24 or /48 neighbours, kept by the app
across restarts). Every raw technique only changes the segmentation, never
the bytes the server receives: `split(1)`, `disorder(1)`, cuts across the
first 64 bytes, `disorder(32)`, and on Linux a zero-filled decoy dropped by
the server itself (TCP-MD5). No urgent byte: a real Telegram server takes it
into the stream. Once every technique has failed, that is said once and the
destination rests for ten minutes: never a search forever.

| Filter (tests/net/engine-raw.test.js, telegram-real.test.js) | Result |
|---|---|
| resets MTProto by its opening in the first segment | **PASS** after one failed connection (`raw-split1`) |
| drops it silently | **PASS** once the app gives up on the first |
| reassembles the stream before matching | BLOCKED, told once, then left alone |
| blocks the address itself (no SYN-ACK) | BLOCKED, told as unreachable |

**What it cannot do.** A destination whose address is blocked outright (the
connection never opens, or is throttled to nothing by address) is beyond any
technique on this computer: there is no other path to it without a server
elsewhere. The engine says so (`unreachable`, raw, with the port the app used)
and the app names the app — by the program holding the connection on the
desktop, by the service the address belongs to on Android — in one line that
points at the app's own proxy setting or a VPN.

Reaching apps at all: on Android every app goes through the VPN. On Windows
and macOS an app that follows the system proxy reads Shroudly's PAC, which now
sends global IPv6 addresses to the engine too (IPv4 ones already went), and in
"listed" mode the address ranges of known services. On Windows, WinHTTP turned
out to read the PAC's SOCKS entries as nothing and answer "no proxy", so every
program asking it (Qt ones such as Telegram Desktop on "use system proxy",
.NET) went around Shroudly; the PAC now also offers the engine's port as an
HTTP proxy for https:// (last, so SOCKS clients are unaffected), and the
engine takes HTTP CONNECT on that port (never with --auth-file). An app that ignores the
system proxy (Telegram Desktop on Linux without libproxy, for one) never
reaches the engine; its own proxy setting can point at Shroudly's SOCKS5 port.
