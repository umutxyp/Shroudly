#ifndef SHROUDLY_NFQ_H
#define SHROUDLY_NFQ_H

/*
 * nfq — the kernel's packet queue (NFQUEUE), spoken directly over netlink.
 *
 * Linux Advanced mode reads the packets an iptables / nft rule puts in a
 * queue and tells the kernel what to do with each (raw_linux.c). This is
 * the little of the nfnetlink_queue protocol that takes: bind one queue,
 * have whole packets copied, read them, give each a verdict. Only the
 * kernel's own headers are used, so the engine needs no library on the
 * user's system (libnetfilter_queue was one, missing on many: Arch, CachyOS
 * and most minimal installs do not have it).
 *
 * nfq_parse is pure (a buffer in, packets out) and unit-tested in
 * core/test/test_nfq.c; the rest is a socket.
 */

#include <stddef.h>
#include <stdint.h>

/* One queued packet: the kernel's id for it, its mark, and the packet
 * itself from its IP header on. */
typedef struct {
  uint32_t id;
  uint32_t mark;
  uint8_t *payload;   /* inside the buffer given to nfq_parse */
  int len;
} nfq_packet;

/* The packets in len bytes of what the socket read, to cb in order (cb's
 * return is not looked at). Messages that are not packets (an ack, an
 * error) are skipped. How many packets there were; -1 if the buffer is not
 * netlink at all. */
int nfq_parse(uint8_t *buf, size_t len, void (*cb)(const nfq_packet *, void *), void *ud);

/* A netlink socket bound to queue, copying up to copy_range bytes of each
 * packet. Its descriptor, or -1 with errno set (EPERM without
 * CAP_NET_ADMIN, EBUSY when another program holds the queue). */
int  nfq_open_queue(uint16_t queue, uint32_t copy_range);
/* The verdict for packet id: NF_ACCEPT (1) or NF_DROP (0). 0, or -1. */
int  nfq_verdict(int fd, uint16_t queue, uint32_t id, uint32_t verdict);
/* The same, but the kernel puts the packet back changed: `payload`/`plen`
 * (the IP packet from its header on) replaces what was queued. Used to shift a
 * segment's sequence or acknowledgement number for a connection whose TLS
 * record was split (tcpdpi_xlate_*). 0, or -1. */
int  nfq_verdict_mangle(int fd, uint16_t queue, uint32_t id, uint32_t verdict,
                        const uint8_t *payload, int plen);
/* Unbind and close. */
void nfq_close_queue(int fd, uint16_t queue);

/* The bytes of a message that binds queue (cmd 1) or unbinds it (cmd 2),
 * a config message, a verdict: what the socket sends, for the tests. Its
 * length, or -1 when cap is too small. */
int nfq_build_cmd(uint8_t *out, size_t cap, uint16_t queue, uint8_t cmd, uint32_t seq);
int nfq_build_mode(uint8_t *out, size_t cap, uint16_t queue, uint32_t copy_range, uint32_t seq);
int nfq_build_verdict(uint8_t *out, size_t cap, uint16_t queue, uint32_t id, uint32_t verdict);
/* A verdict that also carries the replacement packet (NFQA_PAYLOAD). Its
 * length, or -1 when cap is too small. */
int nfq_build_verdict_mangle(uint8_t *out, size_t cap, uint16_t queue, uint32_t id,
                             uint32_t verdict, const uint8_t *payload, int plen);

#endif
