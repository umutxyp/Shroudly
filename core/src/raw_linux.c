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
 *   - Of outbound UDP only what the loop acts on is queued, tested in the
 *     kernel with the u32 match (nft: a raw payload expression; see udpdpi.h,
 *     "Kernel pre-filters"): a QUIC long header to port 443, and Discord's IP
 *     discovery request or a STUN Binding request on the voice ports. A
 *     call's own datagrams stay in the kernel, so the queue can add no delay
 *     or loss to them. Without u32, the ports alone are queued, as before.
 *   - Other programs' DNS questions (UDP port 53, not to loopback) go to the
 *     DNS gate when the app gives it its forwarder (--dns-gate, dnsgate.h):
 *     a program that ignores the proxy then gets encrypted DNS's answer, not
 *     the network's forged one. The gate's answer is sent to the program
 *     through the raw socket (marked, so never queued), and a question it
 *     does not answer is sent on the same way, unchanged. IPv4, as the rest
 *     of this backend.
 *   - Traffic to a local, private or special address is never changed, and a
 *     reset is only dropped from a server this engine recently desynced
 *     (rawscope.h).
 *   - A server the decoy itself reaches and upsets gets no more decoys for a
 *     while, only the cut (rawscope.h, "no decoy"). The signs: a TLS alert
 *     from the client right after a decoyed ClientHello (seen on the outbound
 *     rule), or a plaintext TLS alert from the server, queued by one more
 *     narrow INPUT rule (from port 443, payload starting 15 03). That rule is
 *     best effort: iptables needs the u32 match, nft a payload expression;
 *     without it only the client's side is watched.
 *
 * Requires root / CAP_NET_ADMIN + CAP_NET_RAW, and is Linux-only. Compiled only
 * when SHROUDLY_RAW is defined; the queue is spoken over netlink (nfq.c), so
 * no library is linked or needed on the user's system.
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

#include "nfq.h"                /* the queue, over netlink: no library needed */

#include "proto.h"
#include "udpdpi.h"
#include "platform.h"
#include "raw_linux.h"
#include "raw_desync.h"
#include "tcpdpi.h"
#include "rawscope.h"
#include "dnsgate.h"

static int g_raw_fd = -1;
static raw_config g_cfg;
static volatile int g_run = 0;
static int g_nfq = -1;            /* the queue's netlink socket (nfq.h) */
static int g_queue_num = 200;
static int g_quic_block = 1;      /* drop QUIC Initial -> browsers fall to TCP */
static int g_udp_fake = 1;        /* decoys ahead of Discord voice datagrams */
static int g_fake_repeats = 6;    /* decoy datagrams per voice flow */
static udp_flow_table g_flows;    /* first-N-per-flow bookkeeping */
static char g_udp_ports[128] = "";/* iptables multiport dports, "" if no UDP rule */
static char g_udp_nft[160] = "";  /* nft set contents for the same ports */
static int g_udp_match = 0;       /* 1: the UDP rules test payloads (udpdpi.h) */
static enum { RULE_NONE, RULE_IPTABLES, RULE_NFT } g_rule = RULE_NONE;
static uint16_t g_ipid = 0x1000; /* rolling IP id for our crafted segments */
static int g_alert_watch = 0;     /* 1: the inbound TLS alert rule is in place */
static int g_gate = 0;            /* 1: DNS questions go to the gate (dnsgate.h) */


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
    const char *i2 = UDP_PORTS_IPT;
    const char *n2 = UDP_PORTS_NFT;
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

/* The UDP counterparts of the TCP rule, over the same NFQUEUE, our own marked
 * fakes excluded. UDPR_QUIC, UDPR_DISCOVERY and UDPR_STUN each queue one kind
 * of datagram, tested by the u32 match; UDPR_PORTS is the fallback without
 * u32: every datagram to the enabled features' ports. The tested ones are the
 * same whatever is on, so leftovers of any earlier run can be removed; the
 * fallback returns 127 (never 0) when no UDP feature is on, so a "-D" drain
 * loop stops at once. */
enum { UDPR_QUIC = 0, UDPR_DISCOVERY, UDPR_STUN, UDPR_PORTS };
static int iptables_udp_rule(const char *op, int which) {
  const char *ports, *u32 = NULL;
  switch (which) {
    case UDPR_QUIC:      ports = "443";         u32 = UDP_U32_QUIC_LONG; break;
    case UDPR_DISCOVERY: ports = UDP_PORTS_IPT; u32 = UDP_U32_DISCOVERY; break;
    case UDPR_STUN:      ports = UDP_PORTS_IPT; u32 = UDP_U32_STUN;      break;
    default:
      if (!g_udp_ports[0]) return 127;
      ports = g_udp_ports;
  }
  char q[16], mark[32];
  snprintf(q, sizeof(q), "%d", g_queue_num);
  snprintf(mark, sizeof(mark), "0x%x/0x%x", SHROUDLY_FWMARK, SHROUDLY_FWMARK);
  char *argv[32];
  int n = 0;
  char *head[] = { "iptables", "-w", "-t", "mangle", (char *)op, "OUTPUT", "-p", "udp",
                   "-m", "multiport", "--dports", (char *)ports };
  for (size_t i = 0; i < sizeof(head) / sizeof(head[0]); i++) argv[n++] = head[i];
  if (u32) { argv[n++] = "-m"; argv[n++] = "u32"; argv[n++] = "--u32"; argv[n++] = (char *)u32; }
  char *tail[] = { "-m", "mark", "!", "--mark", mark, "-j", "NFQUEUE", "--queue-num", q, "--queue-bypass" };
  for (size_t i = 0; i < sizeof(tail) / sizeof(tail[0]); i++) argv[n++] = tail[i];
  argv[n] = NULL;
  return run_quiet(argv);
}

/* Remove every rule of one UDP kind (at most a few left by crashed runs). */
static void iptables_udp_drain(int which) {
  for (int i = 0; i < 8 && iptables_udp_rule("-D", which) == 0; i++) {}
}

/* The UDP rules for the features that are on: the tested ones when the
 * kernel has u32, else the ports alone. Best effort: TCP works without any. */
static void iptables_udp_install(void) {
  g_udp_match = 0;
  if (!g_udp_ports[0]) return;
  int ok = 1;
  if (g_quic_block) ok = iptables_udp_rule("-I", UDPR_QUIC) == 0;
  if (ok && g_udp_fake) ok = iptables_udp_rule("-I", UDPR_DISCOVERY) == 0 && iptables_udp_rule("-I", UDPR_STUN) == 0;
  if (ok) { g_udp_match = 1; return; }
  for (int k = UDPR_QUIC; k <= UDPR_STUN; k++) iptables_udp_drain(k);
  iptables_udp_rule("-I", UDPR_PORTS);
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

/* tlsrec: every inbound TCP segment from 443, so its acknowledgement number can
 * be brought back for a connection whose ClientHello record we grew. */
static int ipt_in_all443(const char *op) {
  char q[16];
  snprintf(q, sizeof(q), "%d", g_queue_num);
  char *argv[] = { "iptables", "-w", "-t", "mangle", (char *)op, "INPUT", "-p", "tcp",
    "--sport", "443", "-j", "NFQUEUE", "--queue-num", q, "--queue-bypass", NULL };
  return run_quiet(argv);
}

/* INBOUND rule: queue inbound tcp from 443 whose payload starts 15 03 (a
 * plaintext TLS alert). u32 walks the IP and TCP header lengths to the first
 * payload bytes; a packet without payload never matches. */
static int ipt_alert(const char *op) {
  char q[16];
  snprintf(q, sizeof(q), "%d", g_queue_num);
  char *argv[] = { "iptables", "-w", "-t", "mangle", (char *)op, "INPUT", "-p", "tcp",
    "--sport", "443", "-m", "u32", "--u32", "0>>22&0x3C@12>>26&0x3C@0>>16=0x1503",
    "-j", "NFQUEUE", "--queue-num", q, "--queue-bypass", NULL };
  return run_quiet(argv);
}

/* OUTBOUND rule: queue other programs' DNS questions for the gate: UDP to
 * port 53, not to loopback (a local resolver's own upstream question is
 * queued instead), our own marked packets excluded. */
static int ipt_dns(const char *op) {
  char q[16], mark[32];
  snprintf(q, sizeof(q), "%d", g_queue_num);
  snprintf(mark, sizeof(mark), "0x%x/0x%x", SHROUDLY_FWMARK, SHROUDLY_FWMARK);
  char *argv[] = { "iptables", "-w", "-t", "mangle", (char *)op, "OUTPUT", "-p", "udp", "--dport", "53",
    "!", "-d", "127.0.0.0/8", "-m", "mark", "!", "--mark", mark,
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
  for (int k = UDPR_QUIC; k <= UDPR_PORTS; k++) iptables_udp_drain(k);
  for (int i = 0; i < 8 && ipt_in("-D", "RST", "RST") == 0; i++) {}
  for (int i = 0; i < 8 && ipt_in("-D", "SYN,ACK", "SYN,ACK") == 0; i++) {}
  for (int i = 0; i < 8 && ipt_in_all443("-D") == 0; i++) {}
  for (int i = 0; i < 8 && ipt_alert("-D") == 0; i++) {}
  for (int i = 0; i < 8 && ipt_dns("-D") == 0; i++) {}
}

static int install_rule(void) {
  build_udp_ports();
  ipt_clean_all();
  if (ipt_out("-I") == 0) {
    g_rule = RULE_IPTABLES;
    if (g_cfg.tlsrec)   ipt_in_all443("-I");      /* every inbound 443 segment, for ack translation */
    else {
      if (g_cfg.drop_rst) ipt_in("-I", "RST", "RST");
      if (g_cfg.autottl)  ipt_in("-I", "SYN,ACK", "SYN,ACK");
    }
    iptables_udp_install();                       /* best effort: TCP still works without it */
    g_alert_watch = ipt_alert("-I") == 0;         /* best effort: needs the u32 match */
    if (g_cfg.dns_gate > 0 && ipt_dns("-I") != 0) g_cfg.dns_gate = 0;
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
  if (g_cfg.dns_gate > 0) {
    snprintf(rule, sizeof(rule),
      "add rule ip shroudly out udp dport 53 ip daddr != 127.0.0.0/8 meta mark and 0x%x == 0 queue num %d bypass",
      SHROUDLY_FWMARK, g_queue_num);
    if (nft(rule) != 0) g_cfg.dns_gate = 0;
  }
  g_udp_match = 0;
  if (g_udp_ports[0]) {
    /* The tested rules first; should nft refuse one, the ports alone after
     * them (a datagram is queued by the first rule that takes it). Best
     * effort, like the iptables ones. */
    int ok = 1;
    if (g_quic_block) {
      snprintf(rule, sizeof(rule),
        "add rule ip shroudly out udp dport 443 " UDP_NFT_QUIC_LONG " meta mark and 0x%x == 0 queue num %d bypass",
        SHROUDLY_FWMARK, g_queue_num);
      ok = nft(rule) == 0;
    }
    if (ok && g_udp_fake) {
      snprintf(rule, sizeof(rule),
        "add rule ip shroudly out udp dport { " UDP_PORTS_NFT " } " UDP_NFT_DISCOVERY " meta mark and 0x%x == 0 queue num %d bypass",
        SHROUDLY_FWMARK, g_queue_num);
      ok = nft(rule) == 0;
      snprintf(rule, sizeof(rule),
        "add rule ip shroudly out udp dport { " UDP_PORTS_NFT " } " UDP_NFT_STUN " meta mark and 0x%x == 0 queue num %d bypass",
        SHROUDLY_FWMARK, g_queue_num);
      ok = ok && nft(rule) == 0;
    }
    if (ok) g_udp_match = 1;
    else {
      snprintf(rule, sizeof(rule),
        "add rule ip shroudly out udp dport { %s } meta mark and 0x%x == 0 queue num %d bypass",
        g_udp_nft, SHROUDLY_FWMARK, g_queue_num);
      nft(rule);
    }
  }
  if (nft("add chain ip shroudly in { type filter hook input priority -150 ; }") != 0) {
    if (g_cfg.drop_rst || g_cfg.autottl || g_cfg.tlsrec) { nft("delete table ip shroudly"); return -1; }
  } else if (g_cfg.tlsrec) {
    /* tlsrec: every inbound 443 segment, for acknowledgement translation. */
    snprintf(rule, sizeof(rule), "add rule ip shroudly in tcp sport 443 queue num %d bypass", g_queue_num);
    if (nft(rule) != 0) { nft("delete table ip shroudly"); return -1; }
    snprintf(rule, sizeof(rule), "add rule ip shroudly in tcp sport 80 @ih,0,16 0x1503 queue num %d bypass", g_queue_num);
    g_alert_watch = 1;   /* the 443 alerts come through the full rule above */
  } else {
    /* The TLS alert rule, best effort: the payload base (@ih) where nft and
     * the kernel know it, else the two usual TCP header lengths (20 bytes,
     * and 32 with timestamps) read from the TCP header base. */
    snprintf(rule, sizeof(rule), "add rule ip shroudly in tcp sport 443 @ih,0,16 0x1503 queue num %d bypass", g_queue_num);
    if (nft(rule) == 0) g_alert_watch = 1;
    else {
      snprintf(rule, sizeof(rule), "add rule ip shroudly in tcp sport 443 tcp doff 8 @th,256,16 0x1503 queue num %d bypass", g_queue_num);
      int a = nft(rule);
      snprintf(rule, sizeof(rule), "add rule ip shroudly in tcp sport 443 tcp doff 5 @th,160,16 0x1503 queue num %d bypass", g_queue_num);
      int b = nft(rule);
      g_alert_watch = a == 0 || b == 0;
    }
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
  g_alert_watch = 0;
  g_udp_match = 0;
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

/* Send the real first segment cut so that no segment carries the whole name.
 * Returns 1 when the parts went out (the original is replaced), 0 when there
 * is no name to cut or they cannot be built. */
static int send_cut(const struct iphdr *ip, const struct tcphdr *tcp,
                    const uint8_t *payload, int plen, const proto_info *pi, int disorder) {
  int otl = ip->ttl ? ip->ttl : 64;
  int cuts[2], nc = tcpdpi_split_points(payload, plen, pi->host_off, pi->host_len, cuts);
  tcpdpi_seg segs[3]; int ns = 0;
  if (nc > 0 && tcpdpi_build_multisplit4(segs, &ns, (const uint8_t *)ip, ip->ihl * 4,
                                         (const uint8_t *)tcp, tcp->doff * 4, g_ipid, ntohl(tcp->seq), otl,
                                         payload, plen, cuts, nc, disorder)) {
    g_ipid = (uint16_t)(g_ipid + ns);
    for (int i = 0; i < ns; i++) raw_send(segs[i].data, segs[i].len, ip->daddr, tcp->dest);
    return 1;
  }
  return 0;
}

/* Handle an outbound ClientHello / first request. decoy is 0 for a server in
 * the no-decoy table: then only the cut is sent. Returns 1 if the original
 * was consumed (caller must DROP it), 0 if it must be ACCEPTED unchanged. */
static int handle_outbound(const struct iphdr *ip, const struct tcphdr *tcp,
                           const uint8_t *payload, int plen, const proto_info *pi, int decoy) {
  int iphl = ip->ihl * 4, tcphl = tcp->doff * 4;
  const uint8_t *ip_tmpl = (const uint8_t *)ip;
  const uint8_t *tcp_tmpl = (const uint8_t *)tcp;
  uint32_t seq = ntohl(tcp->seq);
  int otl = ip->ttl ? ip->ttl : 64;
  int faked = g_cfg.desync_mode == RAW_DESYNC_FAKEDSPLIT || g_cfg.desync_mode == RAW_DESYNC_FAKEDDISORDER;

  /* tlsrec: split the ClientHello's TLS record into two records (for a DPI that
   * reassembles the TCP stream, issue #48). The split grows the segment by five
   * bytes, so the connection is entered in the translation table; its later
   * segments are shifted by judge(). If it cannot be built or tracked, fall
   * through to the TCP cut below. */
  if (g_cfg.tlsrec && pi->kind == PROTO_TLS && pi->host_off >= 1) {
    int cuts[2], nc = tcpdpi_split_points(payload, plen, pi->host_off, pi->host_len, cuts);
    int cut = nc >= 2 ? cuts[1] : (nc == 1 ? cuts[0] : 0);  /* mid-name where there is one */
    uint8_t out[2048];
    int n = cut > 5 ? tcpdpi_build_tlsrec4(out, sizeof out, ip_tmpl, iphl, tcp_tmpl, tcphl,
                                           g_ipid, seq, otl, payload, plen, cut) : 0;
    if (n > 0 && tcpdpi_xlate_begin(ip->saddr, ip->daddr, tcp->source, tcp->dest,
                                    seq + (uint32_t)plen, TCPDPI_TLSREC_GROWTH, now_ms())) {
      g_ipid++;
      if (decoy) send_fake(ip, tcp, payload, plen, pi, decoy_ttl_for(ip->daddr));
      raw_send(out, n, ip->daddr, tcp->dest);
      rawscope_count(RAWSCOPE_GROWN);
      return 1;                          /* the original is replaced by the grown record */
    }
  }

  if (!decoy) {
    /* Nothing the server could take for data: just the cut, in the order the
     * chosen technique would have used. */
    if (g_cfg.split == RAW_SPLIT_OFF && !faked) return 0;
    int disorder = g_cfg.split == RAW_SPLIT_DISORDER || g_cfg.desync_mode == RAW_DESYNC_FAKEDDISORDER;
    return send_cut(ip, tcp, payload, plen, pi, disorder);
  }

  int ttl = decoy_ttl_for(ip->daddr);
  if (faked) {
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
  if (g_cfg.split != RAW_SPLIT_OFF)
    return send_cut(ip, tcp, payload, plen, pi, g_cfg.split == RAW_SPLIT_DISORDER); /* 1: original replaced */
  return 0; /* accept the real packet unchanged */
}

/* Inject g_fake_repeats decoy UDP datagrams to the SAME 5-tuple ahead of the
 * real one (it waits in the queue until they are out): random payload of the
 * same length, valid checksums, and a TTL that should run out before the
 * server (the measured one when this address answered a TCP handshake lately,
 * else the fixed one). They carry SHROUDLY_FWMARK (SO_MARK on g_raw_fd), so
 * the NFQUEUE rule skips them. */
static void send_udp_decoys(const struct iphdr *ip, const struct udphdr *udp, int plen) {
  if (g_raw_fd < 0 || plen <= 0 || plen > 1400) return;
  uint8_t buf[1600];
  struct sockaddr_in dst;
  memset(&dst, 0, sizeof(dst));
  dst.sin_family = AF_INET;
  dst.sin_addr.s_addr = ip->daddr;
  dst.sin_port = udp->dest;
  uint32_t t = (uint32_t)now_ms();
  int ttl = decoy_ttl_for(ip->daddr);
  for (int i = 0; i < g_fake_repeats; i++) {
    uint16_t ipid = (uint16_t)(t + (uint32_t)i * 7u + 1u);
    uint32_t seed = ip->saddr ^ (ip->daddr << 1) ^ ((uint32_t)udp->source << 3) ^
                    ((uint32_t)udp->dest << 5) ^ (uint32_t)i * 2654435761u ^ t;
    int n = udp_build_decoy(buf, (int)sizeof(buf), ip->saddr, ip->daddr,
                            udp->source, udp->dest, plen, ttl, ipid, seed);
    if (n <= 0) break;
    if (sendto(g_raw_fd, buf, (size_t)n, 0, (struct sockaddr *)&dst, sizeof(dst)) == n)
      rawscope_count(RAWSCOPE_UDP_DECOYS);
  }
}

/* Does an alert come from as far away as the server's own SYN-ACK did? One
 * injected by a filter on the way arrives with a different hop count, and
 * must not switch the decoy off. Unknown distance: taken as the server's. */
static int alert_from_server(uint32_t key, int ttl) {
  int known = tcpdpi_hops_get(key, now_ms());
  int h = tcpdpi_hops_from_ttl(ttl);
  if (known <= 0 || h <= 0) return 1;
  return h - known <= 1 && known - h <= 1;
}

/* The system's DNS caches emptied (systemd-resolved's, nscd's): answers the
 * network's DNS forged before the gate was there would otherwise be handed to
 * programs from them, with no question for the gate to answer. 1 when one
 * was. */
static int flush_dns_cache(void) {
  char *resolvectl[] = { "resolvectl", "flush-caches", NULL };
  char *resolve[] = { "systemd-resolve", "--flush-caches", NULL };
  char *nscd[] = { "nscd", "-i", "hosts", NULL };
  int ok = run_quiet(resolvectl) == 0 || run_quiet(resolve) == 0;
  if (run_quiet(nscd) == 0) ok = 1;
  return ok;
}

/* What the DNS gate sends, from its own threads: an answer to the program
 * that asked (delivered locally), or its question sent on unchanged (with
 * the UDP checksum the kernel may have left to the network card). Through
 * the marked raw socket, so neither is queued again. */
static void gate_send(const uint8_t *pkt, int len, const void *meta, int inbound) {
  (void)meta;
  if (len < 28 || len > 4096 || (pkt[0] >> 4) != 4) return;
  uint8_t buf[4096];
  memcpy(buf, pkt, (size_t)len);
  if (!inbound) dnsgate_checksum(buf, len);
  int ihl = (buf[0] & 0x0f) * 4;
  uint32_t daddr; uint16_t dport;
  memcpy(&daddr, buf + 16, 4);
  memcpy(&dport, buf + ihl + 2, 2);
  raw_send(buf, len, daddr, dport);
}

/* What becomes of one queued packet: NF_ACCEPT or NF_DROP. */
/* judge already sent a mangled-packet verdict itself; on_packet sends none. */
#define NFQ_HANDLED 0xffffffffu

static uint32_t judge(const nfq_packet *q) {
  if (q->mark & SHROUDLY_FWMARK) return NF_ACCEPT;

  unsigned char *pkt = q->payload;
  int len = pkt ? q->len : 0;
  if (len < (int)sizeof(struct iphdr)) return NF_ACCEPT;

  struct iphdr *ip = (struct iphdr *)pkt;
  if (ip->version != 4) return NF_ACCEPT;
  int iphl = ip->ihl * 4;
  if (iphl < 20 || len < iphl) return NF_ACCEPT;

  if (ip->protocol == IPPROTO_TCP) {
    if (len < iphl + (int)sizeof(struct tcphdr)) return NF_ACCEPT;
    struct tcphdr *tcp = (struct tcphdr *)(pkt + iphl);
    int tcphl = tcp->doff * 4;
    if (tcphl < 20 || iphl + tcphl > len) return NF_ACCEPT;
    int sport = ntohs(tcp->source), dport = ntohs(tcp->dest);
    int web_src = (sport == 80 || sport == 443);
    int web_dst = (dport == 80 || dport == 443);

    /* Inbound (from a web port): the RST-drop, the SYN-ACK hop measurement and
     * the plaintext TLS alerts the INPUT rules queue. */
    if (web_src && !web_dst) {
      if (g_cfg.drop_rst && (tcp->rst) && tcpdpi_is_injected_rst4(pkt, len)) {
        /* Only from a server we desynced: any other host's reset passes. */
        if (rawscope_touched((const uint8_t *)&ip->saddr, 4, now_ms())) {
          rawscope_count(RAWSCOPE_RST_DROPPED);
          return NF_DROP;          /* forged: drop it */
        }
        rawscope_count(RAWSCOPE_RST_PASSED);
      }
      if (g_cfg.autottl && tcp->syn && tcp->ack) {
        int hops = tcpdpi_hops_from_ttl(ip->ttl);
        if (hops > 0) tcpdpi_hops_put(ip->saddr, hops, now_ms());
      }
      /* A plaintext TLS alert from a server whose ClientHello carried a
       * decoy: noted (no decoy next time), accepted unchanged. */
      if (sport == 443 && iphl + tcphl < len && alert_from_server(ip->saddr, ip->ttl))
        rawscope_decoy_hurt_in((const uint8_t *)&ip->saddr, 4, (uint16_t)sport, (uint16_t)dport,
                               pkt + iphl + tcphl, len - iphl - tcphl, now_ms());
      /* tlsrec: bring the acknowledgement back for a connection whose
       * ClientHello record we grew, and forget the connection when it ends. */
      if (g_cfg.tlsrec && tcp->ack) {
        uint32_t ack = ntohl(tcp->ack_seq);
        int changed = tcpdpi_xlate_in(ip->saddr, ip->daddr, tcp->source, tcp->dest, &ack, now_ms());
        if (tcp->fin || tcp->rst)   /* the stored tuple is the outbound one (client -> server) */
          tcpdpi_xlate_end(ip->daddr, ip->saddr, tcp->dest, tcp->source);
        if (changed) {
          tcp->ack_seq = htonl(ack);
          tcpdpi_refresh_csum4(pkt, len, iphl);
          nfq_verdict_mangle(g_nfq, (uint16_t)g_queue_num, q->id, NF_ACCEPT, pkt, len);
          return NFQ_HANDLED;
        }
      }
      return NF_ACCEPT;            /* everything else kept */
    }

    /* tlsrec: a later outbound segment on a connection whose ClientHello record
     * we grew sits five behind what the server expects; shift its sequence (and
     * forget the connection on its FIN/RST). The ClientHello itself is before
     * the growth, so it is left for handle_outbound below. */
    if (g_cfg.tlsrec) {
      uint32_t s = ntohl(tcp->seq);
      int changed = tcpdpi_xlate_out(ip->saddr, ip->daddr, tcp->source, tcp->dest, &s, now_ms());
      if (tcp->fin || tcp->rst) tcpdpi_xlate_end(ip->saddr, ip->daddr, tcp->source, tcp->dest);
      if (changed) {
        tcp->seq = htonl(s);
        tcpdpi_refresh_csum4(pkt, len, iphl);
        nfq_verdict_mangle(g_nfq, (uint16_t)g_queue_num, q->id, NF_ACCEPT, pkt, len);
        return NFQ_HANDLED;
      }
    }

    /* Outbound ClientHello / first request. */
    int poff = iphl + tcphl;
    int plen = len - poff;
    if (plen <= 0) return NF_ACCEPT;
    uint64_t now = now_ms();
    uint32_t seq = ntohl(tcp->seq);
    /* The client giving up on a handshake whose ClientHello carried a decoy:
     * noted, and the packet goes on unchanged below. */
    if (dport == 443)
      rawscope_decoy_hurt_out((const uint8_t *)&ip->daddr, 4, (uint16_t)dport, (uint16_t)sport,
                              seq, pkt + poff, plen, now);
    proto_info pi;
    proto_inspect(pkt + poff, (size_t)plen, &pi);
    if (pi.kind == PROTO_UNKNOWN) return NF_ACCEPT;
    /* The router, the LAN and other local hosts are left alone. */
    if (rawscope_local4((const uint8_t *)&ip->daddr)) {
      rawscope_count(RAWSCOPE_SKIPPED);
      return NF_ACCEPT;
    }
    rawscope_touch((const uint8_t *)&ip->daddr, 4, now);
    rawscope_count(RAWSCOPE_DESYNCED);
    int decoy = !rawscope_nodecoy((const uint8_t *)&ip->daddr, 4, now);
    if (!decoy) rawscope_count(RAWSCOPE_NODECOY);
    else if (pi.kind == PROTO_TLS)
      rawscope_decoy_sent((const uint8_t *)&ip->daddr, 4, (uint16_t)dport, (uint16_t)sport,
                          rawscope_tls_next_seq(seq, pkt + poff, plen), now);
    if (handle_outbound(ip, tcp, pkt + poff, plen, &pi, decoy))
      return NF_DROP;  /* replaced by our segments */
    return NF_ACCEPT;   /* real packet unchanged */
  }

  if (ip->protocol == IPPROTO_UDP) {
    if (len < iphl + (int)sizeof(struct udphdr)) return NF_ACCEPT;
    struct udphdr *udp = (struct udphdr *)(pkt + iphl);
    uint16_t dport_h = ntohs(udp->dest);

    /* A DNS question: the gate answers it, or sends it on itself. Not one of
     * the datagrams udp_seen counts (those the UDP features look at). */
    if (dport_h == 53) {
      static const uint8_t none = 0;
      if (g_gate && dnsgate_take(pkt, len, &none)) return NF_DROP;
      return NF_ACCEPT;
    }
    rawscope_count(RAWSCOPE_UDP_SEEN);
    int poff = iphl + (int)sizeof(struct udphdr);
    int plen = len - poff;
    const uint8_t *up = pkt + poff;
    int local = rawscope_local4((const uint8_t *)&ip->daddr);

    /* (1) QUIC: drop the Initial so the browser falls back to TCP (which the
     * proxy handles). Everything else on 443, and any QUIC to a local
     * address, is accepted unchanged. */
    if (g_quic_block && dport_h == 443) {
      if (plen > 0 && quic_is_initial(up, plen)) {
        if (!local) { rawscope_count(RAWSCOPE_QUIC_DROPPED); return NF_DROP; }
        rawscope_count(RAWSCOPE_SKIPPED);
      }
      return NF_ACCEPT;
    }

    /* (2) Discord voice / STUN: decoys ahead of the first datagrams of a flow,
     * never toward a local address; the real datagram is always accepted
     * unchanged. */
    if (g_udp_fake && discord_voice_port(dport_h) && plen > 0 && udp_is_discord_voice(up, plen)) {
      if (local) rawscope_count(RAWSCOPE_SKIPPED);
      else if (udp_flow_note(&g_flows, ip->saddr, udp->source, ip->daddr, udp->dest, (uint32_t)now_ms()))
        send_udp_decoys(ip, udp, plen);
    }
    return NF_ACCEPT;
  }

  return NF_ACCEPT;
}

static void on_packet(const nfq_packet *q, void *ud) {
  (void)ud;
  uint32_t v = judge(q);
  if (v != NFQ_HANDLED)                 /* judge gave a mangled packet its own verdict */
    nfq_verdict(g_nfq, (uint16_t)g_queue_num, q->id, v);
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
  tcpdpi_xlate_reset();
  rawscope_touch_reset();
  rawscope_nodecoy_reset();

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

  g_nfq = nfq_open_queue((uint16_t)queue_num, 0xffff);
  if (g_nfq < 0) { fprintf(stderr, "could not open the packet queue: %s\n", strerror(errno)); return -1; }
  if (install_rule() != 0) {
    fprintf(stderr, "could not install the NFQUEUE rule (need iptables or nft)\n");
    return -1;
  }

  g_gate = g_cfg.dns_gate > 0 && dnsgate_start(g_cfg.dns_gate, gate_send, 0) == 0;
  int flushed = g_gate && flush_dns_cache();
  g_run = 1;
  int fd = g_nfq;
  /* A whole packet (up to the 64 KB copied) and its headers, at once. */
  static uint8_t buf[65536 + 4096] __attribute__((aligned));
  printf("{\"type\":\"raw_ready\",\"queue\":%d,\"ttl\":%d,\"drop_rst\":%d,\"autottl\":%d,\"seqovl\":%d,\"split\":%d,\"mode\":%d,\"quic_block\":%d,\"udp_fake\":%d,\"alert_watch\":%d,\"udp_match\":%d,\"dns_gate\":%d,\"dns_flushed\":%d,\"tlsrec\":%d}\n",
         queue_num, g_cfg.fake_ttl, g_cfg.drop_rst, g_cfg.autottl, g_cfg.seqovl, g_cfg.split, g_cfg.desync_mode, g_quic_block, g_udp_fake, g_alert_watch, g_udp_match, g_gate, flushed, g_cfg.tlsrec);
  fflush(stdout);
  while (g_run) {
    int rv = recv(fd, buf, sizeof(buf), 0);
    if (rv >= 0) { nfq_parse(buf, (size_t)rv, on_packet, NULL); continue; }
    if (errno == ENOBUFS) continue;      /* dropped under load; keep going */
    if (errno == EINTR) continue;
    break;
  }
  return 0;
}

void raw_linux_stop(void) {
  g_run = 0;
  if (g_gate) { dnsgate_stop(); g_gate = 0; }
  raw_linux_teardown();
  if (g_nfq >= 0) { nfq_close_queue(g_nfq, (uint16_t)g_queue_num); g_nfq = -1; }
  if (g_raw_fd >= 0) { close(g_raw_fd); g_raw_fd = -1; }
}

#endif /* __linux__ */
#endif /* SHROUDLY_RAW */
