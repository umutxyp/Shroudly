/*
 * raw_linux.c — ADVANCED (packet-layer) desync backend for Linux.
 *
 * This is the optional mode that can defeat *stateful* DPI (Iran/China) which
 * reassembles the TCP stream and so is immune to userspace split/disorder, plus
 * the inbound protections that Turkish networks need.
 *
 * Mechanism (same family as zapret's nfqws):
 *   - An iptables (or, failing that, nftables) rule queues outbound IPv4
 *     80/443 packets into NFQUEUE. Our own fakes carry SHROUDLY_FWMARK and are
 *     excluded, so an injected segment is never queued (and faked) again.
 *   - For each queued ClientHello we, by configuration:
 *       * send a FAKE decoy segment (scrambled SNI) with a LOW TTL and BAD
 *         checksum so it reaches the DPI but dies before the server;
 *       * optionally sequence-overlap the real first segment (split-seqovl);
 *       * optionally send it as fakedsplit / fakeddisorder;
 *     and then let the real packet through (default) or replace it.
 *   - Separate INPUT-side rules queue inbound 80/443 RSTs (to drop the forged
 *     ones that tear a blocked connection down) and SYN-ACKs (to measure the
 *     hop distance for the decoy's TTL). Everything not an exact match is
 *     re-injected / accepted unchanged.
 *
 * Requires root / CAP_NET_ADMIN + CAP_NET_RAW, and is Linux-only. Compiled only
 * when SHROUDLY_RAW is defined and linked with -lnetfilter_queue -lmnl.
 *
 * The backend installs the rules itself once the queue is bound, and removes
 * them in raw_linux_teardown(), which runs on every stop path (see
 * supervise.c). Every rule uses queue-bypass, so even a crashed backend never
 * blocks traffic.
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
#include "platform.h"
#include "raw_linux.h"
#include "raw_desync.h"
#include "tcpdpi.h"

static int g_raw_fd = -1;
static raw_config g_cfg;
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
static uint16_t g_ipid = 0x1000; /* rolling IP id for our crafted segments */


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

/* OUTBOUND rule: queue outbound tcp 80/443, skipping our own marked fakes. */
static int ipt_out(const char *op) {
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

/* INBOUND rule: queue inbound tcp from 80/443 whose flags match `flags`/`mask`
 * (RST for the RST-drop, SYN,ACK for the hop measurement). Low volume. */
static int ipt_in(const char *op, const char *mask, const char *flags) {
  char q[16];
  snprintf(q, sizeof(q), "%d", g_queue_num);
  char *argv[] = { "iptables", "-w", "-t", "mangle", (char *)op, "INPUT", "-p", "tcp",
    "-m", "multiport", "--sports", "80,443", "--tcp-flags", (char *)mask, (char *)flags,
    "-j", "NFQUEUE", "--queue-num", q, "--queue-bypass", NULL };
  return run_quiet(argv);
}

static int nft(const char *cmd) {
  char *argv[] = { "nft", (char *)cmd, NULL };
  return run_quiet(argv);
}

/* Remove any rules a previous (possibly crashed) run left behind. Returns
 * 127 from the UDP rule when no UDP feature is on, so its loop stops at once. */
static void ipt_clean_all(void) {
  for (int i = 0; i < 8 && ipt_out("-D") == 0; i++) {}
  for (int i = 0; i < 8 && iptables_udp_rule("-D") == 0; i++) {}
  for (int i = 0; i < 8 && ipt_in("-D", "RST", "RST") == 0; i++) {}
  for (int i = 0; i < 8 && ipt_in("-D", "SYN,ACK", "SYN,ACK") == 0; i++) {}
}

static int install_rule(void) {
  build_udp_ports();
  ipt_clean_all();
  if (ipt_out("-I") == 0) {
    g_rule = RULE_IPTABLES;
    if (g_cfg.drop_rst) ipt_in("-I", "RST", "RST");
    if (g_cfg.autottl)  ipt_in("-I", "SYN,ACK", "SYN,ACK");
    if (g_udp_ports[0]) iptables_udp_rule("-I"); /* best effort: TCP still works without it */
    return 0;
  }

  /* nftables fallback: one table, an output chain and an input chain. */
  char rule[320];
  nft("delete table ip shroudly");
  if (nft("add table ip shroudly") != 0) return -1;
  if (nft("add chain ip shroudly out { type filter hook output priority -150 ; }") != 0) { nft("delete table ip shroudly"); return -1; }
  snprintf(rule, sizeof(rule),
    "add rule ip shroudly out tcp dport { 80, 443 } meta mark and 0x%x == 0 queue num %d bypass",
    SHROUDLY_FWMARK, g_queue_num);
  if (nft(rule) != 0) { nft("delete table ip shroudly"); return -1; }
  if (g_udp_ports[0]) {
    snprintf(rule, sizeof(rule),
      "add rule ip shroudly out udp dport { %s } meta mark and 0x%x == 0 queue num %d bypass",
      g_udp_nft, SHROUDLY_FWMARK, g_queue_num);
    nft(rule);                                 /* best effort */
  }
  if (g_cfg.drop_rst || g_cfg.autottl) {
    if (nft("add chain ip shroudly in { type filter hook input priority -150 ; }") != 0) { nft("delete table ip shroudly"); return -1; }
    if (g_cfg.drop_rst) {
      snprintf(rule, sizeof(rule), "add rule ip shroudly in tcp sport { 80, 443 } tcp flags & rst == rst queue num %d bypass", g_queue_num);
      nft(rule);
    }
    if (g_cfg.autottl) {
      snprintf(rule, sizeof(rule), "add rule ip shroudly in tcp sport { 80, 443 } tcp flags & (syn|ack) == (syn|ack) queue num %d bypass", g_queue_num);
      nft(rule);
    }
  }
  g_rule = RULE_NFT;
  return 0;
}

void raw_linux_teardown(void) {
  if (g_rule == RULE_IPTABLES) ipt_clean_all();
  else if (g_rule == RULE_NFT) nft("delete table ip shroudly");
  g_rule = RULE_NONE;
}

/* Inject a self-made IPv4 segment (headers included) via the raw socket. It
 * carries SHROUDLY_FWMARK (SO_MARK), so the OUTPUT rule skips it. */
static void raw_send(const uint8_t *seg, int len, uint32_t daddr, uint16_t dport) {
  if (g_raw_fd < 0 || len <= 0) return;
  struct sockaddr_in dst;
  memset(&dst, 0, sizeof(dst));
  dst.sin_family = AF_INET;
  dst.sin_addr.s_addr = daddr;
  dst.sin_port = dport;
  sendto(g_raw_fd, seg, (size_t)len, 0, (struct sockaddr *)&dst, sizeof(dst));
}

/* Send a fake decoy copy of the original packet: scrambled SNI, low TTL and a
 * deliberately bad TCP checksum, so it reaches the DPI but the server drops it.
 * `ttl` is the effective decoy TTL (autottl or the fixed fallback). */
static void send_fake(const struct iphdr *oip, const struct tcphdr *otcp,
                      const uint8_t *payload, int plen, const proto_info *pi, int ttl) {
  if (g_raw_fd < 0 || plen <= 0 || plen > 1500) return;
  int iphl = oip->ihl * 4, tcphl = otcp->doff * 4;

  uint8_t pay[1600];
  memcpy(pay, payload, (size_t)plen);
  /* scramble the SNI/host bytes so the DPI reassembles garbage */
  if (pi->host_off >= 0 && pi->host_off + pi->host_len <= plen) {
    for (int i = pi->host_off; i < pi->host_off + pi->host_len; i++) pay[i] ^= 0x5a;
  } else {
    for (int i = plen / 3; i < plen; i++) pay[i] ^= 0x5a;
  }

  uint8_t out[1600];
  int eff = ttl > 0 ? ttl : g_cfg.fake_ttl;
  int n = tcpdpi_build_segment4(out, sizeof out, (const uint8_t *)oip, iphl,
                                (const uint8_t *)otcp, tcphl, g_ipid++, ntohl(otcp->seq),
                                eff, pay, plen, 1 /* bad checksum: server drops it */);
  if (n > 0) raw_send(out, n, oip->daddr, otcp->dest);
}

/* Effective decoy TTL for this destination: the measured one if autottl has a
 * hop count for it, else the fixed configured TTL. */
static int decoy_ttl_for(uint32_t daddr) {
  if (g_cfg.autottl) {
    int hops = tcpdpi_hops_get(daddr, now_ms());
    if (hops > 0) return tcpdpi_decoy_ttl(hops, g_cfg.autottl_margin, g_cfg.autottl_min);
  }
  return g_cfg.fake_ttl;
}

/* Handle an outbound ClientHello / first request. Returns 1 if the original was
 * consumed (caller must DROP it), 0 if it must be ACCEPTED unchanged. */
static int handle_outbound(const struct iphdr *ip, const struct tcphdr *tcp,
                           const uint8_t *payload, int plen, const proto_info *pi) {
  int iphl = ip->ihl * 4, tcphl = tcp->doff * 4;
  const uint8_t *ip_tmpl = (const uint8_t *)ip;
  const uint8_t *tcp_tmpl = (const uint8_t *)tcp;
  uint32_t seq = ntohl(tcp->seq);
  int otl = ip->ttl ? ip->ttl : 64;
  int ttl = decoy_ttl_for(ip->daddr);

  if (g_cfg.desync_mode == RAW_DESYNC_FAKEDSPLIT || g_cfg.desync_mode == RAW_DESYNC_FAKEDDISORDER) {
    int split = (pi->host_off > 0 && pi->host_off < plen) ? pi->host_off : (plen > 2 ? 2 : 1);
    tcpdpi_seg segs[3]; int ns = 0;
    if (tcpdpi_build_fakedsplit4(segs, &ns, ip_tmpl, iphl, tcp_tmpl, tcphl, g_ipid, seq, otl,
                                 payload, plen, split, ttl, g_cfg.fake_pattern,
                                 g_cfg.desync_mode == RAW_DESYNC_FAKEDDISORDER)) {
      g_ipid += 3;
      for (int i = 0; i < ns; i++) raw_send(segs[i].data, segs[i].len, ip->daddr, tcp->dest);
      return 1; /* original replaced */
    }
    return 0;   /* build failed: fall back to accepting the real packet */
  }

  /* RAW_DESYNC_FAKE: the proven decoy, then the real packet ... */
  send_fake(ip, tcp, payload, plen, pi, ttl);
  if (g_cfg.seqovl > 0 && plen > 0) {
    uint8_t out[1600];
    int n = tcpdpi_build_seqovl4(out, sizeof out, ip_tmpl, iphl, tcp_tmpl, tcphl, g_ipid,
                                 seq, otl, payload, plen, g_cfg.seqovl, g_cfg.seqovl_pattern);
    if (n > 0) { g_ipid++; raw_send(out, n, ip->daddr, tcp->dest); return 1; }
  }
  /* ... and the real one cut, so no segment carries the whole name: a filter
   * the decoy does not fool still never reads it. Left whole when there is no
   * name to cut or the parts cannot be built. */
  if (g_cfg.split != RAW_SPLIT_OFF) {
    int cuts[2], nc = tcpdpi_split_points(payload, plen, pi->host_off, pi->host_len, cuts);
    tcpdpi_seg segs[3]; int ns = 0;
    if (nc > 0 && tcpdpi_build_multisplit4(segs, &ns, ip_tmpl, iphl, tcp_tmpl, tcphl, g_ipid, seq, otl,
                                           payload, plen, cuts, nc, g_cfg.split == RAW_SPLIT_DISORDER)) {
      g_ipid = (uint16_t)(g_ipid + ns);
      for (int i = 0; i < ns; i++) raw_send(segs[i].data, segs[i].len, ip->daddr, tcp->dest);
      return 1; /* original replaced */
    }
  }
  return 0; /* accept the real packet unchanged */
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
  uint32_t t = (uint32_t)now_ms();
  for (int i = 0; i < g_fake_repeats; i++) {
    uint16_t ipid = (uint16_t)(t + (uint32_t)i * 7u + 1u);
    uint32_t seed = ip->saddr ^ (ip->daddr << 1) ^ ((uint32_t)udp->source << 3) ^
                    ((uint32_t)udp->dest << 5) ^ (uint32_t)i * 2654435761u ^ t;
    int n = udp_build_decoy(buf, (int)sizeof(buf), ip->saddr, ip->daddr,
                            udp->source, udp->dest, plen, g_cfg.fake_ttl, ipid, seed);
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
    if (tcphl < 20 || iphl + tcphl > len) return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);
    int sport = ntohs(tcp->source), dport = ntohs(tcp->dest);
    int web_src = (sport == 80 || sport == 443);
    int web_dst = (dport == 80 || dport == 443);

    /* Inbound (from a web port): the RST-drop and SYN-ACK hop measurement. The
     * INPUT rules only queue RST and SYN-ACK, so these are the only cases here. */
    if (web_src && !web_dst) {
      if (g_cfg.drop_rst && (tcp->rst) && tcpdpi_is_injected_rst4(pkt, len))
        return nfq_set_verdict(qh, id, NF_DROP, 0, NULL);            /* forged: drop it */
      if (g_cfg.autottl && tcp->syn && tcp->ack) {
        int hops = tcpdpi_hops_from_ttl(ip->ttl);
        if (hops > 0) tcpdpi_hops_put(ip->saddr, hops, now_ms());
      }
      return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);            /* everything else kept */
    }

    /* Outbound ClientHello / first request. */
    int poff = iphl + tcphl;
    int plen = len - poff;
    if (plen <= 0) return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);
    proto_info pi;
    proto_inspect(pkt + poff, (size_t)plen, &pi);
    if (pi.kind == PROTO_UNKNOWN) return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);
    if (handle_outbound(ip, tcp, pkt + poff, plen, &pi))
      return nfq_set_verdict(qh, id, NF_DROP, 0, NULL);  /* replaced by our segments */
    return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);   /* real packet unchanged */
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
      if (udp_flow_note(&g_flows, ip->saddr, udp->source, ip->daddr, udp->dest, (uint32_t)now_ms()))
        send_udp_decoys(ip, udp, plen);
    }
    return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);
  }

  return nfq_set_verdict(qh, id, NF_ACCEPT, 0, NULL);
}

int raw_linux_start(int queue_num, const raw_config *cfg) {
  g_cfg = *cfg;
  if (g_cfg.fake_ttl <= 0) g_cfg.fake_ttl = 4;
  g_queue_num = queue_num;
  g_quic_block = g_cfg.quic_block ? 1 : 0;
  g_udp_fake = g_cfg.udp_fake ? 1 : 0;
  g_fake_repeats = (g_cfg.fake_repeats > 0 && g_cfg.fake_repeats <= 64) ? g_cfg.fake_repeats : 6;
  udp_flow_init(&g_flows);
  tcpdpi_hops_reset();

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
  printf("{\"type\":\"raw_ready\",\"queue\":%d,\"ttl\":%d,\"drop_rst\":%d,\"autottl\":%d,\"seqovl\":%d,\"split\":%d,\"mode\":%d,\"quic_block\":%d,\"udp_fake\":%d}\n",
         queue_num, g_cfg.fake_ttl, g_cfg.drop_rst, g_cfg.autottl, g_cfg.seqovl, g_cfg.split, g_cfg.desync_mode, g_quic_block, g_udp_fake);
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
