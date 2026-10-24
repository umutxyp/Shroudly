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
 *              ADBLOCK <path>   -> block the names of the list in path (adblock.h)
 *              ADBLOCK OFF      -> block nothing
 *              ADBLOCK-CHECK <path> -> is the list in path fit to use?
 *              ALLOW <name>     -> never block name, nor any name under it
 *              ALLOW-CLEAR      -> forget the names allowed
 *              STOP             -> shut down
 *
 * The same run is engine_main() (engine.h), which the Android app calls on a
 * thread of its own process with a pipe each way instead of stdin and stdout;
 * this file is built there with SHROUDLY_NO_MAIN.
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
#include "adblock.h"
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
static int g_dns_gate = 0;      /* Advanced mode: other programs' DNS from the forwarder on this port */
static int g_tlsrec   = 0;      /* Advanced mode: split the TLS record of a ClientHello (#48) */
static int g_fake_repeats = 6;  /* how many decoy datagrams per voice flow */
static char g_status_file[1024] = "";
static char g_auth_file[1024] = "";
static long g_parent_pid = 0;
static char g_adblock_file[1024] = "";
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

/* Every option at its default, as in a process that has just started: a run
 * inside another program (embedded) may follow an earlier one there. */
static void defaults(void) {
  memset(&g_cfg, 0, sizeof(g_cfg));
  strcpy(g_doh_fwd_ip, "127.0.0.1");
  g_doh_fwd_port = 0;
  g_advanced = 0;
  g_queue = 200;
  g_fake_ttl = 4;
  g_quic_block = 1;
  g_udp_fake = 1;
  g_dns_gate = 0;
  g_fake_repeats = 6;
  g_status_file[0] = 0;
  g_auth_file[0] = 0;
  g_parent_pid = 0;
  g_adblock_file[0] = 0;
  /* No list and no exceptions from an earlier run (embedded). */
  adblock_init();
  adblock_reset();
#if defined(SHROUDLY_RAW)
  g_drop_rst = RAW_DEF_DROP_RST;
  g_autottl  = RAW_DEF_AUTOTTL;
  g_seqovl   = RAW_DEF_SEQOVL;
  g_split    = RAW_DEF_SPLIT;
  g_desync_mode = RAW_DEF_DESYNC_MODE;
  g_seqovl_pat = RAW_DEF_SEQOVL_PATTERN;
  g_fake_pat   = RAW_DEF_FAKE_PATTERN;
#endif
}

static void usage(void) {
  fprintf(stderr,
    "shroudly-core [options]\n"
    "  --listen <ip>         listen address (default 127.0.0.1)\n"
    "  --port <n>            SOCKS port, v5/v4/v4a (default 10800)\n"
    "  --strategy <spec>     e.g. \"fake(ttl=4),split(sni)\"\n"
    "  --auto                auto-probe best strategy per host\n"
    "  --doh                 use anti-poisoning resolver\n"
    "  --dns-strict          only the --doh-port forwarder answers: no plaintext or system fallback\n"
    "  --auth-file <path>    SOCKS5 username/password: the file holds \"user:pass\";\n"
    "                        every client must give them, SOCKS4 is refused\n"
    "  --fake-net <cidr>     stand-in address range (repeatable, or comma-joined):\n"
    "                        CONNECT to it is refused at once, datagrams dropped\n"
    "  --watch <domain>      tell connections to it or a name under it as\n"
    "                        {\"type\":\"seen\",\"host\":...} (repeatable)\n"
    "  --ipv6                prefer IPv6 upstream\n"
    "  --adblock <path>      block the names of an ad and tracker list (adblock.h)\n"
    "  --allow <domain>      never block it, nor a name under it (repeatable)\n"
    "  --raw-local           tests: search techniques for non-TLS streams on local addresses too\n"
    "  --advanced            packet-layer backend (needs elevation)\n"
    "  --fake-repeats <n>    Advanced: decoy datagrams per Discord voice flow\n"
    "  --no-quic-block       Advanced: keep QUIC (do not force browsers to TCP)\n"
    "  --no-udp-fake         Advanced: no decoys for Discord voice UDP\n"
    "  --dns-gate <port>     Advanced: answer other programs' DNS from the\n"
    "  --tlsrec <0|1>        Advanced: split the ClientHello's TLS record (#48)\n"
    "                        encrypted-DNS forwarder on 127.0.0.1:<port>\n");
}

/* What became of a list: {"type":"adblock","on":...,"entries":...} with its
 * size and how long it took to read, or with "error" when it could not be
 * used (the list in use before, if any, stays). Never a path or a name. */
static void adblock_use_report(const char *path) {
  adb_stats st; const char *why = "";
  uint64_t t0 = now_ms();
  int rc = adblock_use(path, &st, &why);
  unsigned long long ms = (unsigned long long)(now_ms() - t0);
  if (rc == 0)
    engine_printf("{\"type\":\"adblock\",\"on\":true,\"entries\":%llu,\"skipped\":%llu,\"bytes\":%llu,\"ms\":%llu}\n",
                  (unsigned long long)st.entries, (unsigned long long)st.skipped, (unsigned long long)st.bytes, ms);
  else
    engine_printf("{\"type\":\"adblock\",\"on\":%s,\"error\":\"%s\"}\n", adblock_on() ? "true" : "false", why);
}

static void adblock_check_report(const char *path) {
  adb_stats st; const char *why = "";
  memset(&st, 0, sizeof(st));
  int rc = adblock_check(path, &st, &why);
  if (rc == 0)
    engine_printf("{\"type\":\"adblock_check\",\"ok\":true,\"entries\":%llu}\n", (unsigned long long)st.entries);
  else
    engine_printf("{\"type\":\"adblock_check\",\"ok\":false,\"entries\":%llu,\"error\":\"%s\"}\n",
                  (unsigned long long)st.entries, why);
}

int engine_main(int argc, char **argv, FILE *in, FILE *out, int embedded) {
  engine_set_output(out);
  if (plat_init() != 0) { fprintf(stderr, "plat_init failed\n"); return 2; }

  defaults();
  strcpy(g_cfg.listen_addr, "127.0.0.1");
  g_cfg.listen_port = 10800;
  g_cfg.use_doh = 0;
  g_cfg.auto_probe = 0;
  strcpy(g_cfg.doh_host, "cloudflare-dns.com");
  strcpy(g_cfg.doh_ip, "1.1.1.1");
  strategy_parse("split(sni)", &g_cfg.strat);

  int bad_fake_net = 0;
  int dns_strict = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--listen") && i+1<argc) strncpy(g_cfg.listen_addr, argv[++i], sizeof(g_cfg.listen_addr)-1);
    else if (!strcmp(argv[i], "--port") && i+1<argc) g_cfg.listen_port = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--strategy") && i+1<argc) strategy_parse(argv[++i], &g_cfg.strat);
    else if (!strcmp(argv[i], "--auto")) g_cfg.auto_probe = 1;
    else if (!strcmp(argv[i], "--doh")) g_cfg.use_doh = 1;
    else if (!strcmp(argv[i], "--ipv6")) g_cfg.prefer_ipv6 = 1;
    else if (!strcmp(argv[i], "--raw-local")) g_cfg.raw_local = 1;
    else if (!strcmp(argv[i], "--doh-ip") && i+1<argc) strncpy(g_doh_fwd_ip, argv[++i], sizeof(g_doh_fwd_ip)-1);
    else if (!strcmp(argv[i], "--doh-port") && i+1<argc) g_doh_fwd_port = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--dns-strict")) dns_strict = 1;
    else if (!strcmp(argv[i], "--block-ip") && i+1<argc) doh_add_block_ip(argv[++i]);
    else if (!strcmp(argv[i], "--advanced")) g_advanced = 1;
    else if (!strcmp(argv[i], "--queue") && i+1<argc) g_queue = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--fake-ttl") && i+1<argc) g_fake_ttl = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--fake-repeats") && i+1<argc) g_fake_repeats = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--no-quic-block")) g_quic_block = 0;
    else if (!strcmp(argv[i], "--no-udp-fake")) g_udp_fake = 0;
    else if (!strcmp(argv[i], "--dns-gate") && i+1<argc) g_dns_gate = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--tlsrec") && i+1<argc) g_tlsrec = atoi(argv[++i]) ? 1 : 0;
#if defined(SHROUDLY_RAW)
    else if (!strcmp(argv[i], "--drop-rst") && i+1<argc) g_drop_rst = atoi(argv[++i]) ? 1 : 0;
    else if (!strcmp(argv[i], "--autottl") && i+1<argc) g_autottl = atoi(argv[++i]) ? 1 : 0;
    else if (!strcmp(argv[i], "--seqovl") && i+1<argc) g_seqovl = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--split") && i+1<argc) g_split = parse_split_mode(argv[++i]);
    else if (!strcmp(argv[i], "--desync-mode") && i+1<argc) g_desync_mode = parse_desync_mode(argv[++i]);
    else if (!strcmp(argv[i], "--seqovl-pattern") && i+1<argc) g_seqovl_pat = (int)strtol(argv[++i], NULL, 16) & 0xff;
    else if (!strcmp(argv[i], "--fake-pattern") && i+1<argc) g_fake_pat = (int)strtol(argv[++i], NULL, 16) & 0xff;
#endif
    else if (!strcmp(argv[i], "--fake-net") && i+1<argc) { if (engine_add_fake_net(&g_cfg, argv[++i]) != 0) bad_fake_net = 1; }
    else if (!strcmp(argv[i], "--watch") && i+1<argc) engine_add_watch(&g_cfg, argv[++i]);  /* a bad one is left out */
    else if (!strcmp(argv[i], "--adblock") && i+1<argc) strncpy(g_adblock_file, argv[++i], sizeof(g_adblock_file)-1);
    else if (!strcmp(argv[i], "--allow") && i+1<argc) adblock_allow(argv[++i]);   /* a bad one is left out */
    else if (!strcmp(argv[i], "--auth-file") && i+1<argc) strncpy(g_auth_file, argv[++i], sizeof(g_auth_file)-1);
    else if (!strcmp(argv[i], "--status-file") && i+1<argc) strncpy(g_status_file, argv[++i], sizeof(g_status_file)-1);
    else if (!strcmp(argv[i], "--parent-pid") && i+1<argc) g_parent_pid = atol(argv[++i]);
    else if (!strcmp(argv[i], "--help")) { usage(); return 0; }
  }

  if (g_cfg.use_doh && g_doh_fwd_port > 0) doh_set_local(g_doh_fwd_ip, g_doh_fwd_port);
  else doh_set_local(NULL, 0);   /* none: not even one an earlier run named */
  doh_set_strict(dns_strict);
  if (bad_fake_net) {
    engine_printf("{\"type\":\"error\",\"msg\":\"fake-net unusable\"}\n");
    plat_cleanup();
    return 2;
  }
  /* Read once, here: the secret is in a file, not on the command line, where
   * any process could read it. A file that cannot be used stops the engine
   * rather than leave the port open. */
  if (g_auth_file[0] && engine_load_auth(&g_cfg, g_auth_file) != 0) {
    engine_printf("{\"type\":\"error\",\"msg\":\"auth file unusable\"}\n");
    plat_cleanup();
    return 2;
  }

#if defined(SHROUDLY_RAW)
  /* Advanced (packet-layer) mode: run the per-OS fake-packet backend instead of
   * the userspace proxy. It runs elevated; supervise.c handles stopping. Only
   * as a program of its own: it ends the process when it stops. */
  if (g_advanced && !embedded) {
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
    rc.dns_gate = g_dns_gate;
    rc.tlsrec = g_tlsrec;
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
    engine_printf("{\"type\":\"error\",\"msg\":\"advanced mode not built on this platform\"}\n");
  }
#endif

#ifndef _WIN32
  /* Inside another program the signals are that program's own. */
  if (!embedded) {
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    signal(SIGHUP, on_signal);
  }
#endif

  /* The ad and tracker list, before the first connection is taken. One that
   * cannot be used is told about, and the engine starts without it. */
  if (g_adblock_file[0]) adblock_use_report(g_adblock_file);

  int r = engine_start(&g_cfg);
  if (r != 0) {
    engine_printf("{\"type\":\"error\",\"code\":%d,\"msg\":\"listen failed\"}\n", r);
    plat_cleanup();
    return 3;
  }

  /* Control loop on stdin. When the UI dies, stdin EOFs and we exit cleanly —
   * no orphaned engine, no leftover state (we never touched the OS network). */
  /* Long enough for a list's path (ADBLOCK) on any system. */
  char line[2048];
  while (engine_is_running()) {
    if (!fgets(line, sizeof(line), in)) break; /* EOF -> shut down */
    char *nl = strpbrk(line, "\r\n"); if (nl) *nl = 0;
    if (!strncmp(line, "STOP", 4)) break;
    else if (!strncmp(line, "STATS", 5)) engine_emit_stats();
    else if (!strncmp(line, "PROBE ", 6)) probe_host(line + 6, &g_cfg);
    else if (!strcmp(line, "ADBLOCK OFF")) {
      adblock_off();
      engine_printf("{\"type\":\"adblock\",\"on\":false}\n");
    }
    /* The rest of the line is the path: it may hold spaces. */
    else if (!strncmp(line, "ADBLOCK-CHECK ", 14)) adblock_check_report(line + 14);
    else if (!strncmp(line, "ADBLOCK ", 8)) adblock_use_report(line + 8);
    else if (!strcmp(line, "ALLOW-CLEAR")) adblock_allow_clear();
    /* Another DNS server chosen (Settings): the answers kept from the last
     * one go, so the next lookup asks the new one. */
    else if (!strcmp(line, "DNS-CLEAR")) doh_clear_cache();
    /* The user's own DNS server set to be used alone, or no longer. */
    else if (!strcmp(line, "DNS-STRICT 1")) doh_set_strict(1);
    else if (!strcmp(line, "DNS-STRICT 0")) doh_set_strict(0);
    else if (!strncmp(line, "ALLOW ", 6)) adblock_allow(line + 6);
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
  engine_printf("{\"type\":\"stopped\"}\n");
  return 0;
}

#ifndef SHROUDLY_NO_MAIN
/* "shroudly-core --broadcast-env": tell Explorer and every running program
 * that the environment changed (WM_SETTINGCHANGE "Environment"). Explorer
 * then builds its own again from the registry, so a program started from the
 * Start menu, the taskbar or Win+R gets what the app wrote there (HTTPS_PROXY
 * in Volatile Environment, electron/app-env.js; issue #33). The app had only
 * PowerShell send it, which a security product or a policy can keep from
 * starting. user32 is loaded for this alone. 0 when the message went out. */
static int broadcast_env(void) {
#ifdef _WIN32
  typedef LRESULT (WINAPI *PFN_SendTimeout)(HWND, UINT, WPARAM, LPARAM, UINT, UINT, PDWORD_PTR);
  HMODULE u = LoadLibraryA("user32.dll");
  if (!u) return 1;
  PFN_SendTimeout f = (PFN_SendTimeout)GetProcAddress(u, "SendMessageTimeoutW");
  DWORD_PTR res = 0;
  int ok = f && f(HWND_BROADCAST, WM_SETTINGCHANGE, 0, (LPARAM)L"Environment", SMTO_ABORTIFHUNG, 5000, &res) != 0;
  FreeLibrary(u);
  printf("{\"type\":\"broadcast\",\"ok\":%d}\n", ok);
  return ok ? 0 : 1;
#else
  return 1;
#endif
}

int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "--watchdog")) return watchdog_main(argc, argv);
  if (argc > 1 && !strcmp(argv[1], "--broadcast-env")) return broadcast_env();
  return engine_main(argc, argv, stdin, stdout, 0);
}
#endif
