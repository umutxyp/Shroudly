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

## Update 2: Advanced backends for all three OSes

The advanced (packet-layer) backend now exists on every platform:

| OS      | Backend                         | File              | Privilege        |
|---------|---------------------------------|-------------------|------------------|
| Linux   | NFQUEUE + raw socket            | raw_linux.c       | CAP_NET_ADMIN/RAW|
| Windows | WinDivert 2.2 (signed driver)   | raw_windows.c     | Administrator    |
| macOS   | pf divert socket + raw socket   | raw_macos.c       | root (no kext)   |

All three: intercept the first TLS/HTTP data packet, inject a low-TTL +
bad-checksum FAKE copy with XOR-scrambled SNI (reaches the DPI, dies before the
server), then let the real packet proceed. This defeats stateful DPI.

Build: `npm run build:core:advanced` (native) or `:all` (cross via zig).
Windows advanced packaging also needs `npm run fetch:windivert` (downloads +
SHA-256-verifies the official signed driver; not committed to the repo).

Graceful degradation is verified: if the driver/privilege is missing the backend
prints an error and exits cleanly, and the app keeps using the default engine.
The manager always reverts its firewall rule (iptables/pf) on stop/crash/exit.
