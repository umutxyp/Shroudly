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
 * 80 or 443. The constant is the exact rule, documented in one place. */
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

#endif
