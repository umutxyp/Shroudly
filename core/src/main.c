/*
 * shroudly-core — cross-platform DPI-evasion engine.
 *
 * No kernel driver, no third-party library: it runs a local SOCKS5 proxy and
 * applies TLS/HTTP desync (split / disorder / low-TTL fakes) on the first
 * payload of each connection, plus anti-poisoning DNS. Works unprivileged on
 * Windows, Linux and macOS.
 *
 * Control: reads line commands on stdin so the UI can drive it without any
 * elevated IPC. Emits JSON status lines on stdout.
 *   Commands:  STATS            -> emit one stats line
 *              PROBE <host>     -> auto-detect a working strategy for host
 *              STOP             -> shut down
 */
#include "engine.h"
#include "probe.h"
#include "platform.h"
#include "strategy.h"
#if defined(SHROUDLY_RAW) && defined(__linux__)
#include "raw_linux.h"
#endif
#if defined(SHROUDLY_RAW) && defined(_WIN32)
#include "raw_windows.h"
#endif
#if defined(SHROUDLY_RAW) && defined(__APPLE__)
#include "raw_macos.h"
#endif
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#ifndef _WIN32
#include <signal.h>
#endif

static engine_config g_cfg;
static int g_advanced = 0;
static int g_queue = 200;
static int g_fake_ttl = 4;

static void on_signal(int sig) { (void)sig; engine_stop(); }

static void usage(void) {
  fprintf(stderr,
    "shroudly-core [options]\n"
    "  --listen <ip>         listen address (default 127.0.0.1)\n"
    "  --port <n>            SOCKS5 port (default 10800)\n"
    "  --strategy <spec>     e.g. \"fake(ttl=4),split(sni)\"\n"
    "  --auto                auto-probe best strategy per host\n"
    "  --doh                 use anti-poisoning resolver\n"
    "  --ipv6                prefer IPv6 upstream\n");
}

int main(int argc, char **argv) {
  if (plat_init() != 0) { fprintf(stderr, "plat_init failed\n"); return 2; }

  memset(&g_cfg, 0, sizeof(g_cfg));
  strcpy(g_cfg.listen_addr, "127.0.0.1");
  g_cfg.listen_port = 10800;
  g_cfg.use_doh = 0;
  g_cfg.auto_probe = 0;
  strcpy(g_cfg.doh_host, "cloudflare-dns.com");
  strcpy(g_cfg.doh_ip, "1.1.1.1");
  strategy_parse("split(sni)", &g_cfg.strat);

  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--listen") && i+1<argc) strncpy(g_cfg.listen_addr, argv[++i], sizeof(g_cfg.listen_addr)-1);
    else if (!strcmp(argv[i], "--port") && i+1<argc) g_cfg.listen_port = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--strategy") && i+1<argc) strategy_parse(argv[++i], &g_cfg.strat);
    else if (!strcmp(argv[i], "--auto")) g_cfg.auto_probe = 1;
    else if (!strcmp(argv[i], "--doh")) g_cfg.use_doh = 1;
    else if (!strcmp(argv[i], "--ipv6")) g_cfg.prefer_ipv6 = 1;
    else if (!strcmp(argv[i], "--advanced")) g_advanced = 1;
    else if (!strcmp(argv[i], "--queue") && i+1<argc) g_queue = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--fake-ttl") && i+1<argc) g_fake_ttl = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--help")) { usage(); return 0; }
  }

#if defined(SHROUDLY_RAW)
  /* Advanced (packet-layer) mode: run the per-OS fake-packet backend instead of
   * the userspace proxy. The manager handles any firewall rule / elevation. */
  if (g_advanced) {
  #ifndef _WIN32
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
  #endif
    int rr;
  #if defined(__linux__)
    rr = raw_linux_start(g_queue, g_fake_ttl);
    raw_linux_stop();
  #elif defined(_WIN32)
    rr = raw_windows_start(g_fake_ttl);
    raw_windows_stop();
  #elif defined(__APPLE__)
    rr = raw_macos_start(g_fake_ttl);
    raw_macos_stop();
  #else
    rr = -1;
    printf("{\"type\":\"error\",\"msg\":\"advanced mode not built on this platform\"}\n");
    fflush(stdout);
  #endif
    plat_cleanup();
    printf("{\"type\":\"stopped\"}\n"); fflush(stdout);
    return rr;
  }
#else
  if (g_advanced) {
    printf("{\"type\":\"error\",\"msg\":\"advanced mode not built on this platform\"}\n");
    fflush(stdout);
  }
#endif

#ifndef _WIN32
  signal(SIGINT, on_signal);
  signal(SIGTERM, on_signal);
  signal(SIGHUP, on_signal);
#endif

  int r = engine_start(&g_cfg);
  if (r != 0) {
    printf("{\"type\":\"error\",\"code\":%d,\"msg\":\"listen failed\"}\n", r);
    fflush(stdout);
    plat_cleanup();
    return 3;
  }

  /* Control loop on stdin. When the UI dies, stdin EOFs and we exit cleanly —
   * no orphaned engine, no leftover state (we never touched the OS network). */
  char line[512];
  while (engine_is_running()) {
    if (!fgets(line, sizeof(line), stdin)) break; /* EOF -> shut down */
    char *nl = strpbrk(line, "\r\n"); if (nl) *nl = 0;
    if (!strncmp(line, "STOP", 4)) break;
    else if (!strncmp(line, "STATS", 5)) engine_emit_stats();
    else if (!strncmp(line, "PROBE ", 6)) probe_host(line + 6, &g_cfg);
  }

  engine_stop();
  sleep_ms(50);
  plat_cleanup();
  printf("{\"type\":\"stopped\"}\n");
  fflush(stdout);
  return 0;
}
