# shroudly-core tests

- `test_proto.c`   — TLS ClientHello / HTTP parsing (unit)
- `test_desync.c`  — desync byte-integrity + segmentation over a loopback socket
- `test_bogon.c`   — anti-poisoning DNS: rejects spoofed/bogon answers, and takes the
  system resolver's private answer only for a local name, never for a public one
  (white-box, against a stand-in forwarder and system resolver)
- `test_engine.c`  — the engine's per-host memory (white-box): which names make one
  site, what a name takes from its site, where a silent ladder resumes (its own name
  only), when a learned technique is due to be checked again, where a cut moves a
  host on to, how long a host that came to nothing keeps fewer connections open, and
  the cap on re-dialled connections across all ladders; the UDP relay's refused
  destinations and the client endpoint a request names; the --auth-file and the
  constant-time comparison; which plain DNS may go to the forwarder (standard
  queries, EDNS, LAN resolvers); the --fake-net ranges
- `test_rawscope.c` — what Advanced mode may touch: the local / private / special
  address ranges (IPv4 and IPv6, every edge), the table of recently desynced servers
  a reset must come from to be dropped, the no-decoy table, the TLS record classifier
  (plaintext alert / 19-byte encrypted alert / other) and the signs that a decoy broke
  a handshake (a late close_notify does not count), and the raw_stats line
- `test_socksudp.c` — the SOCKS5 UDP header (RFC 1928 §7): parsing IPv4 / IPv6 / name
  destinations, refusing fragments and malformed headers, building reply headers, plus a
  random / mutation pass run under ASan by `make test-asan`
- `test_embedded.c` — the engine run inside another program's process, as the Android
  app runs it (`engine_main` with `embedded`, main.c built with `SHROUDLY_NO_MAIN`):
  commands and JSON lines over pipes, no signal handlers, the run returns on STOP or
  at the end of its commands and frees its port, a second run in the same process on
  the same port with none of the first one's options left, refused options
  (POSIX only)
- `fuzz_proto.c`   — random fuzzing of the untrusted-input parser
- `fuzz_mut.c`     — grammar-aware mutation fuzzing (2M iters, ASan+UBSan clean)

Run: `make test`, `make test-asan`, `make fuzz` (from core/).

## Network DPI simulators (Python, need root + scapy for the scapy ones)

- `dpi_inline.py <stateless|stateful|silent> <listen> <target>` — deterministic in-path
  DPI middlebox that DROPS blocked SNIs. Used to prove bypass without timing
  races. Results:
    stateless: direct=BLOCKED, split/disorder=PASS
    stateful : direct=BLOCKED, split/disorder=BLOCKED  (expected; see CAPABILITIES.md)
    silent   : as stateful, but the blocked connection is swallowed rather than
               closed (no reset, no reply). tests/net/engine-silent.test.js
               runs the same filter in-process for the automated check.
- `tls_server.py <port>` — minimal TLS server target.
- `dpi_sim.py <port>` — async RST-injection sniffer (illustrative; loopback RST
  timing is unreliable, prefer dpi_inline.py for assertions).
