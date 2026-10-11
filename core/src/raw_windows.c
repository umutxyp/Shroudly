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
 * The WinDivert binaries are NOT bundled in the default build; the advanced
 * Windows package ships them next to shroudly-core-adv.exe. If the driver cannot
 * load, the backend reports an error and the app falls back to the default
 * engine, exactly as on platforms with no advanced backend.
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
#include "raw_windows.h"

/* ── Minimal WinDivert 2.x declarations (avoid needing the SDK header) ─────── */
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
  UINT32 Reserved1:4;
  UINT32 Reserved2;
  union {
    struct { UINT32 IfIdx; UINT32 SubIfIdx; UINT8 Reserved3[64]; } Network;
    UINT8 Reserved[72];
  };
} WINDIVERT_ADDRESS;

#define WINDIVERT_LAYER_NETWORK 0
#define WINDIVERT_HELPER_NO_REPLACE 0

typedef HANDLE (WINAPI *PFN_Open)(const char*, int, INT16, UINT64);
typedef BOOL   (WINAPI *PFN_Recv)(HANDLE, void*, UINT, UINT*, WINDIVERT_ADDRESS*);
typedef BOOL   (WINAPI *PFN_Send)(HANDLE, const void*, UINT, UINT*, const WINDIVERT_ADDRESS*);
typedef BOOL   (WINAPI *PFN_Close)(HANDLE);
typedef BOOL   (WINAPI *PFN_Shutdown)(HANDLE, int);
typedef BOOL   (WINAPI *PFN_CalcCsum)(void*, UINT, const WINDIVERT_ADDRESS*, UINT64);

static PFN_Open     p_Open;
static PFN_Recv     p_Recv;
static PFN_Send     p_Send;
static PFN_Close    p_Close;
static PFN_Shutdown p_Shutdown;
static PFN_CalcCsum p_CalcCsum;

static HANDLE g_handle = INVALID_HANDLE_VALUE;
static volatile int g_run = 0;
static int g_fake_ttl = 4;

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

int raw_windows_start(int fake_ttl) {
  g_fake_ttl = fake_ttl > 0 ? fake_ttl : 4;
  if (load_windivert() != 0) return -1;

  /* Outbound TLS(443)/HTTP(80) with payload. WinDivert filter language. */
  const char *filter =
    "outbound and ip and tcp and (tcp.DstPort == 443 or tcp.DstPort == 80) and tcp.PayloadLength > 0";
  g_handle = p_Open(filter, WINDIVERT_LAYER_NETWORK, 0, 0);
  if (g_handle == INVALID_HANDLE_VALUE) {
    fprintf(stderr, "WinDivertOpen failed (%lu). Run as Administrator.\n", (unsigned long)GetLastError());
    return -1;
  }

  g_run = 1;
  printf("{\"type\":\"raw_ready\",\"backend\":\"windivert\",\"ttl\":%d}\n", g_fake_ttl);
  fflush(stdout);

  uint8_t pkt[65535];
  WINDIVERT_ADDRESS addr;
  while (g_run) {
    UINT len = 0;
    if (!p_Recv(g_handle, pkt, sizeof(pkt), &len, &addr)) {
      if (GetLastError() == ERROR_NO_DATA) break; /* shutdown */
      continue;
    }
    if (len < 40 || addr.IPv6) { UINT s; p_Send(g_handle, pkt, len, &s, &addr); continue; }

    int ihl = (pkt[0] & 0x0f) * 4;
    if (ihl < 20 || (int)len < ihl + 20) { UINT s; p_Send(g_handle, pkt, len, &s, &addr); continue; }
    int tcphl = ((pkt[ihl + 12] >> 4) & 0x0f) * 4;
    int poff = ihl + tcphl;
    int plen = (int)len - poff;

    if (plen > 0) {
      proto_info pi;
      proto_inspect(pkt + poff, (size_t)plen, &pi);
      if (pi.kind != PROTO_UNKNOWN) {
        send_fake(pkt, len, &addr, &pi, poff);   /* 1. decoy first */
      }
    }
    /* 2. re-inject the real packet unchanged */
    UINT s = 0;
    p_Send(g_handle, pkt, len, &s, &addr);
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
