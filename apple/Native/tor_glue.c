/*
 * Tor inside the packet tunnel's process (Tunnel/TorRoute.swift): the last
 * way out, for a connection the engine got nowhere with. A packet tunnel
 * runs no program of its own, so Tor runs on a thread of it, through Tor's
 * own embedding API (src/feature/api/tor_api.h; the static Tor.xcframework,
 * linked into the Mac's tunnel only). Declared here rather than
 * included, so this file builds wherever the engine does; only a tunnel that
 * calls shroudly_tor_start needs Tor itself.
 */
#include "shroudly_native.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

typedef struct tor_main_configuration_t tor_main_configuration_t;
extern tor_main_configuration_t *tor_main_configuration_new(void);
extern int tor_main_configuration_set_command_line(tor_main_configuration_t *cfg, int argc, char *argv[]);
extern int tor_main_configuration_setup_control_socket(tor_main_configuration_t *cfg);
extern int tor_run_main(const tor_main_configuration_t *cfg);

/* Tor runs once in a process: it keeps its state in globals, and a second
 * run in the same process is not supported. */
static atomic_int g_started;

/* Kept for the process's life: Tor's globals may still point into it. */
static tor_main_configuration_t *g_cfg;
static char **g_argv;

static void *tor_thread(void *unused) {
  (void)unused;
  tor_run_main(g_cfg);
  return NULL;
}

int shroudly_tor_start(const char *const *args, int nargs) {
  int expected = 0;
  if (nargs < 0 || !atomic_compare_exchange_strong(&g_started, &expected, 1)) return SHROUDLY_TOR_ONCE;
  g_argv = calloc((size_t)nargs + 2, sizeof(char *));
  if (!g_argv) return SHROUDLY_TOR_NO_MEMORY;
  g_argv[0] = strdup("tor");
  for (int i = 0; i < nargs; i++) g_argv[i + 1] = strdup(args[i] ? args[i] : "");
  g_cfg = tor_main_configuration_new();
  if (!g_cfg || tor_main_configuration_set_command_line(g_cfg, nargs + 1, g_argv) != 0) return SHROUDLY_TOR_NO_MEMORY;
  /* A control connection Tor owns and trusts, for the bootstrap's progress
   * and for turning its network off and on. */
  int fd = tor_main_configuration_setup_control_socket(g_cfg);
  if (fd < 0) return SHROUDLY_TOR_NO_MEMORY;
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, 4 * 1024 * 1024);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  pthread_t t;
  int rc = pthread_create(&t, &attr, tor_thread, NULL);
  pthread_attr_destroy(&attr);
  return rc == 0 ? fd : SHROUDLY_TOR_NO_MEMORY;
}
