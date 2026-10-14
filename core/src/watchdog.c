/*
 * watchdog.c — "shroudly-core --watchdog": the small process that puts the
 * user's network settings back if Shroudly itself disappears (killed in Task
 * Manager, crashed) while they point at Shroudly. See watchdog.h.
 *
 * It used to be a script run by a second copy of Electron, about 18 MB that
 * sat idle the whole time protection was on; this is the same job in well
 * under 2 MB. The undoing itself stays in one place, Shroudly's own
 * "--restore-proxy" start, which this only launches: the logic that restores
 * after a power cut is the logic that restores after a kill.
 */
#include "platform.h"
#include "watchdog.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
  #include <wchar.h>
#else
  #include <errno.h>
  #include <fcntl.h>
  #include <signal.h>
  #include <unistd.h>
#endif

#define MAX_FILES 16
#define PATH_MAX_UTF8 2048

static char       g_files[MAX_FILES][PATH_MAX_UTF8];
static int        g_nfiles = 0;
static mutex_t    g_lock;
static long       g_app_pid = 0;
static atomic_int g_done = 0;

/* What to launch, kept as given: argv (POSIX) or the wide argv (Windows). */
#ifdef _WIN32
static wchar_t  **g_wargv = NULL;
static int        g_wfirst = 0, g_wargc = 0;
#else
static char     **g_argv = NULL;
#endif

static int app_alive(long pid) {
#ifdef _WIN32
  HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)pid);
  if (!h) return GetLastError() == ERROR_ACCESS_DENIED;
  DWORD r = WaitForSingleObject(h, 0);
  CloseHandle(h);
  return r == WAIT_TIMEOUT;
#else
  return kill((pid_t)pid, 0) == 0 || errno == EPERM;
#endif
}

static int file_exists_utf8(const char *p) {
#ifdef _WIN32
  wchar_t w[PATH_MAX_UTF8];
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, p, -1, w, PATH_MAX_UTF8)) return 0;
  return GetFileAttributesW(w) != INVALID_FILE_ATTRIBUTES;
#else
  return access(p, F_OK) == 0;
#endif
}

#ifdef _WIN32
/* One argument, quoted the way CommandLineToArgvW / the C runtime read it
 * back: backslashes only matter in front of a quote. */
static int append_quoted(wchar_t *out, size_t cap, size_t *len, const wchar_t *arg) {
  #define PUT(c) do { if (*len + 1 >= cap) return -1; out[(*len)++] = (c); } while (0)
  if (*len) PUT(L' ');
  if (arg[0] && !wcspbrk(arg, L" \t\n\v\"")) {
    for (const wchar_t *p = arg; *p; p++) PUT(*p);
    out[*len] = 0;
    return 0;
  }
  PUT(L'"');
  for (const wchar_t *p = arg;; p++) {
    size_t bs = 0;
    while (*p == L'\\') { bs++; p++; }
    if (!*p) { for (size_t i = 0; i < bs * 2; i++) PUT(L'\\'); break; }
    if (*p == L'"') { for (size_t i = 0; i < bs * 2 + 1; i++) PUT(L'\\'); PUT(L'"'); }
    else { for (size_t i = 0; i < bs; i++) PUT(L'\\'); PUT(*p); }
  }
  PUT(L'"');
  out[*len] = 0;
  return 0;
  #undef PUT
}
#endif

/* Start the restore command, detached, with nothing inherited. */
static void launch_restore(void) {
#ifdef _WIN32
  if (!g_wargv || g_wfirst >= g_wargc) return;
  static wchar_t cmd[8192];
  size_t len = 0;
  cmd[0] = 0;
  for (int i = g_wfirst; i < g_wargc; i++)
    if (append_quoted(cmd, sizeof(cmd) / sizeof(cmd[0]), &len, g_wargv[i]) != 0) return;
  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  memset(&si, 0, sizeof(si));
  si.cb = sizeof(si);
  memset(&pi, 0, sizeof(pi));
  if (CreateProcessW(g_wargv[g_wfirst], cmd, NULL, NULL, FALSE,
                     DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, NULL, NULL, &si, &pi)) {
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  }
#else
  if (!g_argv || !g_argv[0]) return;
  pid_t pid = fork();
  if (pid != 0) return;            /* parent, or fork failed */
  setsid();
  int fd = open("/dev/null", O_RDWR);
  if (fd >= 0) { dup2(fd, 0); dup2(fd, 1); dup2(fd, 2); if (fd > 2) close(fd); }
  execv(g_argv[0], g_argv);
  _exit(127);
#endif
}

/* Shroudly is gone. If it left anything applied, have it undone; then exit. */
static void finish(void) {
  int expected = 0;
  if (!atomic_compare_exchange_strong(&g_done, &expected, 1)) return;
  int left = 0;
  mutex_lock(&g_lock);
  for (int i = 0; i < g_nfiles && !left; i++) left = file_exists_utf8(g_files[i]);
  mutex_unlock(&g_lock);
  if (left) launch_restore();
  fflush(stdout);
#ifdef _WIN32
  ExitProcess(0);
#else
  _exit(0);
#endif
}

/* Should the pipe somehow not report the end, a slow check of the process. */
static void *fallback(void *arg) {
  (void)arg;
  for (;;) {
    sleep_ms(10000);
    if (!app_alive(g_app_pid)) finish();
  }
  return NULL;
}

static void watch_line(char *line) {
  char *nl = strpbrk(line, "\r\n");
  if (nl) *nl = 0;
  char *tab = strchr(line, '\t');
  if (!tab || !tab[1]) return;
  *tab = 0;
  if (strcmp(line, "proxy") != 0 && strcmp(line, "env") != 0) return;
  const char *file = tab + 1;
  if (strlen(file) >= PATH_MAX_UTF8) return;
  mutex_lock(&g_lock);
  int known = 0;
  for (int i = 0; i < g_nfiles; i++) if (!strcmp(g_files[i], file)) known = 1;
  if (!known && g_nfiles < MAX_FILES) strcpy(g_files[g_nfiles++], file);
  mutex_unlock(&g_lock);
}

int watchdog_main(int argc, char **argv) {
  /* argv: <self> --watchdog <appPid> <restore-exe> [restore-args...] */
  if (argc < 4) { fprintf(stderr, "usage: shroudly-core --watchdog <app-pid> <exe> [args...]\n"); return 2; }
  g_app_pid = atol(argv[2]);
  if (g_app_pid <= 0) return 2;
  mutex_init(&g_lock);

#ifdef _WIN32
  /* The restore command may contain any character (the install folder sits
   * under the user's name): take it from the wide command line, not from the
   * ANSI argv. shell32 is loaded only here, so the engine never links it. */
  typedef LPWSTR *(WINAPI *argv_fn)(LPCWSTR, int *);
  HMODULE sh = LoadLibraryW(L"shell32.dll");
  argv_fn to_argv = sh ? (argv_fn)(void *)GetProcAddress(sh, "CommandLineToArgvW") : NULL;
  if (to_argv) g_wargv = to_argv(GetCommandLineW(), &g_wargc);
  g_wfirst = 3;
  if (!g_wargv || g_wargc < 4) return 2;
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
#else
  g_argv = argv + 3;
  signal(SIGPIPE, SIG_IGN);
  /* Shroudly being stopped normally ends this too (the pipe closes); a
   * terminal hang-up must not, the pipe decides. */
  signal(SIGHUP, SIG_IGN);
#endif

  thread_spawn(fallback, NULL, 64 * 1024);

  /* "proxy<TAB><file>" / "env<TAB><file>": what to look after. The pipe
   * closing is the signal that Shroudly is ending, however it ends. */
  char line[PATH_MAX_UTF8 + 16];
  while (fgets(line, sizeof(line), stdin)) watch_line(line);

  /* Give a normal quit a moment to finish (it removes the files first). */
  for (int i = 0; i < 50; i++) {
    if (!app_alive(g_app_pid)) finish();
    sleep_ms(200);
  }
  /* Still alive with the pipe closed: leave it to the slow check. */
  for (;;) sleep_ms(60000);
  return 0;
}
