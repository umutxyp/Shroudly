/*
 * raw_windows.c — ADVANCED (packet-layer) desync backend for Windows.
 *
 * Counterpart of raw_linux.c. Uses WinDivert 2.2 (a signed kernel driver) to
 * intercept the first outbound TLS/HTTP data packet and, by configuration:
 *   - inject a low-TTL / bad-checksum FAKE copy (scrambled SNI) that reaches the
 *     DPI but dies before the server, then re-inject the real packet unchanged;
 *   - sequence-overlap the real first segment (split-seqovl); or
 *   - send it as fakedsplit / fakeddisorder.
 * It also captures INBOUND 80/443 segments to DROP the forged RSTs a censor
 * injects to tear a blocked connection down, and to measure the hop distance to
 * the server from the SYN-ACK TTL for the decoy's TTL.
 *
 * Traffic to a local, private or special address is never changed, and a
 * reset is only dropped from a server this engine recently desynced
 * (rawscope.h). A server the decoy itself reaches and upsets (a TLS alert
 * right after a decoyed ClientHello, either way) gets no more decoys for a
 * while, only the cut (rawscope.h, "no decoy").
 *
 * This defeats stateful DPI (Iran/China) and the inbound-RST teardown Turkish
 * networks (Türk Telekom, Turkcell) use, which the userspace engine cannot.
 *
 * Compiled only when SHROUDLY_RAW is defined, on Windows. Links against
 * WinDivert.dll (and needs WinDivert.sys + WinDivert64.sys present at runtime).
 * Requires Administrator (the driver loads on first open).
 *
 * The x64 Windows package ships WinDivert.dll + WinDivert64.sys next to
 * shroudly-core-adv.exe (scripts/fetch-windivert.js). WinDivert has no ARM64
 * build. If the driver cannot load, the backend reports an error and the app
 * falls back to the default engine.
 */
#ifdef SHROUDLY_RAW
#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "proto.h"
#include "udpdpi.h"
#include "platform.h"
#include "raw_windows.h"
#include "raw_desync.h"
#include "tcpdpi.h"
#include "rawscope.h"

/* ── Minimal WinDivert 2.2 declarations (avoid needing the SDK header) ───────
 * Must match include/windivert.h of the bundled release byte for byte. */
typedef struct {
  INT64  Timestamp;
  UINT32 Layer:8;
  UINT32 Event:8;
  UINT32 Sniffed:1;
  UINT32 Outbound:1;
  UINT32 Loopback:1;
  UINT32 Impostor:1;
  UINT32 IPv6:1;
  UINT32 IPChecksum:1;
  UINT32 TCPChecksum:1;
  UINT32 UDPChecksum:1;
  UINT32 Reserved1:8;
  UINT32 Reserved2;
  union {
    struct { UINT32 IfIdx; UINT32 SubIfIdx; } Network;
    UINT8 Reserved3[64];
  };
} WINDIVERT_ADDRESS; /* 80 bytes */

#define WINDIVERT_LAYER_NETWORK 0
#define WINDIVERT_HELPER_NO_REPLACE 0

typedef HANDLE (*PFN_Open)(const char*, int, INT16, UINT64);
typedef BOOL   (*PFN_Recv)(HANDLE, void*, UINT, UINT*, WINDIVERT_ADDRESS*);
typedef BOOL   (*PFN_Send)(HANDLE, const void*, UINT, UINT*, const WINDIVERT_ADDRESS*);
typedef BOOL   (*PFN_Close)(HANDLE);
typedef BOOL   (*PFN_Shutdown)(HANDLE, int);
typedef BOOL   (*PFN_CalcCsum)(void*, UINT, const WINDIVERT_ADDRESS*, UINT64);

static PFN_Open     p_Open;
static PFN_Recv     p_Recv;
static PFN_Send     p_Send;
static PFN_Close    p_Close;
static PFN_Shutdown p_Shutdown;
static PFN_CalcCsum p_CalcCsum;

static HANDLE g_handle = INVALID_HANDLE_VALUE;
static volatile int g_run = 0;
static int g_quic_block = 1;      /* drop QUIC Initial -> browsers fall to TCP */
static int g_udp_fake = 1;        /* decoys ahead of Discord voice datagrams */
static int g_fake_repeats = 6;    /* decoy datagrams per voice flow */
static udp_flow_table g_flows;    /* first-N-per-flow bookkeeping */
static raw_config g_cfg;
static int g_alert_watch = 0;     /* 1: inbound plaintext TLS alerts are captured */
static uint16_t g_ipid = 0x1000; /* rolling IP id for our crafted segments */

static uint32_t rd32be(const uint8_t *p) {
  return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3];
}

static int load_windivert(void) {
  HMODULE m = LoadLibraryA("WinDivert.dll");
  if (!m) { fprintf(stderr, "WinDivert.dll not found\n"); return -1; }
  p_Open     = (PFN_Open)    GetProcAddress(m, "WinDivertOpen");
  p_Recv     = (PFN_Recv)    GetProcAddress(m, "WinDivertRecv");
  p_Send     = (PFN_Send)    GetProcAddress(m, "WinDivertSend");
  p_Close    = (PFN_Close)   GetProcAddress(m, "WinDivertClose");
  p_Shutdown = (PFN_Shutdown)GetProcAddress(m, "WinDivertShutdown");
  p_CalcCsum = (PFN_CalcCsum)GetProcAddress(m, "WinDivertHelperCalcChecksums");
  if (!p_Open || !p_Recv || !p_Send || !p_Close || !p_CalcCsum) {
    fprintf(stderr, "WinDivert.dll missing exports\n"); return -1;
  }
  return 0;
}

/* Inject one of our crafted IPv4 segments (checksums already computed). Mirror
 * the captured outbound address but mark the checksums present so the stack
 * does not recompute (and overwrite a deliberately bad one). */
static void raw_send(const uint8_t *seg, int len, const WINDIVERT_ADDRESS *base) {
  if (len <= 0) return;
  WINDIVERT_ADDRESS a = *base;
  a.Outbound = 1;
  a.IPv6 = 0;
  a.IPChecksum = 1;
  a.TCPChecksum = 1;
  UINT sent = 0;
  p_Send(g_handle, seg, (UINT)len, &sent, &a);
}

/* Inject g_fake_repeats decoy UDP datagrams to the SAME 5-tuple: random
 * payload of the same length, low TTL, valid checksums. WinDivert injects via
 * WFP and tags its own packets, so these are never re-captured (no loop). */
static void send_udp_decoys(uint32_t saddr, uint32_t daddr, uint16_t sportn,
                            uint16_t dportn, int plen, const WINDIVERT_ADDRESS *addr) {
  if (plen <= 0 || plen > 1400) return;
  uint8_t buf[1600];
  WINDIVERT_ADDRESS a = *addr;
  uint32_t tick = (uint32_t)GetTickCount();
  for (int i = 0; i < g_fake_repeats; i++) {
    uint16_t ipid = (uint16_t)(tick + (uint32_t)i * 7u + 1u);
    uint32_t seed = saddr ^ (daddr << 1) ^ ((uint32_t)sportn << 3) ^
                    ((uint32_t)dportn << 5) ^ (uint32_t)i * 2654435761u ^ tick;
    int n = udp_build_decoy(buf, (int)sizeof(buf), saddr, daddr, sportn, dportn,
                            plen, g_cfg.fake_ttl, ipid, seed);
    if (n <= 0) break;
    UINT s = 0;
    p_Send(g_handle, buf, (UINT)n, &s, &a);
  }
}

/* Send the scrambled-SNI decoy with the effective (autottl or fixed) TTL. */
static void send_fake(const uint8_t *pkt, int len, int ihl, int tcphl, int poff,
                      const proto_info *pi, int ttl, const WINDIVERT_ADDRESS *addr) {
  int plen = len - poff;
  if (plen <= 0 || plen > 1500) return;
  uint8_t pay[1600];
  memcpy(pay, pkt + poff, (size_t)plen);
  if (pi->host_off >= 0 && pi->host_off + pi->host_len <= plen) {
    for (int i = pi->host_off; i < pi->host_off + pi->host_len; i++) pay[i] ^= 0x5a;
  } else {
    for (int i = plen / 3; i < plen; i++) pay[i] ^= 0x5a;
  }
  uint8_t out[1600];
  uint32_t seq = rd32be(pkt + ihl + 4);
  int eff = ttl > 0 ? ttl : g_cfg.fake_ttl;
  int n = tcpdpi_build_segment4(out, sizeof out, pkt, ihl, pkt + ihl, tcphl,
                                g_ipid++, seq, eff, pay, plen, 1 /* bad checksum */);
  if (n > 0) raw_send(out, n, addr);
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

/* Effective decoy TTL for a destination IPv4 address (network order). */
static int decoy_ttl_for(uint32_t daddr) {
  if (g_cfg.autottl) {
    int hops = tcpdpi_hops_get(daddr, now_ms());
    if (hops > 0) return tcpdpi_decoy_ttl(hops, g_cfg.autottl_margin, g_cfg.autottl_min);
  }
  return g_cfg.fake_ttl;
}

/* Send the real first segment cut so that no segment carries the whole name.
 * Returns 1 when the parts went out (the original is consumed), 0 when there
 * is no name to cut or they cannot be built. */
static int send_cut(const uint8_t *pkt, int ihl, int tcphl, int poff, int plen,
                    const proto_info *pi, int disorder, const WINDIVERT_ADDRESS *addr) {
  uint32_t seq = rd32be(pkt + ihl + 4);
  int otl = pkt[8] ? pkt[8] : 64;
  int cuts[2], nc = tcpdpi_split_points(pkt + poff, plen, pi->host_off, pi->host_len, cuts);
  tcpdpi_seg segs[3]; int ns = 0;
  if (nc > 0 && tcpdpi_build_multisplit4(segs, &ns, pkt, ihl, pkt + ihl, tcphl, g_ipid, seq, otl,
                                         pkt + poff, plen, cuts, nc, disorder)) {
    g_ipid = (uint16_t)(g_ipid + ns);
    for (int i = 0; i < ns; i++) raw_send(segs[i].data, segs[i].len, addr);
    return 1;
  }
  return 0;
}

/* Handle an outbound ClientHello / first request. decoy is 0 for a server in
 * the no-decoy table: then only the cut is sent. Returns 1 if the original
 * was consumed (do not re-inject it), 0 if it must be re-injected unchanged. */
static int handle_outbound(const uint8_t *pkt, int len, int ihl, int tcphl, int poff,
                           const proto_info *pi, int decoy, const WINDIVERT_ADDRESS *addr) {
  int plen = len - poff;
  uint32_t daddr = rd32be(pkt + 16);
  uint32_t seq = rd32be(pkt + ihl + 4);
  int otl = pkt[8] ? pkt[8] : 64;
  int faked = g_cfg.desync_mode == RAW_DESYNC_FAKEDSPLIT || g_cfg.desync_mode == RAW_DESYNC_FAKEDDISORDER;

  if (!decoy) {
    /* Nothing the server could take for data: just the cut, in the order the
     * chosen technique would have used. */
    if (g_cfg.split == RAW_SPLIT_OFF && !faked) return 0;
    int disorder = g_cfg.split == RAW_SPLIT_DISORDER || g_cfg.desync_mode == RAW_DESYNC_FAKEDDISORDER;
    return send_cut(pkt, ihl, tcphl, poff, plen, pi, disorder, addr);
  }

  int ttl = decoy_ttl_for(daddr);
  if (faked) {
    int split = (pi->host_off > 0 && pi->host_off < plen) ? pi->host_off : (plen > 2 ? 2 : 1);
    tcpdpi_seg segs[3]; int ns = 0;
    if (tcpdpi_build_fakedsplit4(segs, &ns, pkt, ihl, pkt + ihl, tcphl, g_ipid, seq, otl,
                                 pkt + poff, plen, split, ttl, g_cfg.fake_pattern,
                                 g_cfg.desync_mode == RAW_DESYNC_FAKEDDISORDER)) {
      g_ipid += 3;
      for (int i = 0; i < ns; i++) raw_send(segs[i].data, segs[i].len, addr);
      return 1;
    }
    return 0;
  }

  /* The proven decoy, then the real packet ... */
  send_fake(pkt, len, ihl, tcphl, poff, pi, ttl, addr);
  if (g_cfg.seqovl > 0 && plen > 0) {
    uint8_t out[1600];
    int n = tcpdpi_build_seqovl4(out, sizeof out, pkt, ihl, pkt + ihl, tcphl, g_ipid,
                                 seq, otl, pkt + poff, plen, g_cfg.seqovl, g_cfg.seqovl_pattern);
    if (n > 0) { g_ipid++; raw_send(out, n, addr); return 1; }
  }
  /* ... and the real one cut, so no segment carries the whole name: a filter
   * the decoy does not fool still never reads it. Left whole when there is no
   * name to cut or the parts cannot be built. */
  if (g_cfg.split != RAW_SPLIT_OFF)
    return send_cut(pkt, ihl, tcphl, poff, plen, pi, g_cfg.split == RAW_SPLIT_DISORDER, addr);
  return 0;
}

int raw_windows_start(const raw_config *cfg) {
  g_cfg = *cfg;
  if (g_cfg.fake_ttl <= 0) g_cfg.fake_ttl = 4;
  g_quic_block = g_cfg.quic_block ? 1 : 0;
  g_udp_fake = g_cfg.udp_fake ? 1 : 0;
  g_fake_repeats = (g_cfg.fake_repeats > 0 && g_cfg.fake_repeats <= 64) ? g_cfg.fake_repeats : 6;
  udp_flow_init(&g_flows);
  tcpdpi_hops_reset();
  rawscope_touch_reset();
  rawscope_nodecoy_reset();
  if (load_windivert() != 0) return -1;

  /* Keep the kernel filter as narrow as the language allows — port + proto —
   * and classify payloads in code:
   *   - outbound TCP 80/443 with payload (the decoy / desync path);
   *   - outbound UDP 443 for QUIC Initial (dropped so browsers fall back to TCP);
   *   - outbound UDP on Discord voice / STUN ports (decoys ahead of the first datagrams);
   *   - inbound TCP RST and SYN-ACK from 80/443 (the RST-drop, the hop measurement);
   *   - inbound TCP from 443 whose payload starts 15 03: a plaintext TLS alert,
   *     the sign that a decoy reached the server and broke the handshake.
   * Each clause is added only for the features that are on. IPv6 outbound is
   * re-injected unchanged by the loop below (this backend builds IPv4 fakes). */
  char filter[1024];
  char ports[256]; ports[0] = 0;
  if (g_quic_block) snprintf(ports, sizeof(ports), "udp.DstPort == 443");
  if (g_udp_fake) {
    const char *dports = "udp.DstPort == 3478 or (udp.DstPort >= 19302 and udp.DstPort <= 19309) or udp.DstPort >= 50000";
    if (ports[0]) { char tmp[256]; snprintf(tmp, sizeof(tmp), "%s or %s", ports, dports); snprintf(ports, sizeof(ports), "%s", tmp); }
    else snprintf(ports, sizeof(ports), "%s", dports);
  }
  int off = snprintf(filter, sizeof(filter),
    "(outbound and ip and tcp and (tcp.DstPort == 443 or tcp.DstPort == 80) and tcp.PayloadLength > 0)");
  if (ports[0])
    off += snprintf(filter + off, sizeof(filter) - off, " or (outbound and ip and udp and (%s))", ports);
  int base = off;
  for (int watch = 1; watch >= 0; watch--) {
    char sub[256]; sub[0] = 0; int so = 0;
    if (g_cfg.drop_rst) so += snprintf(sub + so, sizeof(sub) - so, "tcp.Rst");
    if (g_cfg.autottl)  so += snprintf(sub + so, sizeof(sub) - so, "%s(tcp.Syn and tcp.Ack)", so ? " or " : "");
    if (watch)
      so += snprintf(sub + so, sizeof(sub) - so,
        "%s(tcp.SrcPort == 443 and tcp.PayloadLength >= 7 and tcp.Payload[0] == 21 and tcp.Payload[1] == 3)",
        so ? " or " : "");
    off = base; filter[off] = 0;
    if (sub[0])
      snprintf(filter + off, sizeof(filter) - off,
        " or (inbound and tcp and (tcp.SrcPort == 443 or tcp.SrcPort == 80) and (%s))", sub);
    g_handle = p_Open(filter, WINDIVERT_LAYER_NETWORK, 0, 0);
    if (g_handle != INVALID_HANDLE_VALUE) { g_alert_watch = watch; break; }
    /* Should the payload test ever be refused, open without it: the
     * outbound signs of harm still work. */
  }
  if (g_handle == INVALID_HANDLE_VALUE) {
    fprintf(stderr, "WinDivertOpen failed (%lu). Run as Administrator.\n", (unsigned long)GetLastError());
    return -1;
  }

  g_run = 1;
  printf("{\"type\":\"raw_ready\",\"backend\":\"windivert\",\"ttl\":%d,\"drop_rst\":%d,\"autottl\":%d,\"seqovl\":%d,\"split\":%d,\"mode\":%d,\"quic_block\":%d,\"udp_fake\":%d,\"alert_watch\":%d}\n",
         g_cfg.fake_ttl, g_cfg.drop_rst, g_cfg.autottl, g_cfg.seqovl, g_cfg.split, g_cfg.desync_mode, g_quic_block, g_udp_fake, g_alert_watch);
  fflush(stdout);

  uint8_t pkt[65535];
  WINDIVERT_ADDRESS addr;
  while (g_run) {
    UINT len = 0;
    if (!p_Recv(g_handle, pkt, sizeof(pkt), &len, &addr)) {
      if (GetLastError() == ERROR_NO_DATA) break; /* shutdown */
      continue;
    }
    /* Anything we cannot safely classify is re-injected unchanged. */
    if (len < 28) { UINT s; p_Send(g_handle, pkt, len, &s, &addr); continue; }

    /* ── Inbound: RST-drop and SYN-ACK hop measurement ───────────────────── */
    /* A reset is only dropped from a server we desynced (rawscope_touched);
     * any other host's reset passes, whatever it looks like. */
    if (!addr.Outbound) {
      if (addr.IPv6) {
        if (g_cfg.drop_rst && tcpdpi_is_injected_rst6(pkt, (int)len)) {
          if (rawscope_touched(pkt + 8, 16, now_ms())) { rawscope_count(RAWSCOPE_RST_DROPPED); continue; }
          rawscope_count(RAWSCOPE_RST_PASSED);
        }
        UINT s; p_Send(g_handle, pkt, len, &s, &addr); continue;
      }
      int ihl = (pkt[0] & 0x0f) * 4;
      if (ihl >= 20 && (int)len >= ihl + 20) {
        const uint8_t *tcp = pkt + ihl;
        if (g_cfg.drop_rst && (tcp[13] & 0x04) && tcpdpi_is_injected_rst4(pkt, (int)len)) {
          if (rawscope_touched(pkt + 12, 4, now_ms())) {
            rawscope_count(RAWSCOPE_RST_DROPPED);
            continue;                                 /* forged RST: drop it */
          }
          rawscope_count(RAWSCOPE_RST_PASSED);
        }
        if (g_cfg.autottl && (tcp[13] & 0x02) && (tcp[13] & 0x10)) { /* SYN+ACK */
          int hops = tcpdpi_hops_from_ttl(pkt[8]);
          if (hops > 0) tcpdpi_hops_put(rd32be(pkt + 12), hops, now_ms());
        }
        /* A plaintext TLS alert from a server whose ClientHello carried a
         * decoy: noted (no decoy next time), passed on unchanged. */
        int tcphl = ((tcp[12] >> 4) & 0x0f) * 4;
        uint16_t sport = (uint16_t)((tcp[0] << 8) | tcp[1]);
        if (sport == 443 && tcphl >= 20 && ihl + tcphl < (int)len &&
            alert_from_server(rd32be(pkt + 12), pkt[8]))
          rawscope_decoy_hurt_in(pkt + 12, 4, sport, (uint16_t)((tcp[2] << 8) | tcp[3]),
                                 pkt + ihl + tcphl, (int)len - ihl - tcphl, now_ms());
      }
      UINT s; p_Send(g_handle, pkt, len, &s, &addr); continue; /* kept unchanged */
    }

    /* ── Outbound ───────────────────────────────────────────────────────── */
    if (addr.IPv6) { UINT s; p_Send(g_handle, pkt, len, &s, &addr); continue; }
    int ihl = (pkt[0] & 0x0f) * 4;
    if (ihl < 20 || (int)len < ihl) { UINT s; p_Send(g_handle, pkt, len, &s, &addr); continue; }
    int proto = pkt[9];

    if (proto == 17 /* UDP */) {
      if ((int)len < ihl + 8) { UINT s; p_Send(g_handle, pkt, len, &s, &addr); continue; }
      int poff = ihl + 8;
      int plen = (int)len - poff;
      const uint8_t *up = pkt + poff;
      uint16_t dport_h = (uint16_t)((pkt[ihl + 2] << 8) | pkt[ihl + 3]);
      int local = rawscope_local4(pkt + 16);

      /* (1) QUIC: drop the Initial so the browser falls back to TCP. Everything
       * else on 443 (Version Negotiation, short-header, non-QUIC), and any QUIC
       * to a local address, re-injects. */
      if (g_quic_block && dport_h == 443) {
        if (plen > 0 && quic_is_initial(up, plen)) {
          if (!local) continue;                       /* DROP, no re-inject */
          rawscope_count(RAWSCOPE_SKIPPED);
        }
        UINT s = 0; p_Send(g_handle, pkt, len, &s, &addr);
        continue;
      }

      /* (2) Discord voice / STUN: decoys ahead of the first datagrams only,
       * never toward a local address. */
      if (g_udp_fake && discord_voice_port(dport_h) && plen > 0 && udp_is_discord_voice(up, plen)) {
        if (local) { rawscope_count(RAWSCOPE_SKIPPED); UINT s = 0; p_Send(g_handle, pkt, len, &s, &addr); continue; }
        uint32_t saddr, daddr; uint16_t sportn, dportn;
        memcpy(&saddr, pkt + 12, 4);
        memcpy(&daddr, pkt + 16, 4);
        memcpy(&sportn, pkt + ihl + 0, 2);
        memcpy(&dportn, pkt + ihl + 2, 2);
        if (udp_flow_note(&g_flows, saddr, sportn, daddr, dportn, (uint32_t)GetTickCount()))
          send_udp_decoys(saddr, daddr, sportn, dportn, plen, &addr);
      }
      /* real datagram always re-injected unchanged */
      UINT s = 0; p_Send(g_handle, pkt, len, &s, &addr);
      continue;
    }

    /* TCP: the decoy / desync. Any other protocol is re-injected unchanged. */
    if (proto != 6 || (int)len < ihl + 20) { UINT s; p_Send(g_handle, pkt, len, &s, &addr); continue; }
    int tcphl = ((pkt[ihl + 12] >> 4) & 0x0f) * 4;
    if (tcphl < 20 || ihl + tcphl > (int)len) { UINT s; p_Send(g_handle, pkt, len, &s, &addr); continue; }
    int poff = ihl + tcphl;
    int plen = (int)len - poff;

    int handled = 0;
    if (plen > 0) {
      uint64_t now = now_ms();
      uint16_t sport = (uint16_t)((pkt[ihl] << 8) | pkt[ihl + 1]);
      uint16_t dport = (uint16_t)((pkt[ihl + 2] << 8) | pkt[ihl + 3]);
      uint32_t seq = rd32be(pkt + ihl + 4);
      /* The client giving up on a handshake whose ClientHello carried a
       * decoy: noted, and the packet goes on unchanged below. */
      if (dport == 443) rawscope_decoy_hurt_out(pkt + 16, 4, dport, sport, seq, pkt + poff, plen, now);
      proto_info pi;
      proto_inspect(pkt + poff, (size_t)plen, &pi);
      if (pi.kind != PROTO_UNKNOWN) {
        if (rawscope_local4(pkt + 16)) {
          rawscope_count(RAWSCOPE_SKIPPED);  /* the router, the LAN, local hosts: left alone */
          UINT s = 0; p_Send(g_handle, pkt, len, &s, &addr); continue;
        }
        rawscope_touch(pkt + 16, 4, now);
        rawscope_count(RAWSCOPE_DESYNCED);
        int decoy = !rawscope_nodecoy(pkt + 16, 4, now);
        if (!decoy) rawscope_count(RAWSCOPE_NODECOY);
        else if (pi.kind == PROTO_TLS)
          rawscope_decoy_sent(pkt + 16, 4, dport, sport, rawscope_tls_next_seq(seq, pkt + poff, plen), now);
        handled = handle_outbound(pkt, (int)len, ihl, tcphl, poff, &pi, decoy, &addr);
      }
    }
    if (!handled) { UINT s = 0; p_Send(g_handle, pkt, len, &s, &addr); } /* real packet */
  }

  return 0;
}

void raw_windows_stop(void) {
  g_run = 0;
  if (g_handle != INVALID_HANDLE_VALUE) {
    if (p_Shutdown) p_Shutdown(g_handle, 0x1 /*WINDIVERT_SHUTDOWN_RECV*/);
    p_Close(g_handle);
    g_handle = INVALID_HANDLE_VALUE;
  }
}

#endif /* _WIN32 */
#endif /* SHROUDLY_RAW */
