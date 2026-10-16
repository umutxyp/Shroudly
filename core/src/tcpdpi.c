/*
 * tcpdpi.c — see tcpdpi.h. Pure, platform-independent packet-layer helpers for
 * the Advanced-mode raw backends. Byte-offset based so the same code compiles
 * and is tested on Windows, Linux and macOS without any OS packet headers.
 */
#include "tcpdpi.h"
#include <string.h>

/* ── byte helpers (explicit big-endian, so the result is host-independent) ── */
static uint16_t rd16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static void     wr16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static void     wr32(uint8_t *p, uint32_t v) { p[0]=(uint8_t)(v>>24); p[1]=(uint8_t)(v>>16); p[2]=(uint8_t)(v>>8); p[3]=(uint8_t)v; }

/* TCP flag bits. */
#define TCPF_FIN 0x01
#define TCPF_SYN 0x02
#define TCPF_RST 0x04
#define TCPF_ACK 0x10

/* IPv4 flags byte (offset 6) — DF = "don't fragment". */
#define TCPDPI_IP_DF 0x40

/* ── Internet checksum, computed over explicit big-endian 16-bit words so the
 * 16-bit result is the same on any host and is stored big-endian on the wire. */
static uint32_t csum_add(const uint8_t *p, int len, uint32_t sum) {
  int i = 0;
  for (; i + 1 < len; i += 2) sum += (uint32_t)((p[i] << 8) | p[i + 1]);
  if (i < len) sum += (uint32_t)(p[i] << 8); /* final odd byte is the high half */
  return sum;
}
static uint16_t csum_fold(uint32_t sum) {
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (uint16_t)(~sum & 0xffff);
}

/* Write IPv4 header checksum and TCP checksum into a complete IPv4+TCP segment
 * buffer `pkt` of length `len`. ihl = IPv4 header length in bytes. If bad != 0
 * the TCP checksum is inverted so the destination drops the segment. */
static void fill_checksums4(uint8_t *pkt, int len, int ihl, int bad) {
  /* IPv4 header checksum. */
  pkt[10] = 0; pkt[11] = 0;
  wr16(pkt + 10, csum_fold(csum_add(pkt, ihl, 0)));

  /* TCP checksum over the pseudo-header + TCP header + payload. */
  int tcp_off = ihl;
  int tcp_len = len - ihl;
  uint32_t sum = 0;
  sum = csum_add(pkt + 12, 4, sum);         /* src addr */
  sum = csum_add(pkt + 16, 4, sum);         /* dst addr */
  sum += 6;                                 /* zero byte + protocol (TCP=6) */
  sum += (uint32_t)tcp_len;                 /* TCP length */
  pkt[tcp_off + 16] = 0; pkt[tcp_off + 17] = 0;
  uint16_t c = csum_fold(csum_add(pkt + tcp_off, tcp_len, sum));
  if (bad) c = (uint16_t)(c ^ 0xffff);      /* deliberately wrong: server drops it */
  wr16(pkt + tcp_off + 16, c);
}

/* ───────────────────────── injected-RST classifier ───────────────────────── */
int tcpdpi_is_injected_rst4(const uint8_t *pkt, int len) {
  if (!pkt || len < 20) return 0;
  if ((pkt[0] >> 4) != 4) return 0;               /* IPv4 */
  int ihl = (pkt[0] & 0x0f) * 4;
  if (ihl < 20 || len < ihl + 20) return 0;
  if (pkt[9] != 6) return 0;                       /* TCP */
  const uint8_t *tcp = pkt + ihl;
  int tcphl = ((tcp[12] >> 4) & 0x0f) * 4;
  if (tcphl < 20 || ihl + tcphl > len) return 0;
  if (!(tcp[13] & TCPF_RST)) return 0;             /* RST (or RST+ACK) */
  if (len - ihl - tcphl > 0) return 0;             /* no payload */
  int sport = rd16(tcp);
  if (sport != 80 && sport != 443) return 0;       /* monitored flow only */
  uint16_t ipid = rd16(pkt + 4);
  if (ipid > TCPDPI_INJ_RST_IPID_MAX) return 0;    /* real: per-socket ID above the window */
  /* One genuine reset also lands in the small-ID window and must be kept: Linux
   * emits its socket-less resets — connection-refused to a closed port
   * (tcp_v4_send_reset) and resets of a flow whose socket is already gone — with
   * DF set, and ip_select_ident_segs() then writes IP ID 0. That exact
   * fingerprint, DF set with IP ID 0, is a real server reset, so it is kept and
   * a connect() to a closed port still fails fast instead of hanging. (The cost
   * is one false negative: a forged RST that also sets DF with IP ID 0 is let
   * through — failing safe, a connection that drops rather than one swallowed.) */
  if (ipid == 0 && (pkt[6] & TCPDPI_IP_DF)) return 0;
  return 1;                                        /* forged: tiny IP ID */
}

int tcpdpi_is_injected_rst6(const uint8_t *pkt, int len) {
  if (!pkt || len < 40) return 0;
  if ((pkt[0] >> 4) != 6) return 0;                /* IPv6 */
  if (pkt[6] != 6) return 0;                        /* next header == TCP, no ext hdrs */
  const uint8_t *tcp = pkt + 40;
  if (len < 40 + 20) return 0;
  int tcphl = ((tcp[12] >> 4) & 0x0f) * 4;
  if (tcphl < 20 || 40 + tcphl > len) return 0;
  if (!(tcp[13] & TCPF_RST)) return 0;
  if (len - 40 - tcphl > 0) return 0;              /* no payload */
  int sport = rd16(tcp);
  if (sport != 80 && sport != 443) return 0;
  uint32_t flow = ((uint32_t)(pkt[1] & 0x0f) << 16) | ((uint32_t)pkt[2] << 8) | pkt[3];
  return flow == 0;                                 /* forged: zero flow label */
}

/* ───────────────────────── measured decoy TTL ───────────────────────── */
int tcpdpi_hops_from_ttl(int ttl) {
  if (ttl >= 35  && ttl <= 63)  return 64  - ttl;   /* initial 64  (Linux, macOS) */
  if (ttl >= 99  && ttl <= 127) return 128 - ttl;   /* initial 128 (Windows) */
  if (ttl >= 230 && ttl <= 255) return 255 - ttl;   /* initial 255 (some routers) */
  return 0;                                          /* not in any band */
}

int tcpdpi_decoy_ttl(int nhops, int margin, int min_ttl) {
  int t = nhops - margin;
  if (min_ttl < 1) min_ttl = 1;
  if (t < min_ttl) t = min_ttl;
  if (t < 1) t = 1;
  return t;
}

/* ───────────────────────── hop-count table ───────────────────────── */
typedef struct { uint32_t ip; int hops; uint64_t t; int used; } hop_ent;
static hop_ent g_hops[TCPDPI_HOPS_CAP];

void tcpdpi_hops_reset(void) { memset(g_hops, 0, sizeof(g_hops)); }

void tcpdpi_hops_put(uint32_t ip_be, int hops, uint64_t now_ms) {
  if (hops <= 0) return;
  int free_slot = -1, oldest = 0;
  for (int i = 0; i < TCPDPI_HOPS_CAP; i++) {
    if (g_hops[i].used && g_hops[i].ip == ip_be) {       /* refresh existing */
      g_hops[i].hops = hops; g_hops[i].t = now_ms; return;
    }
    if (!g_hops[i].used && free_slot < 0) free_slot = i;
    if (g_hops[i].t < g_hops[oldest].t) oldest = i;
  }
  int slot = (free_slot >= 0) ? free_slot : oldest;      /* evict oldest if full */
  g_hops[slot].ip = ip_be; g_hops[slot].hops = hops; g_hops[slot].t = now_ms; g_hops[slot].used = 1;
}

int tcpdpi_hops_get(uint32_t ip_be, uint64_t now_ms) {
  for (int i = 0; i < TCPDPI_HOPS_CAP; i++) {
    if (g_hops[i].used && g_hops[i].ip == ip_be) {
      if (now_ms - g_hops[i].t > TCPDPI_HOPS_TTL_MS) { g_hops[i].used = 0; return 0; }
      return g_hops[i].hops;
    }
  }
  return 0;
}

/* ───────────────────────── segment builders ───────────────────────── */
#define TCPDPI_SEG_MAX 1600  /* keep crafted segments within a normal MTU */

int tcpdpi_build_segment4(uint8_t *dst, size_t dstcap,
                          const uint8_t *ip_tmpl, int ihl,
                          const uint8_t *tcp_tmpl, int tcphl,
                          uint16_t ip_id, uint32_t seq, int ttl,
                          const uint8_t *payload, int seg_len,
                          int bad_tcp_csum) {
  if (ihl < 20 || tcphl < 20 || seg_len < 0) return 0;
  int total = ihl + tcphl + seg_len;
  if (total > TCPDPI_SEG_MAX || (size_t)total > dstcap) return 0;
  if ((ip_tmpl[0] >> 4) != 4) return 0;

  memcpy(dst, ip_tmpl, (size_t)ihl);
  memcpy(dst + ihl, tcp_tmpl, (size_t)tcphl);
  if (seg_len > 0) {
    if (!payload) return 0;
    memcpy(dst + ihl + tcphl, payload, (size_t)seg_len);
  }
  wr16(dst + 2, (uint16_t)total);          /* IPv4 total length */
  wr16(dst + 4, ip_id);                     /* IPv4 identification */
  dst[8] = (uint8_t)(ttl < 1 ? 1 : (ttl > 255 ? 255 : ttl)); /* TTL */
  wr32(dst + ihl + 4, seq);                 /* TCP sequence number */
  fill_checksums4(dst, total, ihl, bad_tcp_csum);
  return total;
}

int tcpdpi_build_seqovl4(uint8_t *dst, size_t dstcap,
                         const uint8_t *ip_tmpl, int ihl,
                         const uint8_t *tcp_tmpl, int tcphl,
                         uint16_t ip_id, uint32_t seq, int ttl,
                         const uint8_t *real, int real_len,
                         int overlap, uint8_t pattern) {
  if (overlap < 1 || real_len < 1 || !real) return 0;
  int paylen = overlap + real_len;
  if (ihl < 20 || tcphl < 20) return 0;
  if (ihl + tcphl + paylen > TCPDPI_SEG_MAX) return 0;
  uint8_t pay[TCPDPI_SEG_MAX];
  memset(pay, pattern, (size_t)overlap);
  memcpy(pay + overlap, real, (size_t)real_len);
  /* Sequence moved back by `overlap`: the first `overlap` bytes fall before the
   * receiver's window and are discarded; real[0,real_len) lands in-window. */
  return tcpdpi_build_segment4(dst, dstcap, ip_tmpl, ihl, tcp_tmpl, tcphl,
                               ip_id, seq - (uint32_t)overlap, ttl,
                               pay, paylen, 0 /* good: the server keeps it */);
}

int tcpdpi_build_fakedsplit4(tcpdpi_seg segs[3], int *nsegs,
                             const uint8_t *ip_tmpl, int ihl,
                             const uint8_t *tcp_tmpl, int tcphl,
                             uint16_t ip_id, uint32_t seq, int ttl,
                             const uint8_t *real, int real_len,
                             int split_pos, int fake_ttl, uint8_t pattern,
                             int disorder) {
  if (!segs || !nsegs || !real) return 0;
  if (real_len < 2 || real_len > TCPDPI_SEG_MAX) return 0;
  if (split_pos < 1 || split_pos >= real_len) return 0;
  int lenA = split_pos;                 /* real[0,split) at seq            */
  int lenB = real_len - split_pos;      /* real[split,n) at seq+split      */
  uint32_t seqB = seq + (uint32_t)split_pos;
  uint8_t junk[TCPDPI_SEG_MAX];

  /* The three segments in the order they are sent. The fake shadows the real
   * part that follows it, carrying junk so the DPI mis-reads that region; its
   * low TTL and bad checksum keep it from ever being accepted by the server. */
  int a, f, b;
  if (!disorder) {            /* fakedsplit: A, fake@split, B */
    memset(junk, pattern, (size_t)lenB);
    a = tcpdpi_build_segment4(segs[0].data, sizeof segs[0].data, ip_tmpl, ihl, tcp_tmpl, tcphl,
                              ip_id, seq, ttl, real, lenA, 0);
    f = tcpdpi_build_segment4(segs[1].data, sizeof segs[1].data, ip_tmpl, ihl, tcp_tmpl, tcphl,
                              (uint16_t)(ip_id + 1), seqB, fake_ttl, junk, lenB, 1);
    b = tcpdpi_build_segment4(segs[2].data, sizeof segs[2].data, ip_tmpl, ihl, tcp_tmpl, tcphl,
                              (uint16_t)(ip_id + 2), seqB, ttl, real + split_pos, lenB, 0);
    segs[0].is_fake = 0; segs[1].is_fake = 1; segs[2].is_fake = 0;
  } else {                    /* fakeddisorder: B, fake@0, A */
    memset(junk, pattern, (size_t)lenA);
    b = tcpdpi_build_segment4(segs[0].data, sizeof segs[0].data, ip_tmpl, ihl, tcp_tmpl, tcphl,
                              ip_id, seqB, ttl, real + split_pos, lenB, 0);
    f = tcpdpi_build_segment4(segs[1].data, sizeof segs[1].data, ip_tmpl, ihl, tcp_tmpl, tcphl,
                              (uint16_t)(ip_id + 1), seq, fake_ttl, junk, lenA, 1);
    a = tcpdpi_build_segment4(segs[2].data, sizeof segs[2].data, ip_tmpl, ihl, tcp_tmpl, tcphl,
                              (uint16_t)(ip_id + 2), seq, ttl, real, lenA, 0);
    segs[0].is_fake = 0; segs[1].is_fake = 1; segs[2].is_fake = 0;
  }
  if (a <= 0 || f <= 0 || b <= 0) return 0;
  segs[0].len = disorder ? b : a;
  segs[1].len = f;
  segs[2].len = disorder ? a : b;
  *nsegs = 3;
  return 1;
}

int tcpdpi_split_pos(const uint8_t *payload, int plen, int host_off, int host_len) {
  if (!payload || host_off < 1 || host_len < 2 || host_off + host_len > plen) return 0;
  const uint8_t *h = payload + host_off;
  int end = host_len;
  if (h[end - 1] == '.') end--;             /* a fully qualified "name." */
  int last = -1, prev = -1;
  for (int i = 0; i < end; i++) if (h[i] == '.') { prev = last; last = i; }
  int s = 0, e = end;                       /* the second-level label ... */
  if (last > 0) { s = prev + 1; e = last; }
  if (e - s < 2) { s = 0; e = host_len; }   /* ... or the whole name */
  int pos = host_off + s + (e - s) / 2;
  return (pos >= 1 && pos < plen) ? pos : 0;
}

int tcpdpi_build_split4(tcpdpi_seg segs[2], int *nsegs,
                        const uint8_t *ip_tmpl, int ihl,
                        const uint8_t *tcp_tmpl, int tcphl,
                        uint16_t ip_id, uint32_t seq, int ttl,
                        const uint8_t *real, int real_len, int split_pos) {
  if (!segs || !nsegs || !real) return 0;
  if (real_len < 2 || real_len > TCPDPI_SEG_MAX) return 0;
  if (split_pos < 1 || split_pos >= real_len) return 0;
  int a = tcpdpi_build_segment4(segs[0].data, sizeof segs[0].data, ip_tmpl, ihl, tcp_tmpl, tcphl,
                                ip_id, seq, ttl, real, split_pos, 0);
  int b = tcpdpi_build_segment4(segs[1].data, sizeof segs[1].data, ip_tmpl, ihl, tcp_tmpl, tcphl,
                                (uint16_t)(ip_id + 1), seq + (uint32_t)split_pos, ttl,
                                real + split_pos, real_len - split_pos, 0);
  if (a <= 0 || b <= 0) return 0;
  segs[0].len = a; segs[0].is_fake = 0;
  segs[1].len = b; segs[1].is_fake = 0;
  *nsegs = 2;
  return 1;
}
