/*
 * The engine inside the packet tunnel's process (Tunnel/Engine.swift), as
 * the Android app runs it (android/app/src/main/cpp/engine_jni.c): the
 * shroudly-core program's whole run (engine_main in core/src/main.c, built
 * with SHROUDLY_NO_MAIN), with a pipe each way instead of stdin and stdout.
 * Nothing in it ends the process or touches its signal handlers, and it
 * returns once the engine has stopped.
 */
#include "shroudly_native.h"

#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "engine.h"

/* One run at a time in a process: the engine keeps its state in globals. */
static atomic_int g_busy;

static void free_argv(char **argv, int n) {
  if (!argv) return;
  for (int i = 0; i < n; i++) free(argv[i]);
  free(argv);
}

int shroudly_engine_run(const char *const *args, int nargs, int cmd_fd, int event_fd) {
  int expected = 0;
  if (!atomic_compare_exchange_strong(&g_busy, &expected, 1)) {
    close(cmd_fd);
    close(event_fd);
    return SHROUDLY_ENGINE_BUSY;
  }

  int n = (args && nargs > 0) ? nargs : 0;
  int argc = n + 1;
  char **argv = (char **)calloc((size_t)argc + 1, sizeof(char *));
  int ok = argv != NULL;
  if (ok) ok = (argv[0] = strdup("shroudly-core")) != NULL;
  for (int i = 0; ok && i < n; i++) ok = args[i] && (argv[i + 1] = strdup(args[i])) != NULL;

  FILE *in = ok ? fdopen(cmd_fd, "r") : NULL;
  FILE *out = in ? fdopen(event_fd, "w") : NULL;
  if (!in || !out) {
    if (in) fclose(in); else close(cmd_fd);
    close(event_fd);
    free_argv(argv, argc);
    atomic_store(&g_busy, 0);
    return SHROUDLY_ENGINE_NO_MEMORY;
  }

  int rc = engine_main(argc, argv, in, out, 1);

  /* Connections of this run may still be finishing on their own threads;
   * what they would report goes nowhere from now on, not into a closed
   * stream. Closing the event pipe is what tells the app the run is over. */
  engine_output_off();
  fclose(out);
  fclose(in);
  free_argv(argv, argc);
  atomic_store(&g_busy, 0);
  return rc;
}
