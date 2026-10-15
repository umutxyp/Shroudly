/*
 * raw_linux.c — ADVANCED (packet-layer) desync backend for Linux.
 *
 * This is the optional mode that can defeat *stateful* DPI (Iran/China) which
 * reassembles the TCP stream and so is immune to userspace split/disorder.
 *
 * Mechanism (same family as zapret's nfqws):
 *   - An iptables (or, failing that, nftables) rule queues outbound IPv4
 *     80/443 packets into NFQUEUE. Our own fakes carry SHROUDLY_FWMARK and are
 *     excluded, so an injected decoy is never queued (and faked) again.
 *   - For each queued ClientHello we:
 *       1. send a FAKE decoy segment (same seq, scrambled SNI) via a raw socket
 *          with a LOW TTL and/or BAD checksum so it reaches the DPI but dies
 *          before the server — poisoning the DPI's reassembly state;
 *       2. then let the real packet through (optionally split).
 *
 * Requires root / CAP_NET_ADMIN + CAP_NET_RAW, and is Linux-only. It is compiled
 * only when SHROUDLY_RAW is defined and linked with -lnetfilter_queue -lmnl.
 *
 * The backend installs the rule itself once the queue is bound, and removes it
 * in raw_linux_teardown(), which runs on every stop path (see supervise.c).
 * The rule uses queue-bypass, so even a crashed backend never blocks traffic.
 */
#ifdef SHROUDLY_RAW
#ifdef __linux__

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <time.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/ip.h>
#include <netinet/tcp.h>
#include <netinet/udp.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <linux/netfilter.h>   /* NF_ACCEPT, NF_DROP */

#include <libnetfilter_queue/libnetfilter_queue.h>
#include <libnetfilter_queue/pktbuff.h>
#include <libnetfilter_queue/libnetfilter_queue_ipv4.h>
#include <libnetfilter_queue/libnetfilter_queue_tcp.h>

#include "proto.h"
#include "udpdpi.h"
#include "raw_linux.h"

static int g_raw_fd = -1;
static int g_fake_ttl = 4;
static volatile int g_run = 0;
static struct nfq_handle *g_h = NULL;
static struct nfq_q_handle *g_qh = NULL;
static int g_queue_num = 200;
static int g_quic_block = 1;      /* drop QUIC Initial -> browsers fall to TCP */
static int g_udp_fake = 1;        /* decoys ahead of Discord voice datagrams */
static int g_fake_repeats = 6;    /* decoy datagrams per voice flow */
static udp_flow_table g_flows;    /* first-N-per-flow bookkeeping */
static char g_udp_ports[128] = "";/* iptables multiport dports, "" if no UDP rule */
static char g_udp_nft[160] = "";  /* nft set contents for the same ports */
static enum { RULE_NONE, RULE_IPTABLES, RULE_NFT } g_rule = RULE_NONE;

static uint32_t now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint32_t)((uint32_t)ts.tv_sec * 1000u + (uint32_t)(ts.tv_nsec / 1000000));
}

/* Run a firewall tool quietly. Returns its exit status, or -1. */
static int run_quiet(char *const argv[]) {
  pid_t pid = fork();
  if (pid < 0) return -1;
  if (pid == 0) {
    int dn = open("/dev/null", O_WRONLY);
    if (dn >= 0) { dup2(dn, 1); dup2(dn, 2); }
    execvp(argv[0], argv);
    _exit(127);
  }
  int st;
  if (waitpid(pid, &st, 0) < 0) return -1;
  return WIFEXITED(st) ? WEXITSTATUS(st) : -1;
}

/* Build the UDP destination-port list for the enabled features (empty if none):
 * QUIC adds 443; Discord voice adds the STUN ports and the media range. */
static void build_udp_ports(void) {
  char ipt[128] = "", nftp[160] = "";
  if (g_quic_block) { snprintf(ipt, sizeof(ipt), "443"); snprintf(nftp, sizeof(nftp), "443"); }
  if (g_udp_fake) {
    const char *i2 = "3478,19302:19309,50000:65535";
    const char *n2 = "3478, 19302-19309, 50000-65535";
    if (ipt[0]) { char t[128]; snprintf(t, sizeof(t), "%s,%s", ipt, i2); snprintf(ipt, sizeof(ipt), "%s", t); }
    else snprintf(ipt, sizeof(ipt), "%s", i2);
    if (nftp[0]) { char t[160]; snprintf(t, sizeof(t), "%s, %s", nftp, n2); snprintf(nftp, sizeof(nftp), "%s", t); }
    else snprintf(nftp, sizeof(nftp), "%s", n2);
  }
  snprintf(g_udp_ports, sizeof(g_udp_ports), "%s", ipt);
  snprintf(g_udp_nft, sizeof(g_udp_nft), "%s", nftp);
}

static int iptables_rule(const char *op) {
  char q[16], mark[32];
  snprintf(q, sizeof(q), "%d", g_queue_num);
  snprintf(mark, sizeof(mark), "0x%x/0x%x", SHROUDLY_FWMARK, SHROUDLY_FWMARK);
  char *argv[] = { "iptables", "-w", "-t", "mangle", (char *)op, "OUTPUT", "-p", "tcp",
    "-m", "multiport", "--dports", "80,443", "-m", "mark", "!", "--mark", mark,
    "-j", "NFQUEUE", "--queue-num", q, "--queue-bypass", NULL };
  return run_quiet(argv);
}

/* The UDP counterpart of the TCP rule, over the same NFQUEUE, our own marked
 * fakes excluded. Returns 127 (never 0) when no UDP feature is on, so a "-D"
 * drain loop stops at once. */
static int iptables_udp_rule(const char *op) {
  if (!g_udp_ports[0]) return 127;
  char q[16], mark[32];
  snprintf(q, sizeof(q), "%d", g_queue_num);
  snprintf(mark, sizeof(mark), "0x%x/0x%x", SHROUDLY_FWMARK, SHROUDLY_FWMARK);
  char *argv[] = { "iptables", "-w", "-t", "mangle", (char *)op, "OUTPUT", "-p", "udp",
    "-m", "multiport", "--dports", g_udp_ports, "-m", "mark", "!", "--mark", mark,
    "-j", "NFQUEUE", "--queue-num", q, "--queue-bypass", NULL };
  return run_quiet(argv);
}

static int nft(const char *cmd) {
  char *argv[] = { "nft", (char *)cmd, NULL };
  return run_quiet(argv);
}

static int install_rule(void) {
  build_udp_ports();
  while (iptables_rule("-D") == 0) {}          /* drop leftovers from a crashed run */
  while (iptables_udp_rule("-D") == 0) {}
  if (iptables_rule("-I") == 0) {
    g_rule = RULE_IPTABLES;
    if (g_udp_ports[0]) iptables_udp_rule("-I"); /* best effort: TCP still works without it */
    return 0;
  }

  char rule[256], urule[320];
  snprintf(rule, sizeof(rule),
    "add rule ip shroudly out tcp dport { 80, 443 } meta mark and 0x%x == 0 queue num %d bypass",
    SHROUDLY_FWMARK, g_queue_num);
  nft("delete table ip shroudly");
  if (nft("add table ip shroudly") == 0 &&
      nft("add chain ip shroudly out { type filter hook output priority -150 ; }") == 0 &&
      nft(rule) == 0) {
    g_rule = RULE_NFT;
    if (g_udp_ports[0]) {
      snprintf(urule, sizeof(urule),
        "add rule ip shroudly out udp dport { %s } meta mark and 0x%x == 0 queue num %d bypass",
        g_udp_nft, SHROUDLY_FWMARK, g_queue_num);
      nft(urule);                              /* best effort */
    }
    return 0;
  }
  nft("delete table ip shroudly");
  return -1;
}

void raw_linux_teardown(void) {
  if (g_rule == RULE_IPTABLES) {
    for (int i = 0; i < 8 && iptables_rule("-D") == 0; i++) {}
    for (int i = 0; i < 8 && iptables_udp_rule("-D") == 0; i++) {}
  } else if (g_rule == RULE_NFT) nft("delete table ip shroudly");
  g_rule = RULE_NONE;
}

/* Compute IPv4 + TCP checksums for a self-made packet. */
static uint16_t csum16(const void *data, int len, uint32_t init) {
  const uint16_t *p = (const uint16_t *)data;
  uint32_t sum = init;
  while (len > 1) { sum += *p++; len -= 2; }
  if (len) sum += *(const uint8_t *)p;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (uint16_t)~sum;
}

static void fill_checksums(struct iphdr *ip, struct tcphdr *tcp, int tcplen, int bad) {
  ip->check = 0;
  ip->check = csum16(ip, ip->ihl * 4, 0);
  /* TCP pseudo-header */
  uint32_t ph = 0;
  ph += (ip->saddr & 0xffff) + (ip->saddr >> 16);
  ph += (ip->daddr & 0xffff) + (ip->daddr >> 16);
  ph += htons(IPPROTO_TCP);
  ph += htons((uint16_t)tcplen);
  tcp->check = 0;
  uint16_t c = csum16(tcp, tcplen, ph);
  tcp->check = bad ? (uint16_t)(c ^ 0xffff) : c; /* bad: deliberately corrupt */
}

/* Send a fake decoy copy of the original packet with scrambled SNI + low TTL. */
static void send_fake(const struct iphdr *oip, const struct tcphdr *otcp,
                      const uint8_t *payload, int plen, const proto_info *pi) {
  if (g_raw_fd < 0 || plen <= 0) return;
  int iphl = oip->ihl * 4;
  int tcphl = otcp->doff * 4;
  int total = iphl + tcphl + plen;
  if (total > 1600) return;

  uint8_t buf[1600];
  memcpy(buf, oip, iphl);
  memcpy(buf + iphl, otcp, tcphl);
  memcpy(buf + iphl + tcphl, payload, plen);

  struct iphdr *ip = (struct iphdr *)buf;
  struct tcphdr *tcp = (struct tcphdr *)(buf + iphl);

  ip->ttl = (uint8_t)g_fake_ttl;           /* dies before the server */
  ip->tot_len = htons((uint16_t)total);

  /* scramble the SNI/host bytes so the DPI reassembles garbage */
  uint8_t *fp = buf + iphl + tcphl;
  if (pi->host_off >= 0 && pi->host_off + pi->host_len <= plen) {
    for (int i = pi->host_off; i < pi->host_off + pi->host_len; i++) fp[i] ^= 0x5a;
  } else {
    for (int i = plen / 3; i < plen; i++) fp[i] ^= 0x5a;
  }

  /* good IP checksum, deliberately BAD tcp checksum so the server drops it but
   * the (often checksum-ignoring) DPI still ingests it. */
  fill_checksums(ip, tcp, tcphl + plen, 1);

  struct sockaddr_in dst;
  memset(&dst, 0, sizeof(dst));
  dst.sin_family = AF_INET;
  dst.sin_addr.s_addr = oip->daddr;
  dst.sin_port = otcp->dest;
  sendto(g_raw_fd, buf, total, 0, (struct sockaddr *)&dst, sizeof(dst));
}

/* Inject g_fake_repeats decoy UDP datagrams to the SAME 5-tuple ahead of the
 * real one: random payload of the same length, low TTL, valid checksums. They
 * carry SHROUDLY_FWMARK (SO_MARK on g_raw_fd), so the NFQUEUE rule skips them. */
static void send_udp_decoys(const struct iphdr *ip, const struct udphdr *udp, int plen) {
  if (g_raw_fd < 0 || plen <= 0 || plen > 1400) return;
  uint8_t buf[1600];
  struct sockaddr_in dst;
  memset(&dst, 0, sizeof(dst));
  dst.sin_family = AF_INET;
  dst.sin_addr.s_addr = ip->daddr;
  dst.sin_port = udp->dest;
  uint32_t t = now_ms();
  for (int i = 0; i < g_fake_repeats; i++) {
    uint16_t ipid = (uint16_t)(t + (uint32_t)i * 7u + 1u);
    uint32_t seed = ip->saddr ^ (ip->daddr << 1) ^ ((uint32_t)udp->source << 3) ^
                    ((uint32_t)udp->dest << 5) ^ (uint32_t)i * 2654435761u ^ t;
    int n = udp_build_decoy(buf, (int)sizeof(buf), ip->saddr, ip->daddr,
                            udp->source, udp->dest, plen, g_fake_ttl, ipid, seed);
    if (n <= 0) break;
    sendto(g_raw_fd, buf, (size_t)n, 0, (struct sockaddr *)&dst, sizeof(dst));
  }
}

static int cb(struct nfq_q_handle *qh, struct nfgenmsg *nfmsg,
              struct nfq_data *nfa, void *data) {
  (void)nfmsg; (void)data;
  struct nfqnl_msg_packet_hdr *ph = nfq_get_msg_packet_hdr(nfa);
  uint32_t id = ph ? ntohl(ph->packet_id) : 0;
  if (nfq_get_nfmark(nfa) & SHROUDLY_FWMARK) return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);

  unsigned char *pkt = NULL;
  int len = nfq_get_payload(nfa, &pkt);
  if (len < (int)sizeof(struct iphdr)) return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);

  struct iphdr *ip = (struct iphdr *)pkt;
  if (ip->version != 4) return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);
  int iphl = ip->ihl * 4;
  if (iphl < 20 || len < iphl) return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);

  if (ip->protocol == IPPROTO_TCP) {
    if (len < iphl + (int)sizeof(struct tcphdr)) return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);
    struct tcphdr *tcp = (struct tcphdr *)(pkt + iphl);
    int tcphl = tcp->doff * 4;
    int poff = iphl + tcphl;
    int plen = len - poff;
    if (plen <= 0) return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);

    proto_info pi;
    proto_inspect(pkt + poff, (size_t)plen, &pi);
    if (pi.kind != PROTO_UNKNOWN) {
      /* 1. inject the fake decoy first (low TTL, bad checksum) */
      send_fake(ip, tcp, pkt + poff, plen, &pi);
      /* 2. accept the real packet unchanged — the server sees only this */
    }
    return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);
  }

  if (ip->protocol == IPPROTO_UDP) {
    if (len < iphl + (int)sizeof(struct udphdr)) return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);
    struct udphdr *udp = (struct udphdr *)(pkt + iphl);
    uint16_t dport_h = ntohs(udp->dest);
    int poff = iphl + (int)sizeof(struct udphdr);
    int plen = len - poff;
    const uint8_t *up = pkt + poff;

    /* (1) QUIC: drop the Initial so the browser falls back to TCP (which the
     * proxy handles). Everything else on 443 re-injects unchanged. */
    if (g_quic_block && dport_h == 443) {
      if (plen > 0 && quic_is_initial(up, plen))
        return nfq_set_verdict(qh, id, NF_DROP, 0, NULL);
      return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);
    }

    /* (2) Discord voice / STUN: decoys ahead of the first datagrams of a flow;
     * the real datagram is always accepted unchanged. */
    if (g_udp_fake && discord_voice_port(dport_h) && plen > 0 && udp_is_discord_voice(up, plen)) {
      if (udp_flow_note(&g_flows, ip->saddr, udp->source, ip->daddr, udp->dest, now_ms()))
        send_udp_decoys(ip, udp, plen);
    }
    return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);
  }

  return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);
}

int raw_linux_start(int queue_num, int fake_ttl, int quic_block, int udp_fake, int fake_repeats) {
  g_fake_ttl = fake_ttl > 0 ? fake_ttl : 4;
  g_queue_num = queue_num;
  g_quic_block = quic_block ? 1 : 0;
  g_udp_fake = udp_fake ? 1 : 0;
  g_fake_repeats = (fake_repeats > 0 && fake_repeats <= 64) ? fake_repeats : 6;
  udp_flow_init(&g_flows);

  g_raw_fd = socket(AF_INET, SOCK_RAW, IPPROTO_RAW);
  if (g_raw_fd < 0) { perror("raw socket"); return -1; }
  int one = 1;
  if (setsockopt(g_raw_fd, IPPROTO_IP, IP_HDRINCL, &one, sizeof(one)) < 0) {
    perror("IP_HDRINCL"); close(g_raw_fd); g_raw_fd = -1; return -1;
  }
  int mark = SHROUDLY_FWMARK;
  if (setsockopt(g_raw_fd, SOL_SOCKET, SO_MARK, &mark, sizeof(mark)) < 0) {
    perror("SO_MARK"); close(g_raw_fd); g_raw_fd = -1; return -1;
  }

  g_h = nfq_open();
  if (!g_h) { fprintf(stderr, "nfq_open failed\n"); return -1; }
  nfq_unbind_pf(g_h, AF_INET);
  if (nfq_bind_pf(g_h, AF_INET) < 0) { fprintf(stderr, "nfq_bind_pf failed\n"); return -1; }
  g_qh = nfq_create_queue(g_h, (uint16_t)queue_num, &cb, NULL);
  if (!g_qh) { fprintf(stderr, "nfq_create_queue failed\n"); return -1; }
  nfq_set_mode(g_qh, NFQNL_COPY_PACKET, 0xffff);
  if (install_rule() != 0) {
    fprintf(stderr, "could not install the NFQUEUE rule (need iptables or nft)\n");
    return -1;
  }

  g_run = 1;
  int fd = nfq_fd(g_h);
  char buf[4096] __attribute__((aligned));
  printf("{\"type\":\"raw_ready\",\"queue\":%d,\"ttl\":%d,\"quic_block\":%d,\"udp_fake\":%d}\n",
         queue_num, g_fake_ttl, g_quic_block, g_udp_fake);
  fflush(stdout);
  while (g_run) {
    int rv = recv(fd, buf, sizeof(buf), 0);
    if (rv >= 0) { nfq_handle_packet(g_h, buf, rv); continue; }
    if (errno == ENOBUFS) continue;      /* dropped under load; keep going */
    if (errno == EINTR) continue;
    break;
  }
  return 0;
}

void raw_linux_stop(void) {
  g_run = 0;
  raw_linux_teardown();
  if (g_qh) { nfq_destroy_queue(g_qh); g_qh = NULL; }
  if (g_h) { nfq_close(g_h); g_h = NULL; }
  if (g_raw_fd >= 0) { close(g_raw_fd); g_raw_fd = -1; }
}

#endif /* __linux__ */
#endif /* SHROUDLY_RAW */
