/*
 * reasm_dpi — a lab-only censor that reassembles the TCP stream before it looks,
 * then inspects each TLS record on its own. This is the kind of filter on
 * Türkiye's Superonline (issue #48): a plain per-packet or per-segment split
 * does not fool it, because it puts the segments back together first; but
 * splitting the TLS record itself does, because it matches the server name only
 * within a single record. The advanced-mode lab (tests/lab/advanced-lab.sh)
 * runs this in the router namespace to prove the engine's packet-layer tlsrec
 * gets past it where the TCP cut does not.
 *
 * It reads outbound TCP to port 443 from an NFQUEUE (nfq.c, no library),
 * rebuilds each connection's byte stream by sequence number, frames the TLS
 * records in it, and drops the whole connection once a record carries the
 * blocked name. Everything else is accepted. Lab code: small, fixed tables,
 * IPv4 only, run as root inside the router netns.
 *
 *   reasm_dpi <queue-num> <blocked-name>
 */
#include "../src/nfq.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <stdint.h>
#include <sys/socket.h>
#include <linux/netfilter.h>   /* NF_ACCEPT, NF_DROP */

#define FLOWS   64
#define BUFCAP  16384

typedef struct {
  int used, blocked, have_base;
  uint32_t sa, da; uint16_t sp, dp;   /* four-tuple, network order */
  uint32_t base;                      /* sequence of the first payload byte */
  int contig;                         /* contiguous bytes from offset 0 */
  int parse;                          /* next record to frame, offset from 0 */
  uint8_t buf[BUFCAP];
  uint8_t got[BUFCAP];                /* which offsets have been filled */
} flow;

static flow g_flows[FLOWS];
static int g_queue;
static int g_fd;
static const char *g_name;
static size_t g_namelen;

static flow *flow_for(uint32_t sa, uint32_t da, uint16_t sp, uint16_t dp) {
  int free_slot = -1;
  for (int i = 0; i < FLOWS; i++) {
    if (g_flows[i].used && g_flows[i].sa == sa && g_flows[i].da == da &&
        g_flows[i].sp == sp && g_flows[i].dp == dp) return &g_flows[i];
    if (!g_flows[i].used && free_slot < 0) free_slot = i;
  }
  if (free_slot < 0) free_slot = 0;                 /* lab: reuse slot 0 if full */
  flow *f = &g_flows[free_slot];
  memset(f, 0, sizeof(*f));
  f->used = 1; f->sa = sa; f->da = da; f->sp = sp; f->dp = dp;
  return f;
}

static int find_name(const uint8_t *p, int len) {
  if (len < (int)g_namelen) return 0;
  for (int i = 0; i + (int)g_namelen <= len; i++)
    if (memcmp(p + i, g_name, g_namelen) == 0) return 1;
  return 0;
}

/* Frame whatever whole TLS records are now contiguous, and block the flow if
 * any single record carries the name. */
static void inspect(flow *f) {
  while (f->contig >= f->parse + 5) {
    const uint8_t *r = f->buf + f->parse;
    if (r[0] != 0x16 && r[0] != 0x17 && r[0] != 0x15 && r[0] != 0x14) return; /* not TLS: stop */
    int rl = (r[3] << 8) | r[4];
    if (rl < 0 || rl > BUFCAP) { f->blocked = 1; return; }
    if (f->contig < f->parse + 5 + rl) return;      /* record not all here yet */
    if (find_name(r + 5, rl)) {
      f->blocked = 1;
      fprintf(stderr, "reasm_dpi: blocked, name in a record of %d bytes at offset %d (contig %d)\n",
              rl, f->parse, f->contig);
      fflush(stderr);
      return;
    }
    f->parse += 5 + rl;
  }
}

static uint32_t judge(const nfq_packet *q) {
  const uint8_t *pkt = q->payload;
  int len = q->len;
  if (!pkt || len < 20) return NF_ACCEPT;
  if ((pkt[0] >> 4) != 4 || pkt[9] != 6) return NF_ACCEPT;    /* IPv4 TCP only */
  int iphl = (pkt[0] & 0x0f) * 4;
  if (iphl < 20 || len < iphl + 20) return NF_ACCEPT;
  const uint8_t *tcp = pkt + iphl;
  int tcphl = ((tcp[12] >> 4) & 0x0f) * 4;
  if (tcphl < 20 || iphl + tcphl > len) return NF_ACCEPT;
  uint16_t dport = (uint16_t)((tcp[2] << 8) | tcp[3]);
  if (dport != 443) return NF_ACCEPT;

  uint32_t sa, da; memcpy(&sa, pkt + 12, 4); memcpy(&da, pkt + 16, 4);
  uint16_t sp, dp; memcpy(&sp, tcp + 0, 2); memcpy(&dp, tcp + 2, 2);
  uint32_t seq = ((uint32_t)tcp[4] << 24) | ((uint32_t)tcp[5] << 16) | ((uint32_t)tcp[6] << 8) | tcp[7];
  int syn = tcp[13] & 0x02, fin = tcp[13] & 0x01, rst = tcp[13] & 0x04;
  flow *f = flow_for(sa, da, sp, dp);
  if (rst) { f->used = 0; return NF_ACCEPT; }
  if (syn) { f->base = seq + 1; f->have_base = 1; f->contig = 0; f->parse = 0; f->blocked = 0;
             memset(f->got, 0, sizeof(f->got)); }

  int poff = iphl + tcphl, plen = len - poff;
  if (plen > 0 && f->have_base) {
    int off = (int)(seq - f->base);                 /* serial arithmetic */
    if (off >= 0 && off + plen <= BUFCAP) {
      memcpy(f->buf + off, pkt + poff, (size_t)plen);
      memset(f->got + off, 1, (size_t)plen);
      while (f->contig < BUFCAP && f->got[f->contig]) f->contig++;
      inspect(f);
    }
  }
  if (fin) f->used = 0;
  return f->blocked ? NF_DROP : NF_ACCEPT;
}

static void on_packet(const nfq_packet *q, void *ud) {
  (void)ud;
  nfq_verdict(g_fd, (uint16_t)g_queue, q->id, judge(q));
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: reasm_dpi <queue> <name>\n"); return 2; }
  g_queue = atoi(argv[1]);
  g_name = argv[2];
  g_namelen = strlen(g_name);
  g_fd = nfq_open_queue((uint16_t)g_queue, 0xffff);
  if (g_fd < 0) { fprintf(stderr, "reasm_dpi: cannot open queue %d: %s\n", g_queue, strerror(errno)); return 1; }
  printf("reasm_dpi ready on queue %d, blocking %s\n", g_queue, g_name);
  fflush(stdout);
  static uint8_t buf[65536 + 4096];
  for (;;) {
    int rv = recv(g_fd, buf, sizeof(buf), 0);
    if (rv >= 0) { nfq_parse(buf, (size_t)rv, on_packet, NULL); continue; }
    if (errno == ENOBUFS || errno == EINTR) continue;
    break;
  }
  nfq_close_queue(g_fd, (uint16_t)g_queue);
  return 0;
}
