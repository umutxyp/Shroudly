#ifndef SHROUDLY_RAW_LINUX_H
#define SHROUDLY_RAW_LINUX_H

#include "raw_desync.h"

/* Advanced packet-layer desync backend (Linux, SHROUDLY_RAW only).
 * Defeats stateful DPI (Iran/China) via low-TTL/bad-checksum fake packets,
 * drops forged inbound RSTs and measures the decoy TTL from the SYN-ACK.
 * Needs CAP_NET_ADMIN + CAP_NET_RAW. Installs its own NFQUEUE rules (iptables,
 * else nftables) and removes them in raw_linux_teardown(). */
#define SHROUDLY_FWMARK 0x10000000 /* set on injected fakes; the rule skips it */

int  raw_linux_start(int queue_num, const raw_config *cfg); /* blocks until stop */
void raw_linux_stop(void);
void raw_linux_teardown(void); /* remove the firewall rules; idempotent */

#endif
