#ifndef SHROUDLY_RAW_MACOS_H
#define SHROUDLY_RAW_MACOS_H

/* Advanced packet-layer backend (macOS, SHROUDLY_RAW only).
 * Uses pf divert sockets + raw sockets for low-TTL/bad-checksum fake packets.
 * Needs root. No kext / SIP changes. The manager installs the pf anchor that
 * diverts outbound 80/443 to SHROUDLY_DIVERT_PORT. */
#define SHROUDLY_DIVERT_PORT 10801

int  raw_macos_start(int fake_ttl); /* blocks until stop */
void raw_macos_stop(void);

#endif
