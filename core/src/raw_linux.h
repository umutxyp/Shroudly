#ifndef SHROUDLY_RAW_LINUX_H
#define SHROUDLY_RAW_LINUX_H

/* Advanced packet-layer desync backend (Linux, SHROUDLY_RAW only).
 * Defeats stateful DPI (Iran/China) via low-TTL/bad-checksum fake packets.
 * Needs CAP_NET_ADMIN + CAP_NET_RAW. Installs its own NFQUEUE rule (iptables,
 * else nftables) and removes it in raw_linux_teardown(). */
#define SHROUDLY_FWMARK 0x10000000 /* set on injected fakes; the rule skips it */

/* quic_block: drop QUIC Initial (UDP/443) so browsers fall back to TCP.
 * udp_fake:   inject decoys ahead of the first Discord voice datagrams.
 * fake_repeats: how many decoy datagrams per voice flow (defaults if <= 0). */
int  raw_linux_start(int queue_num, int fake_ttl, int quic_block, int udp_fake, int fake_repeats); /* blocks until stop */
void raw_linux_stop(void);
void raw_linux_teardown(void); /* remove the firewall rules; idempotent */

#endif
