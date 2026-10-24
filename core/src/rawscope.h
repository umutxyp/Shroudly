#ifndef SHROUDLY_RAWSCOPE_H
#define SHROUDLY_RAWSCOPE_H

#include <stddef.h>
#include <stdint.h>

/*
 * rawscope — what the Advanced-mode packet engine may touch. Shared by both
 * raw backends (raw_windows.c, raw_linux.c) and tested directly
 * (core/test/test_rawscope.c). Pure: no sockets, no OS packet API.
 *
 * The engine sends decoys, cuts segments, drops QUIC Initials and drops
 * resets. All of that is meant for servers out on the internet. On a shared
 * network (an internet cafe, an office, a dorm) the same tricks aimed at the
 * router or at other machines on the LAN could upset them, so:
 *   - traffic to a local / private / special destination is never changed:
 *     no TCP decoy, cut, seqovl or fakedsplit, no UDP decoys, no QUIC drop;
 *   - an inbound reset is only ever dropped when it comes from a remote
 *     address this engine itself desynced a short while ago. A reset from any
 *     other host passes, whatever it looks like.
 */

/* 1 when the destination must be left alone, 0 when it is a normal internet
 * address. a4 is the 4 address bytes as on the wire, a6 the 16 bytes.
 * IPv4: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16, 172.16/12,
 *       192.168/16, 224/4 (multicast) and 240/4 (reserved + broadcast).
 * IPv6: :: and ::1, fc00::/7 (unique local), fe80::/10 (link-local),
 *       ff00::/8 (multicast), and an IPv4-mapped ::ffff:a.b.c.d by its IPv4
 *       rule. The documentation ranges (192.0.2/24, 198.51.100/24,
 *       203.0.113/24, 2001:db8::/32) are not in the list. */
int rawscope_local4(const uint8_t a4[4]);
int rawscope_local6(const uint8_t a6[16]);

/* ── recently desynced destinations ──────────────────────────────────────
 * A small fixed table of the remote addresses the engine sent decoys or cut
 * segments to, each with the time it last did. A reset is only a candidate
 * for dropping when its source is in here and not older than
 * RAWSCOPE_TOUCH_TTL_MS. A full table reuses its oldest entry. Each backend
 * reads and writes it from its single packet-loop thread only, so it has no
 * lock (the same as the hop-count table in tcpdpi.c). */
#define RAWSCOPE_TOUCH_CAP    256
#define RAWSCOPE_TOUCH_TTL_MS 180000 /* 3 minutes */

void rawscope_touch_reset(void);
/* alen is 4 (IPv4) or 16 (IPv6); anything else is ignored / never touched. */
void rawscope_touch(const uint8_t *addr, int alen, uint64_t now_ms);
int  rawscope_touched(const uint8_t *addr, int alen, uint64_t now_ms);
/* 1 when the address was desynced no more than `ms` ago (and is still in the
 * table), 0 otherwise. */
int  rawscope_touched_within(const uint8_t *addr, int alen, uint64_t now_ms, uint64_t ms);

/* ── servers the decoy hurts ─────────────────────────────────────────────
 * The decoy is a copy of the first segment with the name scrambled, a bad
 * TCP checksum and a TTL that should run out before the server. A server only
 * a few hops away, on a path that does not drop bad checksums, can still get
 * it, take it into the stream and fail the handshake. When that is seen, the
 * server goes into a second table, "no decoy", for RAWSCOPE_NODECOY_TTL_MS:
 * its first segments are still cut (a cut never reaches the server as
 * garbage), but get no decoy, no fakedsplit junk and no seqovl prefix.
 *
 * What counts as "the decoy hurt", on a flow whose first segment carried a
 * decoy less than RAWSCOPE_HURT_WINDOW_MS ago, to a server desynced within
 * that time:
 *   - the server sends a plaintext TLS alert (only possible before the
 *     handshake keys exist);
 *   - the client sends a plaintext TLS alert;
 *   - the client sends a TLS 1.3 encrypted alert (an application_data record
 *     of exactly 19 bytes) as the very next thing after its ClientHello (an
 *     optional 6-byte ChangeCipherSpec in between). The position matters: a
 *     close_notify at the end of a short, healthy connection is the same 19
 *     bytes, but comes after the client's Finished and its requests.
 * Same threading as the touched table: one packet thread, no lock. */
#define RAWSCOPE_NODECOY_CAP     256
#define RAWSCOPE_NODECOY_TTL_MS  600000 /* 10 minutes */
#define RAWSCOPE_FLOW_CAP        256
#define RAWSCOPE_HURT_WINDOW_MS  5000

void rawscope_nodecoy_reset(void);   /* also forgets the decoy flows */
void rawscope_nodecoy_add(const uint8_t *addr, int alen, uint64_t now_ms);
int  rawscope_nodecoy(const uint8_t *addr, int alen, uint64_t now_ms);

/* What the start of a TCP payload is, as far as this goes. A leading complete
 * ChangeCipherSpec record (14 03 0X 00 01 01) is skipped first. The record
 * must be whole in the buffer:
 *   RAWSCOPE_TLS_ALERT      15 03 0X (X <= 4), length 2: a plaintext alert;
 *   RAWSCOPE_TLS_ENC_ALERT  17 03 03, length 19: a TLS 1.3 encrypted alert
 *                           (2-byte alert + content type + 16-byte tag);
 *   RAWSCOPE_TLS_OTHER      anything else (a Finished is 53 bytes or more). */
enum { RAWSCOPE_TLS_OTHER = 0, RAWSCOPE_TLS_ALERT = 1, RAWSCOPE_TLS_ENC_ALERT = 2 };
int rawscope_tls_kind(const uint8_t *p, int len);
/* Bytes of the classified record's start past the payload start: 6 when a
 * ChangeCipherSpec was skipped, else 0. */
int rawscope_tls_skip(const uint8_t *p, int len);

/* The sequence number right after a first segment's TLS record: seq + 5 +
 * the record length when the payload starts with a handshake record header
 * (the ClientHello may go on in later segments), else seq + plen. */
uint32_t rawscope_tls_next_seq(uint32_t seq, const uint8_t *p, int plen);

/* A first segment on this flow carried a decoy. raddr/rport are the server,
 * lport the client's port, next_seq from rawscope_tls_next_seq. */
void rawscope_decoy_sent(const uint8_t *raddr, int alen, uint16_t rport, uint16_t lport,
                         uint32_t next_seq, uint64_t now_ms);
/* Look at a client -> server payload (seq: its TCP sequence number) or a
 * server -> client payload on a flow. Returns 1 when it shows the decoy hurt:
 * the server is then in the no-decoy table, RAWSCOPE_DECOY_HURT is counted
 * and the flow is forgotten (one count per flow). 0 otherwise. */
int rawscope_decoy_hurt_out(const uint8_t *raddr, int alen, uint16_t rport, uint16_t lport,
                            uint32_t seq, const uint8_t *p, int plen, uint64_t now_ms);
int rawscope_decoy_hurt_in(const uint8_t *raddr, int alen, uint16_t rport, uint16_t lport,
                           const uint8_t *p, int plen, uint64_t now_ms);

/* ── counters ────────────────────────────────────────────────────────────
 * Bumped by the packet thread, read by whoever reports them (the supervise
 * thread at stop), so they are atomic. */
enum {
  RAWSCOPE_DESYNCED = 0, /* first segments to a remote server that got the decoy / cut */
  RAWSCOPE_SKIPPED,      /* packets the engine would have changed, left alone: local destination */
  RAWSCOPE_RST_DROPPED,  /* injected-looking resets dropped (from a desynced server) */
  RAWSCOPE_RST_PASSED,   /* injected-looking resets let through (from anywhere else) */
  RAWSCOPE_NODECOY,      /* first segments cut but sent without a decoy (no-decoy table) */
  RAWSCOPE_DECOY_HURT,   /* times a decoy was seen to break a handshake */
  RAWSCOPE_UDP_SEEN,     /* UDP datagrams the packet loop was handed (the kernel
                          * pre-filter keeps a call's own datagrams out) */
  RAWSCOPE_UDP_DECOYS,   /* decoy datagrams sent ahead of voice / STUN requests */
  RAWSCOPE_QUIC_DROPPED, /* QUIC Initials dropped so the browser takes TCP */
  RAWSCOPE_DNS_ANSWERED, /* other programs' DNS questions answered from encrypted DNS (dnsgate.h) */
  RAWSCOPE_DNS_PASSED,   /* ... and sent on to their own server unchanged */
  RAWSCOPE_GROWN,        /* ClientHellos whose TLS record was split (tlsrec, #48) */
  RAWSCOPE_NCOUNTERS
};
void          rawscope_count(int which);
unsigned long rawscope_counter(int which);
void          rawscope_counters_reset(void);

/* The counters as one status line, without a newline:
 *   {"type":"raw_stats","desynced":N,"skipped":N,"rst_dropped":N,"rst_passed":N,
 *    "nodecoy":N,"decoy_hurt":N,"udp_seen":N,"udp_decoys":N,"quic_dropped":N,
 *    "dns_answered":N,"dns_passed":N}
 * ("desynced" counts every first segment the engine cut or decoyed, the
 * no-decoy ones included.)
 * Returns its length, or 0 when it does not fit cap. */
int  rawscope_stats_json(char *buf, size_t cap);
/* Print that line to stdout (the status file when the engine is elevated). */
void rawscope_stats_print(void);

#endif
