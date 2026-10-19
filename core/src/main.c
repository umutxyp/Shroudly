/*
 * shroudly-core — cross-platform DPI-evasion engine.
 *
 * No kernel driver, no third-party library: it runs a local SOCKS proxy
 * (SOCKS5, and SOCKS4/4a for the clients that only speak those; SOCKS5 UDP
 * ASSOCIATE relays datagrams, plainly) and applies
 * TLS/HTTP desync (split / disorder / low-TTL fakes) on the first payload of
 * each connection, plus anti-poisoning DNS. Works unprivileged on Windows,
 * Linux and macOS.
 *
 * Control: reads line commands on stdin so the UI can drive it without any
 * elevated IPC. Emits JSON status lines on stdout.
 *   Commands:  STATS            -> emit one stats line
 *              PROBE <host>     -> auto-detect a working strategy for host
 *              STOP             -> shut down
 *
 * "shroudly-core --watchdog ..." is a separate, much smaller job: see
 * watchdog.h.
 */
#include "engine.h"
#include "probe.h"
#include "platform.h"
#include "strategy.h"
#include "doh.h"
#include "watchdog.h"
#if defined(SHROUDLY_RAW) && defined(__linux__)
#include "raw_linux.h"
#endif
#if defined(SHROUDLY_RAW) && defined(_WIN32)
#include "raw_windows.h"
#endif
#if defined(SHROUDLY_RAW)
#include "supervise.h"
#include "raw_desync.h"
#include "rawscope.h"
#endif
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#ifndef _WIN32
#include <signal.h>
#endif

static engine_config g_cfg;
static char g_doh_fwd_ip[64] = "127.0.0.1";
static int  g_doh_fwd_port = 0;
static int g_advanced = 0;
static int g_queue = 200;
static int g_fake_ttl = 4;
static int g_quic_block = 1;    /* Advanced mode: drop QUIC Initial -> TCP */
static int g_udp_fake = 1;      /* Advanced mode: decoys for Discord voice UDP */
static int g_fake_repeats = 6;  /* how many decoy datagrams per voice flow */
static char g_status_file[1024] = "";
static char g_auth_file[1024] = "";
static long g_parent_pid = 0;
#if defined(SHROUDLY_RAW)
/* Advanced-mode packet-layer options; defaults in raw_desync.h. */
static int g_drop_rst = RAW_DEF_DROP_RST;
static int g_autottl  = RAW_DEF_AUTOTTL;
static int g_seqovl   = RAW_DEF_SEQOVL;
static int g_split    = RAW_DEF_SPLIT;
static int g_desync_mode = RAW_DEF_DESYNC_MODE;
static int g_seqovl_pat = RAW_DEF_SEQOVL_PATTERN;
static int g_fake_pat   = RAW_DEF_FAKE_PATTERN;

static int parse_desync_mode(const char *s) {
  if (!strcmp(s, "fakedsplit")) return RAW_DESYNC_FAKEDSPLIT;
  if (!strcmp(s, "fakeddisorder")) return RAW_DESYNC_FAKEDDISORDER;
  return RAW_DESYNC_FAKE; /* "fake" or anything unrecognised: the safe default */
}

/* "off" / "0", "disorder", else on: the cut is the default. */
static int parse_split_mode(const char *s) {
  if (!strcmp(s, "off") || !strcmp(s, "0")) return RAW_SPLIT_OFF;
  if (!strcmp(s, "disorder")) return RAW_SPLIT_DISORDER;
  return RAW_SPLIT_ON;
}
#endif

#ifndef _WIN32
static void on_signal(int sig) { (void)sig; engine_stop(); }
#endif

static void usage(void) {
  fprintf(stderr,
    "shroudly-core [options]\n"
    "  --listen <ip>         listen address (default 127.0.0.1)\n"
    "  --port <n>            SOCKS port, v5/v4/v4a (default 10800)\n"
    "  --strategy <spec>     e.g. \"fake(ttl=4),split(sni)\"\n"
    "  --auto                auto-probe best strategy per host\n"
    "  --doh                 use anti-poisoning resolver\n"
    "  --auth-file <path>    SOCKS5 username/password: the file holds \"user:pass\";\n"
    "                        every client must give them, SOCKS4 is refused\n"
    "  --ipv6                prefer IPv6 upstream\n"
    "  --advanced            packet-layer backend (needs elevation)\n"
    "  --fake-repeats <n>    Advanced: decoy datagrams per Discord voice flow\n"
    "  --no-quic-block       Advanced: keep QUIC (do not force browsers to TCP)\n"
    "  --no-udp-fake         Advanced: no decoys for Discord voice UDP\n");
}

int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "--watchdog")) return watchdog_main(argc, argv);
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
    else if (!strcmp(argv[i], "--doh-ip") && i+1<argc) strncpy(g_doh_fwd_ip, argv[++i], sizeof(g_doh_fwd_ip)-1);
    else if (!strcmp(argv[i], "--doh-port") && i+1<argc) g_doh_fwd_port = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--block-ip") && i+1<argc) doh_add_block_ip(argv[++i]);
    else if (!strcmp(argv[i], "--advanced")) g_advanced = 1;
    else if (!strcmp(argv[i], "--queue") && i+1<argc) g_queue = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--fake-ttl") && i+1<argc) g_fake_ttl = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--fake-repeats") && i+1<argc) g_fake_repeats = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--no-quic-block")) g_quic_block = 0;
    else if (!strcmp(argv[i], "--no-udp-fake")) g_udp_fake = 0;
#if defined(SHROUDLY_RAW)
    else if (!strcmp(argv[i], "--drop-rst") && i+1<argc) g_drop_rst = atoi(argv[++i]) ? 1 : 0;
    else if (!strcmp(argv[i], "--autottl") && i+1<argc) g_autottl = atoi(argv[++i]) ? 1 : 0;
    else if (!strcmp(argv[i], "--seqovl") && i+1<argc) g_seqovl = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--split") && i+1<argc) g_split = parse_split_mode(argv[++i]);
    else if (!strcmp(argv[i], "--desync-mode") && i+1<argc) g_desync_mode = parse_desync_mode(argv[++i]);
    else if (!strcmp(argv[i], "--seqovl-pattern") && i+1<argc) g_seqovl_pat = (int)strtol(argv[++i], NULL, 16) & 0xff;
    else if (!strcmp(argv[i], "--fake-pattern") && i+1<argc) g_fake_pat = (int)strtol(argv[++i], NULL, 16) & 0xff;
#endif
    else if (!strcmp(argv[i], "--auth-file") && i+1<argc) strncpy(g_auth_file, argv[++i], sizeof(g_auth_file)-1);
    else if (!strcmp(argv[i], "--status-file") && i+1<argc) strncpy(g_status_file, argv[++i], sizeof(g_status_file)-1);
    else if (!strcmp(argv[i], "--parent-pid") && i+1<argc) g_parent_pid = atol(argv[++i]);
    else if (!strcmp(argv[i], "--help")) { usage(); return 0; }
  }

  if (g_cfg.use_doh && g_doh_fwd_port > 0) doh_set_local(g_doh_fwd_ip, g_doh_fwd_port);
  /* Read once, here: the secret is in a file, not on the command line, where
   * any process could read it. A file that cannot be used stops the engine
   * rather than leave the port open. */
  if (g_auth_file[0] && engine_load_auth(&g_cfg, g_auth_file) != 0) {
    printf("{\"type\":\"error\",\"msg\":\"auth file unusable\"}\n");
    fflush(stdout);
    plat_cleanup();
    return 2;
  }

#if defined(SHROUDLY_RAW)
  /* Advanced (packet-layer) mode: run the per-OS fake-packet backend instead of
   * the userspace proxy. It runs elevated; supervise.c handles stopping. */
  if (g_advanced) {
    if (g_status_file[0] && sup_redirect_output(g_status_file) != 0) return 2;
    raw_config rc;
    raw_config_defaults(&rc, g_fake_ttl);
    rc.drop_rst = g_drop_rst;
    rc.autottl = g_autottl;
    rc.seqovl = g_seqovl;
    rc.split = g_split;
    rc.desync_mode = g_desync_mode;
    rc.seqovl_pattern = (uint8_t)g_seqovl_pat;
    rc.fake_pattern = (uint8_t)g_fake_pat;
    rc.quic_block = g_quic_block;
    rc.udp_fake = g_udp_fake;
    rc.fake_repeats = g_fake_repeats;
    /* What the engine did, as a raw_stats line: every minute and at stop. */
    rawscope_counters_reset();
    sup_set_report(rawscope_stats_print, 60000);
  #if defined(__linux__)
    sup_start(g_status_file, g_parent_pid, raw_linux_teardown);
  #else
    sup_start(g_status_file, g_parent_pid, NULL);
  #endif
    int rr;
  #if defined(__linux__)
    rr = raw_linux_start(g_queue, &rc);
    raw_linux_stop();
  #elif defined(_WIN32)
    rr = raw_windows_start(&rc);
    raw_windows_stop();
  #else
    rr = -1;
    printf("{\"type\":\"error\",\"msg\":\"advanced mode not built on this platform\"}\n");
    fflush(stdout);
  #endif
    if (rr == 0) rawscope_stats_print(); /* the loop ended without a stop request */
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
    else if (!strncmp(line, "LEARN ", 6)) {
      /* LEARN <host> <technique> <seconds ago>: what an earlier run learned. */
      char host[256], tech[64]; unsigned long long secs = 0;
      if (sscanf(line + 6, "%255s %63s %llu", host, tech, &secs) == 3)
        engine_restore(host, tech, (uint64_t)secs * 1000ull);
    }
  }

  engine_stop();
  sleep_ms(50);
  plat_cleanup();
  printf("{\"type\":\"stopped\"}\n");
  fflush(stdout);
  return 0;
}
