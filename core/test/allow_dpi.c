/*
 * allow_dpi — a lab-only censor that lets through only the names on its
 * list, the way a network does during a shutdown that keeps a few allowed
 * sites (a whitelist): the first request of each connection decides it. A
 * ClientHello for an allowed name lets the connection go, and nothing after
 * it is read again; any other name stops the connection for good. A
 * scrambled decoy is stopped like the real name; a decoy that carries an
 * allowed name (the engine's --decoy-name) lets the real ClientHello behind
 * it through. The advanced-mode lab (tests/lab/advanced-lab.sh) runs it in
 * the router's PREROUTING, where the low-TTL decoy is still seen.
 *
 * It reads TCP to port 443 from an NFQUEUE (nfq.c, no library) and parses
 * with the engine's own proto.c. Lab code: small fixed table, IPv4 only, run
 * as root inside the router netns.
 *
 *   allow_dpi <queue-num> <allowed-suffix>
 */
#include "../src/nfq.h"
#include "../src/proto.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <stdint.h>
#include <sys/socket.h>
#include <linux/netfilter.h>   /* NF_ACCEPT, NF_DROP */

#define FLOWS 128

enum { UNDECIDED = 0, ALLOWED, STOPPED };

typedef struct {
  int used, state;
  uint32_t sa, da; uint16_t sp, dp;   /* four-tuple, network order */
} flow;

static flow g_flows[FLOWS];
static int g_queue, g_fd;
static const char *g_suffix;
static size_t g_suffixlen;

static flow *flow_for(uint32_t sa, uint32_t da, uint16_t sp, uint16_t dp) {
  int free_slot = -1;
  for (int i = 0; i < FLOWS; i++) {
    if (g_flows[i].used && g_flows[i].sa == sa && g_flows[i].da == da &&
        g_flows[i].sp == sp && g_flows[i].dp == dp) return &g_flows[i];
    if (!g_flows[i].used && free_slot < 0) free_slot = i;
  }
  if (free_slot < 0) free_slot = 0;
  flow *f = &g_flows[free_slot];
  memset(f, 0, sizeof(*f));
  f->used = 1; f->sa = sa; f->da = da; f->sp = sp; f->dp = dp;
  return f;
}

/* The name is the allowed one or under it ("x.allowed.lab"). */
static int allowed(const char *host) {
  size_t n = strlen(host);
  if (n == g_suffixlen) return strcmp(host, g_suffix) == 0;
  return n > g_suffixlen && host[n - g_suffixlen - 1] == '.' && strcmp(host + n - g_suffixlen, g_suffix) == 0;
}

static uint32_t judge(const nfq_packet *q) {
  const uint8_t *pkt = q->payload;
  int len = q->len;
  if (!pkt || len < 20 || (pkt[0] >> 4) != 4 || pkt[9] != 6) return NF_ACCEPT;
  int iphl = (pkt[0] & 0x0f) * 4;
  if (iphl < 20 || len < iphl + 20) return NF_ACCEPT;
  const uint8_t *tcp = pkt + iphl;
  int tcphl = ((tcp[12] >> 4) & 0x0f) * 4;
  if (tcphl < 20 || iphl + tcphl > len) return NF_ACCEPT;
  if (((tcp[2] << 8) | tcp[3]) != 443) return NF_ACCEPT;

  uint32_t sa, da; memcpy(&sa, pkt + 12, 4); memcpy(&da, pkt + 16, 4);
  uint16_t sp, dp; memcpy(&sp, tcp + 0, 2); memcpy(&dp, tcp + 2, 2);
  flow *f = flow_for(sa, da, sp, dp);
  if (tcp[13] & 0x02) f->state = UNDECIDED;          /* a SYN starts it anew */
  int poff = iphl + tcphl, plen = len - poff;
  if (f->state == UNDECIDED && plen > 0) {
    proto_info pi;
    proto_inspect(pkt + poff, (size_t)plen, &pi);
    f->state = (pi.kind == PROTO_TLS && pi.host[0] && allowed(pi.host)) ? ALLOWED : STOPPED;
    fprintf(stderr, "allow_dpi: %s (first request names \"%s\", ttl %d)\n",
            f->state == ALLOWED ? "allowed" : "stopped", pi.host, pkt[8]);
    fflush(stderr);
  }
  return f->state == STOPPED ? NF_DROP : NF_ACCEPT;
}

static void on_packet(const nfq_packet *q, void *ud) {
  (void)ud;
  nfq_verdict(g_fd, (uint16_t)g_queue, q->id, judge(q));
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: allow_dpi <queue> <allowed-suffix>\n"); return 2; }
  g_queue = atoi(argv[1]);
  g_suffix = argv[2];
  g_suffixlen = strlen(g_suffix);
  g_fd = nfq_open_queue((uint16_t)g_queue, 0xffff);
  if (g_fd < 0) { fprintf(stderr, "allow_dpi: cannot open queue %d: %s\n", g_queue, strerror(errno)); return 1; }
  printf("allow_dpi ready on queue %d, allowing only %s\n", g_queue, g_suffix);
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
