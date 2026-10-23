#ifndef SHROUDLY_DNSGATE_H
#define SHROUDLY_DNSGATE_H
/*
 * dnsgate — Advanced mode answers other programs' plain DNS with encrypted DNS.
 *
 * A program that ignores the system proxy (a Discord bot on Node, a game
 * launcher, a CLI tool) asks the network's DNS, which on a censoring network
 * forges the answer: the bot then connects to the block page and fails with
 * a certificate error, whatever the engine does to its TLS. In Advanced mode
 * the packet layer already sees every program's traffic, so it hands each
 * outbound DNS question (UDP port 53) to the gate, which asks the app's
 * encrypted-DNS forwarder (the one the engine uses) and answers the program
 * itself, as if from the server it asked.
 *
 * Only an answer the program may have as it is (doh_reply_usable): a public
 * address, or "no record of this type". Anything else (no such name, a
 * failure, a private address, no answer in time, a forwarder that is not
 * there) and the question goes on to the server it was sent to, unchanged,
 * so an intranet, a VPN's own names and a hosts-file-like local DNS keep
 * working. A name only the local network knows (doh_local_name) is not even
 * asked. A forwarder that did not answer is left alone for a while
 * (DNSGATE_REST_MS): every question goes straight on meanwhile.
 *
 * Questions for a name and type already being asked wait for the same answer
 * (a program asking again after a second, another program at once). One
 * that carries the gate's own question (the forwarder sending it on to the
 * user's own plain-DNS server) goes on unchanged: the gate never answers
 * itself.
 *
 * The packet layer gives the whole IP packet (IPv4, or IPv6 without
 * extension headers) and an opaque blob of its own (WinDivert's address, a
 * queue's ids) that comes back with every packet the gate sends.
 */

#include <stdint.h>

#define DNSGATE_META_MAX 128
#define DNSGATE_WAIT_MS  2500
#define DNSGATE_REST_MS  30000

/* Send a packet: inbound != 0 is an answer for the program (to be delivered
 * to it), 0 the program's own question going on unchanged. meta is what
 * dnsgate_take was given with the question. Called from the gate's threads. */
typedef void (*dnsgate_send_fn)(const uint8_t *pkt, int len, const void *meta, int inbound);

/* fwd_port: the forwarder on 127.0.0.1 (0: the gate is off). meta_len: the
 * size of the packet layer's blob (at most DNSGATE_META_MAX). */
int  dnsgate_start(int fwd_port, dnsgate_send_fn send_fn, int meta_len);
void dnsgate_stop(void);
int  dnsgate_on(void);

/* An outbound UDP packet to port 53. 1: the gate has it (it answers it, or
 * sends it on itself later); 0: send it on now, unchanged. */
int  dnsgate_take(const uint8_t *pkt, int len, const void *meta);

/* What the gate did, for the raw_stats line. */
unsigned long dnsgate_answered(void);
unsigned long dnsgate_passed(void);

/* ── the pure parts, for tests ──────────────────────────────────────────── */

/* The DNS message inside an outbound IPv4/IPv6 UDP packet to port 53: its
 * offset in pkt and length, or -1. */
int dnsgate_payload(const uint8_t *pkt, int len, int *dns_len);

/* A standard query with one question: its name (lower case, no final dot)
 * and type. The question section ends at *qend. 0, or -1. */
int dnsgate_question(const uint8_t *dns, int len, char *name, int cap, uint16_t *qtype, int *qend);

/* The answer packet for the question packet q: addresses and ports swapped,
 * the DNS message `dns` (its id set to the question's), lengths and
 * checksums filled in. Its length, or -1 when it does not fit cap. */
int dnsgate_reply(const uint8_t *q, int qlen, const uint8_t *dns, int dlen, uint8_t *out, int cap);

/* Fill in the IPv4 header checksum and the UDP checksum (IPv4 or IPv6) of
 * a packet: a question the kernel handed over before its UDP checksum was
 * computed (offloaded) is sent on with a right one. */
void dnsgate_checksum(uint8_t *pkt, int len);

/* The largest answer the question's sender takes over UDP: its EDNS size
 * (at most 1232, the size that crosses networks unfragmented), or 512. */
int dnsgate_udp_limit(const uint8_t *dns, int len, int qend);

#endif
