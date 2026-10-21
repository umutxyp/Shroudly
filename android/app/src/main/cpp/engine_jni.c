/*
 * The engine inside the app's own process (EngineNative.kt).
 *
 * Until 2.6.1 the engine was a program of its own, started with
 * ProcessBuilder. Android counts such a program as a "phantom process" of
 * the app: Android 12 and later end it when the phone has more than a few
 * dozen of them or when it uses CPU in the background, and phone makers'
 * battery managers (Xiaomi's above all) end or freeze it on their own. The
 * VPN stayed up while the engine was gone or frozen, so every app's
 * connections went nowhere. Run here, on a thread of the app's process, it
 * lives exactly as long as the VPN service does.
 *
 * EngineNative.run() is the shroudly-core program's whole run (engine_main in
 * core/src/main.c, built with SHROUDLY_NO_MAIN): the same options, the same
 * commands read from one pipe and the same JSON lines written to another, as
 * the desktop app has with the program's stdin and stdout. It returns when
 * the engine stops: on STOP, or when the command pipe is closed. Nothing in
 * it ends the process or touches the app's signal handlers.
 */
#include <jni.h>

#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "engine.h"

/* One run at a time in a process: the engine keeps its state in globals. */
static atomic_int g_busy;

#define BUSY (-100)
#define NO_MEMORY (-101)

static void free_argv(char **argv, int n) {
  if (!argv) return;
  for (int i = 0; i < n; i++) free(argv[i]);
  free(argv);
}

/* run(args, commandFd, eventFd): both descriptors are the native side's from
 * here on, and closed when the run ends (or at once, when it cannot start). */
JNIEXPORT jint JNICALL
Java_me_codeshare_shroudly_EngineNative_run(JNIEnv *env, jclass cls, jobjectArray jargs,
                                            jint cmd_fd, jint event_fd) {
  (void)cls;
  int expected = 0;
  if (!atomic_compare_exchange_strong(&g_busy, &expected, 1)) {
    close(cmd_fd);
    close(event_fd);
    return BUSY;
  }

  int n = jargs ? (*env)->GetArrayLength(env, jargs) : 0;
  int argc = n + 1;
  char **argv = (char **)calloc((size_t)argc + 1, sizeof(char *));
  int ok = argv != NULL;
  if (ok) ok = (argv[0] = strdup("shroudly-core")) != NULL;
  for (int i = 0; ok && i < n; i++) {
    jstring s = (jstring)(*env)->GetObjectArrayElement(env, jargs, i);
    const char *c = s ? (*env)->GetStringUTFChars(env, s, NULL) : NULL;
    argv[i + 1] = c ? strdup(c) : NULL;
    if (c) (*env)->ReleaseStringUTFChars(env, s, c);
    if (s) (*env)->DeleteLocalRef(env, s);
    ok = argv[i + 1] != NULL;
  }

  FILE *in = ok ? fdopen(cmd_fd, "r") : NULL;
  FILE *out = in ? fdopen(event_fd, "w") : NULL;
  if (!in || !out) {
    if (in) fclose(in); else close(cmd_fd);
    close(event_fd);
    free_argv(argv, argc);
    atomic_store(&g_busy, 0);
    return NO_MEMORY;
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
