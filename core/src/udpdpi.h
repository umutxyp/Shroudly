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

/* ── Kernel pre-filters ────────────────────────────────────────────────────
 * The packet loop acts on three kinds of datagram only: a QUIC long header on
 * port 443 (an Initial is one), and Discord's IP discovery request or a STUN
 * Binding request on the voice / STUN ports. Everything else on those ports
 * (the call itself: RTP, DTLS, SRTP, and QUIC short headers) is better left in
 * the kernel: carried through user space, every live datagram waits its turn
 * in the loop behind whatever else it is handling, and a busy moment there is
 * a gap in the user's voice. These are the same three tests in each kernel
 * filter language, so the kernel hands over only datagrams the classifiers
 * above can say yes to. The classifiers still look at each one: the kernel
 * test is a pre-filter, never the decision. A backend whose kernel refuses a
 * payload test falls back to the ports alone (UDP_PREFILTER_PORTS).
 *
 * Discord's request is 74 bytes, so its UDP length is 82 (0x52) and its
 * payload starts 00 01 00 46; a STUN Binding request starts 00 01 and carries
 * the magic cookie 21 12 a4 42 at payload offset 4. */
#define UDP_DISCOVERY_LEN 74
#define UDP_PORTS_IPT     "3478,19302:19309,50000:65535"   /* iptables multiport */
#define UDP_PORTS_NFT     "3478, 19302-19309, 50000-65535" /* nft set */

/* iptables u32 (payload at IP header length + 8). */
#define UDP_U32_QUIC_LONG "0>>22&0x3C@8>>24&0x80=0x80"
#define UDP_U32_DISCOVERY "0>>22&0x3C@4>>16=0x52&&0>>22&0x3C@8=0x00010046"
#define UDP_U32_STUN      "0>>22&0x3C@8>>16=0x1&&0>>22&0x3C@12=0x2112A442"

/* nft raw payload (@th: the UDP header; the payload starts at bit 64). */
#define UDP_NFT_QUIC_LONG "@th,64,8 & 0x80 == 0x80"
#define UDP_NFT_DISCOVERY "udp length 82 @th,64,32 0x00010046"
#define UDP_NFT_STUN      "@th,64,16 0x0001 @th,96,32 0x2112a442"

enum { UDP_PREFILTER_PORTS = 0, UDP_PREFILTER_PAYLOAD = 1 };

/* The UDP part of a WinDivert filter for the features that are on (quic:
 * QUIC to TCP, voice: Discord voice / STUN decoys), parenthesised, without
 * "outbound and ip and udp": with `how` UDP_PREFILTER_PAYLOAD the payload
 * tests above, with UDP_PREFILTER_PORTS the destination ports alone. Writes
 * "" and returns 0 when neither feature is on; returns -1 when it does not
 * fit `cap` (buf then holds ""), else its length. */
int udp_windivert_clause(char *buf, size_t cap, int quic, int voice, int how);

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
