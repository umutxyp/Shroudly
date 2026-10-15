#ifndef SHROUDLY_UDPDPI_H
#define SHROUDLY_UDPDPI_H

#include <stddef.h>
#include <stdint.h>

/*
 * udpdpi — payload classifiers, a bounded per-flow table and an IPv4+UDP decoy
 * builder for the Advanced-mode UDP handling (QUIC forced to TCP; decoys for
 * Discord voice). Pure, platform-independent and unit-tested (test_udpdpi.c);
 * the per-OS raw backends (raw_windows.c, raw_linux.c) do the capture/inject
 * and call in here to classify and to build the decoy bytes.
 *
 * None of this touches the network; it only reads bytes already captured and
 * writes bytes for the caller to send. Every function is total: a short or
 * malformed buffer is rejected, never read out of bounds.
 */

/* ── QUIC ─────────────────────────────────────────────────────────────────
 * True if `p` (len bytes of a UDP payload) begins a QUIC *Initial* packet: a
 * long header (most-significant bit of byte 0 set, 0x80) carrying a real QUIC
 * version — v1 (0x00000001), v2 (0x6b3343cf) or a draft (0xff0000xx). Version
 * 0x00000000 is Version Negotiation, not Initial, and is rejected, as are
 * short-header packets and any non-QUIC datagram. Needs >= 5 bytes. */
int quic_is_initial(const uint8_t *p, int len);

/* ── Discord voice / STUN ──────────────────────────────────────────────────
 * Discord's 74-byte IP-discovery request: type 0x0001, length 0x0046 (= 70),
 * total 74 bytes. Exact match only. */
int discord_is_ip_discovery(const uint8_t *p, int len);

/* An RFC 5389 STUN Binding request: message type 0x0001 at offset 0, the magic
 * cookie 0x2112A442 at offset 4, a header of at least 20 bytes and a message
 * length that is a multiple of 4 and fits the buffer. */
int stun_is_binding_request(const uint8_t *p, int len);

/* Either of the two above: the datagrams a censor can fingerprint at the start
 * of a Discord voice flow. */
int udp_is_discord_voice(const uint8_t *p, int len);

/* True if `dport_host` (host byte order) is a port Discord voice / STUN uses:
 * the media range 50000-65535, or STUN on 3478 or 19302-19309. */
int discord_voice_port(uint16_t dport_host);

/* ── Per-flow table (bounded, expiring) ────────────────────────────────────
 * Lets the backend fire decoys for only the FIRST few datagrams of each voice
 * flow and then stay out of the way. Keyed by the 5-tuple (proto is always
 * UDP, so only the four address/port fields are kept, in network byte order).
 */
#define UDP_FLOW_MAX        256    /* hard cap on tracked flows */
#define UDP_FLOW_EXPIRE_MS  10000  /* a flow older than this is forgotten */
#define UDP_FLOW_FIRST_N    2      /* decoys only for the first N datagrams */

typedef struct {
  int      used;
  uint32_t saddr, daddr;   /* network byte order */
  uint16_t sport, dport;   /* network byte order */
  uint32_t ts;             /* ms clock when the flow was first seen */
  int      count;          /* datagrams noted for this flow so far */
} udp_flow_entry;

typedef struct {
  udp_flow_entry e[UDP_FLOW_MAX];
} udp_flow_table;

void udp_flow_init(udp_flow_table *t);

/* Note one datagram of a flow and say whether it should trigger decoys: 1 for
 * the first UDP_FLOW_FIRST_N datagrams seen within UDP_FLOW_EXPIRE_MS of the
 * flow's first, 0 afterwards. now_ms is any monotonic millisecond clock. A flow
 * whose slot has expired starts over; a full table evicts its oldest slot. */
int udp_flow_note(udp_flow_table *t, uint32_t saddr, uint16_t sport,
                  uint32_t daddr, uint16_t dport, uint32_t now_ms);

/* ── Decoy datagram builder ────────────────────────────────────────────────
 * Build a complete IPv4 + UDP datagram into `buf` (capacity `cap`): same
 * 5-tuple as the real one (addresses/ports in network byte order, copied
 * verbatim), `payload_len` bytes of deterministic pseudo-random noise seeded
 * by `rng_seed`, TTL set to `ttl` so it dies before the server. The IPv4 header
 * checksum and the UDP checksum are both computed correctly (valid), so a
 * checksum-validating middlebox still ingests the decoy; the low TTL alone,
 * not a corrupted checksum, is what stops it short of the server (the payload
 * is harmless noise if it ever arrived). Returns the total datagram length, or
 * 0 if the arguments do not fit. */
int udp_build_decoy(uint8_t *buf, int cap, uint32_t saddr, uint32_t daddr,
                    uint16_t sport, uint16_t dport, int payload_len,
                    int ttl, uint16_t ip_id, uint32_t rng_seed);

#endif
