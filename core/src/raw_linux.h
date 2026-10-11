#ifndef SHROUDLY_RAW_LINUX_H
#define SHROUDLY_RAW_LINUX_H

/* Advanced packet-layer desync backend (Linux, SHROUDLY_RAW only).
 * Defeats stateful DPI (Iran/China) via low-TTL/bad-checksum fake packets.
 * Needs CAP_NET_ADMIN + CAP_NET_RAW. Installs its own NFQUEUE rule (iptables,
 * else nftables) and removes it in raw_linux_teardown(). */
#define SHROUDLY_FWMARK 0x10000000 /* set on injected fakes; the rule skips it */

int  raw_linux_start(int queue_num, int fake_ttl); /* blocks until stop */
void raw_linux_stop(void);
void raw_linux_teardown(void); /* remove the firewall rule; idempotent */

#endif
