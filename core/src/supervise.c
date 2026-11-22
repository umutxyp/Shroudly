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
static sup_teardown_fn g_report = NULL;
static int g_report_every = 0;
static volatile sig_atomic_t g_signalled = 0;
static char g_esc_path[1100];
static sup_lines_fn g_esc_fn = NULL;
static long g_esc_off = 0;
static char g_standby_path[1100];
static sup_teardown_fn g_pause = NULL, g_resume = NULL;
static int g_in_standby = 0;
static char g_ctl_base[1024];
static int g_ctl_keep = 0;

int sup_redirect_output(const char *status_file) {
#ifdef _WIN32
  if (!freopen_utf8(status_file, "w", stdout)) return -1;
  /* stderr into the same file. One that is not open at all (no console and
   * no streams handed over; main.c opens those on NUL) cannot be pointed
   * anywhere: said then on stdout alone rather than not starting. */
  if (_fileno(stdout) < 0) return -1;
  if (_fileno(stderr) >= 0 && _dup2(_fileno(stdout), _fileno(stderr)) != 0) return -1;
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
  FILE *f = fopen_utf8(p, "rb");
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

void sup_set_escalate(sup_lines_fn fn) { g_esc_fn = fn; }

void sup_set_standby(sup_teardown_fn pause, sup_teardown_fn resume) { g_pause = pause; g_resume = resume; }

void sup_set_control(const char *base, int keep) {
  g_ctl_base[0] = '\0';
  if (base && base[0]) snprintf(g_ctl_base, sizeof(g_ctl_base), "%s", base);
  g_ctl_keep = keep ? 1 : 0;
}

/* F.standby there: the hook let go; gone: taken again. */
static void standby_poll(void) {
  if (!g_pause || !g_resume || !g_standby_path[0]) return;
  int want = file_exists(g_standby_path);
  if (want && !g_in_standby) { g_in_standby = 1; g_pause(); }
  else if (!want && g_in_standby) { g_in_standby = 0; g_resume(); }
}

/* What the app added to F.escalate since the last look. */
static void escalate_poll(void) {
  if (!g_esc_fn || !g_esc_path[0] || g_esc_off >= SUP_ESCALATE_MAX) return;
#ifdef _WIN32
  FILE *f = fopen_utf8(g_esc_path, "rb");
  if (!f) return;
#else
  int fd = open(g_esc_path, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return;
  FILE *f = fdopen(fd, "rb");
  if (!f) { close(fd); return; }
#endif
  char buf[4096];
  if (fseek(f, g_esc_off, SEEK_SET) == 0) {
    size_t n = fread(buf, 1, sizeof(buf), f);
    if (n > 0) g_esc_off += g_esc_fn(buf, (int)n);
    /* A line longer than the buffer is no address: skipped whole. */
    if (n == sizeof(buf) && !memchr(buf, '\n', n)) g_esc_off += (long)n;
  }
  fclose(f);
}

#ifndef _WIN32
static void on_signal(int sig) { (void)sig; g_signalled = 1; }
#endif

static void *watchdog(void *arg) {
  (void)arg;
  uint64_t last = now_ms();
  for (;;) {
    sleep_ms(250);
    if (g_signalled) break;
    if (g_parent_pid > 0 && !parent_alive(g_parent_pid)) break;
    if (g_stop_path[0] && file_exists(g_stop_path)) break;
    escalate_poll();
    standby_poll();
    if (g_report && g_report_every > 0 && now_ms() - last >= (uint64_t)g_report_every) {
      last = now_ms();
      g_report();
    }
  }
  if (g_teardown) g_teardown();
  if (g_report) g_report();
  if (!g_ctl_keep) {
    if (g_stop_path[0]) remove_utf8(g_stop_path);
    if (g_standby_path[0]) remove_utf8(g_standby_path);
  }
  printf("{\"type\":\"stopped\"}\n");
  fflush(stdout);
#ifdef _WIN32
  ExitProcess(0); /* closes the WinDivert handle, which detaches the filter */
#else
  _exit(0);       /* the kernel drops the NFQUEUE binding with our socket */
#endif
  return NULL;
}

void sup_set_report(sup_teardown_fn report, int every_ms) {
  g_report = report;
  g_report_every = every_ms > 0 ? every_ms : 0;
}

int sup_start(const char *status_file, long parent_pid, sup_teardown_fn teardown) {
  g_parent_pid = parent_pid;
  g_teardown = teardown;
  g_stop_path[0] = '\0';
  g_esc_path[0] = '\0';
  g_standby_path[0] = '\0';
  g_in_standby = 0;
  g_esc_off = 0;
  const char *base = g_ctl_base[0] ? g_ctl_base : status_file;
  if (base && base[0]) {
    snprintf(g_stop_path, sizeof(g_stop_path), "%s.stop", base);
    snprintf(g_esc_path, sizeof(g_esc_path), "%s.escalate", base);
    snprintf(g_standby_path, sizeof(g_standby_path), "%s.standby", base);
  }
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
