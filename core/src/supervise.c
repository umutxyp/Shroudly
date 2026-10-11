/*
 * supervise.c — stop / parent-death / status-file handling for the privileged
 * Advanced-mode engine. See supervise.h for the protocol.
 */
#include "platform.h"
#include "supervise.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>

#ifdef _WIN32
  #include <io.h>
#else
  #include <fcntl.h>
#endif

static char g_stop_path[1100];
static long g_parent_pid = 0;
static sup_teardown_fn g_teardown = NULL;
static volatile sig_atomic_t g_signalled = 0;

int sup_redirect_output(const char *status_file) {
#ifdef _WIN32
  if (!freopen(status_file, "w", stdout)) return -1;
  if (_dup2(_fileno(stdout), _fileno(stderr)) != 0) return -1;
#else
  /* The engine runs as root but the path comes from the unprivileged app:
   * never follow a symlink planted there. */
  int fd = open(status_file, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0644);
  if (fd < 0) return -1;
  fflush(stdout);
  if (dup2(fd, 1) < 0 || dup2(fd, 2) < 0) { close(fd); return -1; }
  close(fd);
#endif
  setvbuf(stderr, NULL, _IONBF, 0);
  return 0;
}

static int file_exists(const char *p) {
  FILE *f = fopen(p, "rb");
  if (!f) return 0;
  fclose(f);
  return 1;
}

static int parent_alive(long pid) {
#ifdef _WIN32
  HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)pid);
  if (!h) return GetLastError() == ERROR_ACCESS_DENIED; /* exists, just not ours */
  DWORD r = WaitForSingleObject(h, 0);
  CloseHandle(h);
  return r == WAIT_TIMEOUT;
#else
  return kill((pid_t)pid, 0) == 0 || errno == EPERM;
#endif
}

#ifndef _WIN32
static void on_signal(int sig) { (void)sig; g_signalled = 1; }
#endif

static void *watchdog(void *arg) {
  (void)arg;
  for (;;) {
    sleep_ms(250);
    if (g_signalled) break;
    if (g_parent_pid > 0 && !parent_alive(g_parent_pid)) break;
    if (g_stop_path[0] && file_exists(g_stop_path)) break;
  }
  if (g_teardown) g_teardown();
  if (g_stop_path[0]) remove(g_stop_path);
  printf("{\"type\":\"stopped\"}\n");
  fflush(stdout);
#ifdef _WIN32
  ExitProcess(0); /* closes the WinDivert handle, which detaches the filter */
#else
  _exit(0);       /* the kernel drops the NFQUEUE binding with our socket */
#endif
  return NULL;
}

int sup_start(const char *status_file, long parent_pid, sup_teardown_fn teardown) {
  g_parent_pid = parent_pid;
  g_teardown = teardown;
  g_stop_path[0] = '\0';
  if (status_file && status_file[0])
    snprintf(g_stop_path, sizeof(g_stop_path), "%s.stop", status_file);
#ifndef _WIN32
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_signal;
  sigemptyset(&sa.sa_mask);
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGHUP, &sa, NULL);
#endif
  return thread_spawn(watchdog, NULL, 64 * 1024);
}
