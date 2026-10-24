#ifndef SHROUDLY_TCPDPI_H
#define SHROUDLY_TCPDPI_H

#include <stddef.h>
#include <stdint.h>

/*
 * tcpdpi — packet-layer DPI-evasion helpers shared by the Advanced-mode raw
 * backends (raw_windows.c, raw_linux.c) and verified directly by the unit tests
 * (core/test/test_tcpdpi.c). Everything here is pure and platform-independent:
 * it reads and writes plain byte buffers holding IPv4/IPv6 + TCP headers,
 * computes the Internet checksums itself, and keeps one small bounded table of
 * measured hop counts. No sockets, no privileges, no OS packet API — so the
 * exact code the backends run at the packet layer is what the tests exercise,
 * on every platform the engine builds for.
 *
 * These are the techniques GoodbyeDPI and zapret use and that users on Türk
 * Telekom, Turkcell and Superonline rely on, wired conservatively: the decoys
 * built here always carry a deliberately bad TCP checksum (and a low TTL), so
 * even if a TTL estimate is wrong the server's stack drops the junk — the real
 * payload is only ever carried by the real, good-checksum segments.
 */

/* ───────── injected-RST classifier (GoodbyeDPI -p, "passive DPI") ─────────
 * Censors such as Türk Telekom and Turkcell inject a forged TCP RST to tear
 * down a blocked TLS/HTTP connection. A forged RST is recognised, kept as
 * narrow as the reference tools keep it, by ALL of:
 *   - the TCP RST flag is set (covers RST and RST+ACK),
 *   - the segment carries no TCP payload,
 *   - the source port is 80 or 443 (a monitored flow),
 *   - IPv4: the IP ID is in [0, TCPDPI_INJ_RST_IPID_MAX] — the small range the
 *           reference tools key on. A real server's reset normally carries a
 *           per-connection ID well above this window, BUT there is one genuine
 *           exception: Linux sends its socket-less resets (connection-refused
 *           to a closed port, resets of a flow whose socket is already gone)
 *           with DF set, and ip_select_ident_segs() then writes IP ID 0. So the
 *           exact fingerprint "DF set AND IP ID 0" is treated as a real reset
 *           and KEPT — otherwise a connect() to a closed 80/443 port would hang
 *           on its own timeout instead of failing fast. The trade-off is one
 *           false negative (a forged RST that also sets DF with IP ID 0 is let
 *           through); it fails safe, a dropped connection, never a swallowed one.
 *   - IPv6: the flow label is zero. (This v6 path is wired on Windows, where
 *           WinDivert queues both families; the Linux NFQUEUE backend queues
 *           IPv4 only, as GoodbyeDPI's passive RST drop also does.)
 * The caller only ever consults this for inbound segments whose source port is
 * 80 or 443, and drops a match only when its source is a server the engine
 * recently desynced (rawscope_touched in rawscope.h): a reset from any other
 * host passes. The constant is the exact rule, documented in one place. */
#define TCPDPI_INJ_RST_IPID_MAX 0x0F

/* pkt/len is one complete inbound IPv4 (…_rst4) or IPv6 (…_rst6) packet.
 * Returns 1 when it matches the injected-RST signature (the caller drops it),
 * 0 otherwise (the caller re-injects it unchanged). */
int tcpdpi_is_injected_rst4(const uint8_t *pkt, int len);
int tcpdpi_is_injected_rst6(const uint8_t *pkt, int len);

/* ───────── measured decoy TTL (GoodbyeDPI/zapret autottl) ─────────
 * Hop distance to the server from an inbound SYN-ACK's TTL / hop limit. Hosts
 * start the field at one of 64, 128 or 255 and every router decrements it, so
 * the distance is the initial value minus what arrived. Returns the hop count
 * (>= 1), or 0 when the value is in none of the three recognised bands
 * (unmeasurable — the caller then keeps the fixed configured decoy TTL). */
int tcpdpi_hops_from_ttl(int ttl);

/* Decoy TTL for a path `nhops` long: nhops - margin, floored at `min_ttl` (and
 * never below 1), so the decoy dies one or more hops before the server. */
int tcpdpi_decoy_ttl(int nhops, int margin, int min_ttl);

/* Bounded, self-expiring per-destination table of measured hop counts, keyed by
 * the server's IPv4 address (network byte order). Written when its SYN-ACK is
 * seen, read when its ClientHello is about to be faked. Used only from the
 * backend's single packet-loop thread, so no locking. */
#define TCPDPI_HOPS_CAP     512    /* at most this many destinations remembered */
#define TCPDPI_HOPS_TTL_MS  120000 /* an entry older than this is ignored/reused */
void tcpdpi_hops_reset(void);
void tcpdpi_hops_put(uint32_t ip_be, int hops, uint64_t now_ms);
int  tcpdpi_hops_get(uint32_t ip_be, uint64_t now_ms); /* 0 if absent/expired */

/* ───────── raw IPv4 TCP segment builders ─────────
 * Each writes one complete IPv4 + TCP segment into dst (capacity dstcap) from a
 * header template (the captured packet's IP and TCP headers) plus new fields,
 * and fills in the IPv4 total length, the IP ID, the IPv4 header checksum and
 * the TCP checksum. With bad_tcp_csum != 0 the TCP checksum is deliberately
 * inverted so the destination drops the segment (a decoy the DPI still ingests
 * but the server never accepts). ihl and tcphl are the header lengths in bytes.
 * Return the segment length, or 0 on any error (bad lengths, capacity) — never
 * a partially written buffer. */

/* A copy of the headers carrying payload[0,seg_len) at sequence `seq` with IP
 * TTL `ttl` and IP id `ip_id`. Used for the real split parts and the fakes. */
int tcpdpi_build_segment4(uint8_t *dst, size_t dstcap,
                          const uint8_t *ip_tmpl, int ihl,
                          const uint8_t *tcp_tmpl, int tcphl,
                          uint16_t ip_id, uint32_t seq, int ttl,
                          const uint8_t *payload, int seg_len,
                          int bad_tcp_csum);

/* seqovl (zapret split-seqovl): the real first segment, but its sequence number
 * moved back by `overlap` and `overlap` `pattern` bytes prepended to the
 * payload. The server discards the out-of-window prefix and keeps
 * real[0,real_len); the DPI reads the pattern bytes first. Good checksum,
 * normal TTL. `overlap` must be in [1, seq] and the result must fit dstcap. */
int tcpdpi_build_seqovl4(uint8_t *dst, size_t dstcap,
                         const uint8_t *ip_tmpl, int ihl,
                         const uint8_t *tcp_tmpl, int tcphl,
                         uint16_t ip_id, uint32_t seq, int ttl,
                         const uint8_t *real, int real_len,
                         int overlap, uint8_t pattern);

/* fakedsplit / fakeddisorder: the real payload split at `split_pos` into two
 * real segments, with one low-TTL junk fake at the split boundary mixed in.
 *   disorder == 0 (fakedsplit)   : real[0,split) , fake@split , real[split,n)
 *   disorder != 0 (fakeddisorder): real[split,n), fake@0     , real[0,split)
 * The real segments carry `ttl` and a good checksum; the one fake carries
 * `fake_ttl`, `pattern` junk and a bad TCP checksum, so it can never be
 * accepted by the server however the TTL lands. Fills segs[0..2] and *nsegs
 * (always 3), each a complete IPv4+TCP segment. Returns 1, or 0 on error. */
typedef struct {
  uint8_t data[2048];
  int     len;
  int     is_fake; /* 1 for the low-TTL junk segment */
} tcpdpi_seg;

int tcpdpi_build_fakedsplit4(tcpdpi_seg segs[3], int *nsegs,
                             const uint8_t *ip_tmpl, int ihl,
                             const uint8_t *tcp_tmpl, int tcphl,
                             uint16_t ip_id, uint32_t seq, int ttl,
                             const uint8_t *real, int real_len,
                             int split_pos, int fake_ttl, uint8_t pattern,
                             int disorder);

/* ───────── cutting the real first segment (zapret multisplit / multidisorder) ─────────
 * The plain decoy goes first and the real ClientHello after it. Sent whole, a
 * filter the decoy does not fool reads the whole name in one segment; programs
 * that ignore the proxy (and so get none of its techniques) stay blocked that
 * way. Cut, no segment carries the name a filter matches on.
 *
 * tcpdpi_split_points: where to cut a payload whose SNI / Host value is
 * payload[host_off, host_off+host_len): one byte into the name, and in the
 * middle of its second-level label ("dis|cord" in
 * remote-auth-gateway.discord.gg; the middle of the whole name when there is
 * no such label). Fills cuts[] ascending and distinct, each in (0, plen), and
 * returns how many (0 when there is no usable name: the caller sends the
 * payload whole). */
int tcpdpi_split_points(const uint8_t *payload, int plen, int host_off, int host_len, int cuts[2]);

/* The real payload as ncuts+1 real segments cut at cuts[0..ncuts) (ascending,
 * in (0, real_len)), each with `ttl` and a good checksum and the sequence
 * number of its first byte. reverse == 0: in order; reverse != 0: last first
 * (the receiver puts them back in order; a filter that does not, never sees the
 * name). Fills segs[] and *nsegs in the order to send. Returns 1, or 0 on any
 * error (the caller sends the payload whole). */
int tcpdpi_build_multisplit4(tcpdpi_seg segs[3], int *nsegs,
                             const uint8_t *ip_tmpl, int ihl,
                             const uint8_t *tcp_tmpl, int tcphl,
                             uint16_t ip_id, uint32_t seq, int ttl,
                             const uint8_t *real, int real_len,
                             const int *cuts, int ncuts, int reverse);

/* ───────── splitting the TLS record itself (zapret tlsrec, GoodbyeDPI -r) ─────────
 * The cut above is a TCP one: it puts the name across two TCP segments. A DPI
 * that reassembles the TCP stream before it looks (as some do, Türkiye's
 * Superonline among them, issue #48) reads the whole name back out of the
 * segments and blocks it anyway. The proxy gets past such a filter by splitting
 * the TLS record, not the TCP stream: the ClientHello becomes two TLS records,
 * each a valid record of its own, with the name across the boundary. Rebuilt
 * from the stream, the handshake is identical; but a filter that matches the
 * name inside one record never sees it whole. This is the single technique the
 * engine's proxy tries first (tlsrec-sni-mid), done here at the packet layer so
 * every program gets it, proxy-aware or not.
 *
 * `real` is the outbound first-payload TCP segment, which must begin with a
 * complete TLS record (real[0]==0x16, and 5 + record-length <= real_len).
 * `cut` is a byte offset into `real` (as tcpdpi_split_points returns), which
 * must fall strictly inside that record's body (5 < cut < 5 + record_len). The
 * record is split there into two records; any bytes of `real` after the first
 * record are kept, unchanged, after the second. One TCP segment is written to
 * dst at `seq`, good checksum, TTL `ttl`. It is five bytes longer than `real`
 * (the second record's own 5-byte header), so the sender's later bytes on this
 * connection sit five behind what the server now expects: the caller shifts
 * them with the sequence-translation table below. Returns the segment length,
 * or 0 on any error (the caller then sends `real` unchanged). */
int tcpdpi_build_tlsrec4(uint8_t *dst, size_t dstcap,
                         const uint8_t *ip_tmpl, int ihl,
                         const uint8_t *tcp_tmpl, int tcphl,
                         uint16_t ip_id, uint32_t seq, int ttl,
                         const uint8_t *real, int real_len, int cut);

/* The same split, emitted as two TCP segments cut at the record boundary:
 * record 1 at `seq`, then record 2 (and any trailing bytes) at seq + its length.
 * Each segment is no larger than `real`, so growing the stream by five bytes can
 * never push a segment past the path MTU (one combined segment could), and the
 * two records travel in separate segments. Fills segs[0..1] and *nsegs (2).
 * Returns 1, or 0 on any error (the caller then sends `real` unchanged). The
 * connection still grows by TCPDPI_TLSREC_GROWTH overall, tracked as below. */
int tcpdpi_build_tlsrec_pair(tcpdpi_seg segs[2], int *nsegs,
                             const uint8_t *ip_tmpl, int ihl,
                             const uint8_t *tcp_tmpl, int tcphl,
                             uint16_t ip_id, uint32_t seq, int ttl,
                             const uint8_t *real, int real_len, int cut);

/* The extra bytes tcpdpi_build_tlsrec4 adds (one TLS record header). */
#define TCPDPI_TLSREC_GROWTH 5

/* Recompute the IPv4 and TCP checksums of a complete IPv4+TCP segment in place
 * (good checksums), after its sequence or acknowledgement number was changed by
 * the sequence translation below. `len` is the whole packet, `ihl` the IPv4
 * header length in bytes. */
void tcpdpi_refresh_csum4(uint8_t *pkt, int len, int ihl);

/* ───────── sequence-number translation for a grown connection ─────────
 * Splitting the TLS record adds TCPDPI_TLSREC_GROWTH bytes to the one segment,
 * so from that point every byte the client sends is five earlier in the stream
 * than the byte the server now acknowledges. For the rest of the connection the
 * backend must add the growth to the sequence number of each later outbound
 * segment, and take it back off the acknowledgement number of each inbound one,
 * so both stacks stay in step. This small table remembers, per connection (its
 * four-tuple, addresses and ports in network byte order), the growth and the
 * sequence at which it began.
 *
 * It is written and read only from the backend's single packet-loop thread, so
 * no locking. Entries live until the connection's FIN or RST is seen (the
 * backend calls _end then) or, as a backstop for a connection whose close is
 * never seen, until TCPDPI_XLATE_TTL_MS of silence. The table is sized for many
 * concurrent long-lived connections (a Discord gateway socket lasts hours);
 * when it is nonetheless full of live entries, _begin returns 0 and the caller
 * does not split that connection's record rather than ever corrupt another. */
#define TCPDPI_XLATE_CAP     4096
#define TCPDPI_XLATE_TTL_MS  (6 * 3600 * 1000) /* a long-lived socket, untouched */

void tcpdpi_xlate_reset(void);

/* A connection grew by `growth` bytes at outbound sequence `at_seq`. Returns 1
 * if remembered (the caller may send the grown segment), 0 if the table is full
 * of live connections (the caller must not grow this one). Refreshing an
 * existing four-tuple always succeeds. */
int  tcpdpi_xlate_begin(uint32_t saddr, uint32_t daddr, uint16_t sport, uint16_t dport,
                        uint32_t at_seq, int growth, uint64_t now_ms);

/* Adjust an outbound segment's sequence `*seq` for its connection: += growth
 * when the segment is at or after where the growth began. Returns 1 if changed.
 * A matching entry's age is refreshed. */
int  tcpdpi_xlate_out(uint32_t saddr, uint32_t daddr, uint16_t sport, uint16_t dport,
                      uint32_t *seq, uint64_t now_ms);

/* Adjust an inbound segment's acknowledgement `*ack` for its connection: -=
 * growth when the server is acknowledging bytes past where the growth began.
 * The four-tuple is the inbound one (server -> client); it is matched against
 * the stored outbound tuple reversed. Returns 1 if changed. */
int  tcpdpi_xlate_in(uint32_t saddr, uint32_t daddr, uint16_t sport, uint16_t dport,
                     uint32_t *ack, uint64_t now_ms);

/* Forget a connection (its FIN or RST was seen), by its outbound four-tuple. */
void tcpdpi_xlate_end(uint32_t saddr, uint32_t daddr, uint16_t sport, uint16_t dport);

/* How many connections are currently remembered (for the raw_stats line). */
int  tcpdpi_xlate_live(uint64_t now_ms);

#endif
