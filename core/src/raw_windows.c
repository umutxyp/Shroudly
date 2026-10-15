/*
 * raw_windows.c — ADVANCED (packet-layer) desync backend for Windows.
 *
 * Counterpart of raw_linux.c. Uses WinDivert 2.2 (a signed kernel driver) to
 * intercept the first outbound TLS/HTTP data packet, inject a low-TTL / bad-
 * checksum FAKE copy (scrambled SNI) that reaches the DPI but dies before the
 * server, then re-inject the real packet unchanged.
 *
 * This defeats stateful DPI (Iran/China) that reassembles the TCP stream and so
 * is immune to the userspace split/disorder engine.
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
#include "raw_windows.h"

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
static int g_fake_ttl = 4;
static int g_quic_block = 1;      /* drop QUIC Initial -> browsers fall to TCP */
static int g_udp_fake = 1;        /* decoys ahead of Discord voice datagrams */
static int g_fake_repeats = 6;    /* decoy datagrams per voice flow */
static udp_flow_table g_flows;    /* first-N-per-flow bookkeeping */

/* IPv4 header: ttl at offset 8; TCP header starts at ihl*4. */
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

static void send_fake(const uint8_t *pkt, UINT len, const WINDIVERT_ADDRESS *addr,
                      const proto_info *pi, int poff) {
  if (len > 2048) return;
  uint8_t buf[2048];
  memcpy(buf, pkt, len);

  /* IPv4 only for the fake (v6 handled by caller gating). ihl low nibble. */
  int ihl = (buf[0] & 0x0f) * 4;
  buf[8] = (uint8_t)g_fake_ttl;             /* TTL */

  int plen = (int)len - poff;
  uint8_t *fp = buf + poff;
  if (pi->host_off >= 0 && pi->host_off + pi->host_len <= plen) {
    for (int i = pi->host_off; i < pi->host_off + pi->host_len; i++) fp[i] ^= 0x5a;
  } else if (plen > 0) {
    for (int i = plen / 3; i < plen; i++) fp[i] ^= 0x5a;
  }

  /* Recalc IP checksum (good) but corrupt TCP checksum so the server drops it.
   * WinDivertHelperCalcChecksums fixes both; we then flip the TCP checksum. */
  WINDIVERT_ADDRESS a = *addr;
  p_CalcCsum(buf, len, &a, WINDIVERT_HELPER_NO_REPLACE);
  int tcp_csum_off = ihl + 16;
  if (tcp_csum_off + 1 < (int)len) {
    buf[tcp_csum_off] ^= 0xff;
    buf[tcp_csum_off + 1] ^= 0xff;
  }

  UINT sent = 0;
  p_Send(g_handle, buf, len, &sent, &a);
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
                            plen, g_fake_ttl, ipid, seed);
    if (n <= 0) break;
    UINT s = 0;
    p_Send(g_handle, buf, (UINT)n, &s, &a);
  }
}

int raw_windows_start(int fake_ttl, int quic_block, int udp_fake, int fake_repeats) {
  g_fake_ttl = fake_ttl > 0 ? fake_ttl : 4;
  g_quic_block = quic_block ? 1 : 0;
  g_udp_fake = udp_fake ? 1 : 0;
  g_fake_repeats = (fake_repeats > 0 && fake_repeats <= 64) ? fake_repeats : 6;
  udp_flow_init(&g_flows);
  if (load_windivert() != 0) return -1;

  /* Keep the kernel filter as narrow as the language allows — port + proto —
   * and classify payloads in code. Outbound IPv4 only (IPv6 is re-injected
   * unchanged by the loop below, since this backend builds IPv4 fakes only):
   *   - TCP 80/443 with payload (the TLS/HTTP decoy path, unchanged);
   *   - UDP 443 for QUIC Initial (dropped so browsers fall back to TCP);
   *   - UDP on Discord voice / STUN ports (decoys ahead of the first datagrams).
   * The UDP clauses are added only for the features that are on. */
  char filter[512];
  char udpf[384]; udpf[0] = 0;
  char ports[256]; ports[0] = 0;
  if (g_quic_block) snprintf(ports, sizeof(ports), "udp.DstPort == 443");
  if (g_udp_fake) {
    const char *dports = "udp.DstPort == 3478 or (udp.DstPort >= 19302 and udp.DstPort <= 19309) or udp.DstPort >= 50000";
    if (ports[0]) { char tmp[256]; snprintf(tmp, sizeof(tmp), "%s or %s", ports, dports); snprintf(ports, sizeof(ports), "%s", tmp); }
    else snprintf(ports, sizeof(ports), "%s", dports);
  }
  if (ports[0]) snprintf(udpf, sizeof(udpf), " or (udp and (%s))", ports);
  snprintf(filter, sizeof(filter),
    "outbound and ip and ((tcp and (tcp.DstPort == 443 or tcp.DstPort == 80) and tcp.PayloadLength > 0)%s)",
    udpf);
  g_handle = p_Open(filter, WINDIVERT_LAYER_NETWORK, 0, 0);
  if (g_handle == INVALID_HANDLE_VALUE) {
    fprintf(stderr, "WinDivertOpen failed (%lu). Run as Administrator.\n", (unsigned long)GetLastError());
    return -1;
  }

  g_run = 1;
  printf("{\"type\":\"raw_ready\",\"backend\":\"windivert\",\"ttl\":%d,\"quic_block\":%d,\"udp_fake\":%d}\n",
         g_fake_ttl, g_quic_block, g_udp_fake);
  fflush(stdout);

  uint8_t pkt[65535];
  WINDIVERT_ADDRESS addr;
  while (g_run) {
    UINT len = 0;
    if (!p_Recv(g_handle, pkt, sizeof(pkt), &len, &addr)) {
      if (GetLastError() == ERROR_NO_DATA) break; /* shutdown */
      continue;
    }
    /* Anything we cannot safely classify is re-injected unchanged: IPv6, runts,
     * and any protocol other than the TCP/UDP the filter should have selected. */
    if (len < 28 || addr.IPv6) { UINT s; p_Send(g_handle, pkt, len, &s, &addr); continue; }
    int ihl = (pkt[0] & 0x0f) * 4;
    if (ihl < 20 || (int)len < ihl) { UINT s; p_Send(g_handle, pkt, len, &s, &addr); continue; }
    int proto = pkt[9];

    if (proto == 6 /* TCP */) {
      if ((int)len < ihl + 20) { UINT s; p_Send(g_handle, pkt, len, &s, &addr); continue; }
      int tcphl = ((pkt[ihl + 12] >> 4) & 0x0f) * 4;
      int poff = ihl + tcphl;
      int plen = (int)len - poff;
      if (plen > 0) {
        proto_info pi;
        proto_inspect(pkt + poff, (size_t)plen, &pi);
        if (pi.kind != PROTO_UNKNOWN) send_fake(pkt, len, &addr, &pi, poff); /* decoy first */
      }
      UINT s = 0; p_Send(g_handle, pkt, len, &s, &addr);   /* real packet unchanged */
      continue;
    }

    if (proto == 17 /* UDP */) {
      if ((int)len < ihl + 8) { UINT s; p_Send(g_handle, pkt, len, &s, &addr); continue; }
      int poff = ihl + 8;
      int plen = (int)len - poff;
      const uint8_t *up = pkt + poff;
      uint16_t dport_h = (uint16_t)((pkt[ihl + 2] << 8) | pkt[ihl + 3]);

      /* (1) QUIC: drop the Initial so the browser falls back to TCP. Everything
       * else on 443 (Version Negotiation, short-header, non-QUIC) re-injects. */
      if (g_quic_block && dport_h == 443) {
        if (plen > 0 && quic_is_initial(up, plen)) continue; /* DROP, no re-inject */
        UINT s = 0; p_Send(g_handle, pkt, len, &s, &addr);
        continue;
      }

      /* (2) Discord voice / STUN: decoys ahead of the first datagrams only. */
      if (g_udp_fake && discord_voice_port(dport_h) && plen > 0 && udp_is_discord_voice(up, plen)) {
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

    /* unexpected protocol: re-inject unchanged */
    { UINT s = 0; p_Send(g_handle, pkt, len, &s, &addr); }
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
