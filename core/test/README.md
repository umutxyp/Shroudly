# shroudly-core tests

- `test_proto.c`   — TLS ClientHello / HTTP parsing (unit)
- `test_desync.c`  — desync byte-integrity + segmentation over a loopback socket
- `test_bogon.c`   — anti-poisoning DNS: rejects spoofed/bogon answers (white-box)
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
