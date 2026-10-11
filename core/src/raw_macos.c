/*
 * raw_macos.c — ADVANCED (packet-layer) desync backend for macOS.
 *
 * Counterpart of raw_linux.c / raw_windows.c. macOS has no NFQUEUE or WinDivert,
 * but it keeps BSD divert sockets (IPPROTO_DIVERT) and the pf firewall. The
 * manager (advanced-mode.js) installs a pf anchor rule that diverts outbound
 * 80/443 to a divert port; this backend binds that port, and for each diverted
 * ClientHello it:
 *    1. sends a low-TTL / bad-checksum FAKE copy (scrambled SNI) via a raw
 *       socket so the DPI ingests garbage but the server never sees it;
 *    2. writes the real packet back to the divert socket so it proceeds.
 *
 * Needs root. No kext, no SIP changes, no entitlements — only pf (built in) and
 * divert sockets (built in). Compiled only when SHROUDLY_RAW is defined, on
 * Apple platforms. If pf/divert is unavailable the backend reports an error and
 * the app falls back to the default engine.
 */
#ifdef SHROUDLY_RAW
#ifdef __APPLE__

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#include <unistd.h>
#include <signal.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#include "proto.h"
#include "raw_macos.h"

#ifndef IPPROTO_DIVERT
#define IPPROTO_DIVERT 254
#endif

static int g_divert_fd = -1;
static int g_raw_fd = -1;
static int g_fake_ttl = 4;
static volatile int g_run = 0;

/* one's-complement checksum */
static uint16_t csum16(const void *data, int len, uint32_t init) {
  const uint16_t *p = (const uint16_t *)data;
  uint32_t sum = init;
  while (len > 1) { sum += *p++; len -= 2; }
  if (len) sum += *(const uint8_t *)p;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (uint16_t)~sum;
}

/* Send a low-TTL, bad-TCP-checksum, SNI-scrambled copy via a raw socket. */
static void send_fake(const uint8_t *pkt, int len, const proto_info *pi, int poff) {
  if (g_raw_fd < 0 || len > 1600 || len < 20) return;
  uint8_t buf[1600];
  memcpy(buf, pkt, len);

  int ihl = (buf[0] & 0x0f) * 4;
  buf[8] = (uint8_t)g_fake_ttl;             /* TTL field */

  int plen = len - poff;
  uint8_t *fp = buf + poff;
  if (pi->host_off >= 0 && pi->host_off + pi->host_len <= plen) {
    for (int i = pi->host_off; i < pi->host_off + pi->host_len; i++) fp[i] ^= 0x5a;
  } else if (plen > 0) {
    for (int i = plen / 3; i < plen; i++) fp[i] ^= 0x5a;
  }

  /* IP checksum (good) */
  buf[10] = buf[11] = 0;
  uint16_t ipc = csum16(buf, ihl, 0);
  buf[10] = ipc & 0xff; buf[11] = ipc >> 8;   /* already network order from csum */

  /* TCP checksum: compute correct then corrupt it (bad on purpose) */
  int tcplen = len - ihl;
  uint32_t ph = 0;
  ph += (buf[12] << 8 | buf[13]) + (buf[14] << 8 | buf[15]); /* src */
  ph += (buf[16] << 8 | buf[17]) + (buf[18] << 8 | buf[19]); /* dst */
  ph += 6; /* TCP */
  ph += tcplen;
  buf[ihl + 16] = buf[ihl + 17] = 0;
  uint16_t tc = csum16(buf + ihl, tcplen, ph);
  tc ^= 0xffff; /* corrupt */
  buf[ihl + 16] = (tc >> 8) & 0xff; buf[ihl + 17] = tc & 0xff;

  struct sockaddr_in dst;
  memset(&dst, 0, sizeof(dst));
  dst.sin_family = AF_INET;
  memcpy(&dst.sin_addr, buf + 16, 4);
  sendto(g_raw_fd, buf, len, 0, (struct sockaddr *)&dst, sizeof(dst));
}

int raw_macos_start(int fake_ttl) {
  g_fake_ttl = fake_ttl > 0 ? fake_ttl : 4;

  g_raw_fd = socket(AF_INET, SOCK_RAW, IPPROTO_RAW);
  if (g_raw_fd < 0) { perror("raw socket"); return -1; }
  int one = 1;
  setsockopt(g_raw_fd, IPPROTO_IP, IP_HDRINCL, &one, sizeof(one));

  g_divert_fd = socket(PF_INET, SOCK_RAW, IPPROTO_DIVERT);
  if (g_divert_fd < 0) { perror("divert socket"); close(g_raw_fd); g_raw_fd = -1; return -1; }
  struct sockaddr_in bindaddr;
  memset(&bindaddr, 0, sizeof(bindaddr));
  bindaddr.sin_family = AF_INET;
  bindaddr.sin_port = htons((uint16_t)SHROUDLY_DIVERT_PORT);
  if (bind(g_divert_fd, (struct sockaddr *)&bindaddr, sizeof(bindaddr)) < 0) {
    perror("bind divert"); close(g_divert_fd); close(g_raw_fd);
    g_divert_fd = g_raw_fd = -1; return -1;
  }

  g_run = 1;
  printf("{\"type\":\"raw_ready\",\"backend\":\"pf-divert\",\"port\":%d,\"ttl\":%d}\n",
         SHROUDLY_DIVERT_PORT, g_fake_ttl);
  fflush(stdout);

  uint8_t pkt[65535];
  struct sockaddr_in from;
  socklen_t fl;
  while (g_run) {
    fl = sizeof(from);
    int n = recvfrom(g_divert_fd, pkt, sizeof(pkt), 0, (struct sockaddr *)&from, &fl);
    if (n < 0) { if (errno == EINTR) continue; break; }
    if (n >= 20) {
      int ihl = (pkt[0] & 0x0f) * 4;
      if (n >= ihl + 20 && pkt[9] == 6 /*TCP*/) {
        int tcphl = ((pkt[ihl + 12] >> 4) & 0x0f) * 4;
        int poff = ihl + tcphl;
        int plen = n - poff;
        if (plen > 0) {
          proto_info pi;
          proto_inspect(pkt + poff, (size_t)plen, &pi);
          if (pi.kind != PROTO_UNKNOWN) send_fake(pkt, n, &pi, poff);
        }
      }
    }
    /* write the real packet back so it continues through the stack */
    sendto(g_divert_fd, pkt, n, 0, (struct sockaddr *)&from, fl);
  }
  return 0;
}

void raw_macos_stop(void) {
  g_run = 0;
  if (g_divert_fd >= 0) { close(g_divert_fd); g_divert_fd = -1; }
  if (g_raw_fd >= 0) { close(g_raw_fd); g_raw_fd = -1; }
}

#endif /* __APPLE__ */
#endif /* SHROUDLY_RAW */
