#ifndef SHROUDLY_RAW_LINUX_H
#define SHROUDLY_RAW_LINUX_H

/* Advanced packet-layer desync backend (Linux, SHROUDLY_RAW only).
 * Defeats stateful DPI (Iran/China) via low-TTL/bad-checksum fake packets.
 * Needs CAP_NET_ADMIN + CAP_NET_RAW and an nftables/iptables NFQUEUE rule that
 * the manager installs and removes around activation. */
int  raw_linux_start(int queue_num, int fake_ttl); /* blocks until stop */
void raw_linux_stop(void);

#endif
