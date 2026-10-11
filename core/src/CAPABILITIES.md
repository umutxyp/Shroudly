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
