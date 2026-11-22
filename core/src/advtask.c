/*
 * advtask.c — Advanced mode started with the permission given once (Windows).
 * See advtask.h.
 */
#if defined(_WIN32) && defined(SHROUDLY_RAW)
  #define COBJMACROS
  #include <winsock2.h>
  #include <windows.h>
  #include <ole2.h>
  #include <oleauto.h>
  #include <sddl.h>
  #include <lmcons.h>
  #include <taskschd.h>
  #include <stdio.h>
  #include <stdlib.h>
  #include <wchar.h>
#endif

#include "advtask.h"

#include <string.h>

/* ── the request (every system) ─────────────────────────────────────────── */

static int digits(const char *s, size_t max) {
  size_t n = strlen(s);
  if (n < 1 || n > max) return 0;
  for (size_t i = 0; i < n; i++) if (s[i] < '0' || s[i] > '9') return 0;
  return 1;
}

static int word(const char *s) {
  size_t n = strlen(s);
  if (n < 1 || n > 16) return 0;
  for (size_t i = 0; i < n; i++) if (s[i] < 'a' || s[i] > 'z') return 0;
  return 1;
}

static int host(const char *s) {
  size_t n = strlen(s);
  if (n < 4 || n > 253) return 0;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-')) return 0;
  }
  return s[0] != '-' && s[0] != '.';
}

/* What a request may carry: the packet options of electron/advanced-mode.js
 * buildArgs, and the app's process id. f: no value; n: a number; w: a word;
 * h: a host name. Nothing that names a file. */
static const struct { const char *name; char kind; } OPTS[] = {
  { "--advanced", 'f' }, { "--no-quic-block", 'f' }, { "--no-udp-fake", 'f' },
  { "--fake-ttl", 'n' }, { "--parent-pid", 'n' }, { "--drop-rst", 'n' }, { "--autottl", 'n' },
  { "--seqovl", 'n' }, { "--tlsrec", 'n' }, { "--keep-driver", 'n' }, { "--fake-repeats", 'n' },
  { "--dns-gate", 'n' },
  { "--split", 'w' }, { "--desync-mode", 'w' },
  { "--decoy-name", 'h' },
};

static char kind_of(const char *name) {
  for (size_t i = 0; i < sizeof(OPTS) / sizeof(OPTS[0]); i++) if (!strcmp(OPTS[i].name, name)) return OPTS[i].kind;
  return 0;
}

int advtask_parse(char *text, size_t len, char id[ADVTASK_ID_LEN + 1], char **argv, int max, int *uninstall) {
  if (!text || !id || !argv || !uninstall || len == 0 || len > ADVTASK_REQ_MAX) return -1;
  *uninstall = 0;
  id[0] = 0;
  text[len] = 0;
  /* Printable ASCII and line ends only. */
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)text[i];
    if (c == '\n') continue;
    if (c == '\r' && i + 1 < len && text[i + 1] == '\n') continue;
    if (c < 0x20 || c > 0x7e) return -1;
  }
  int n = 0, line = 0, pid_seen = 0;
  char pending = 0;          /* the kind of value the option before waits for */
  char *p = text, *end = text + len;
  while (p < end) {
    char *nl = memchr(p, '\n', (size_t)(end - p));
    char *next = nl ? nl + 1 : end;
    char *stop = nl ? nl : end;
    if (stop > p && stop[-1] == '\r') stop--;
    *stop = 0;
    if (line == 0) {
      if (strcmp(p, "shroudly-advanced 1") != 0) return -1;
    } else if (line == 1) {
      if (!strcmp(p, "uninstall")) *uninstall = 1;
      else {
        if (strncmp(p, "id ", 3) != 0 || strlen(p + 3) != ADVTASK_ID_LEN) return -1;
        for (int i = 0; i < ADVTASK_ID_LEN; i++) {
          char c = p[3 + i];
          if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return -1;
        }
        memcpy(id, p + 3, ADVTASK_ID_LEN);
        id[ADVTASK_ID_LEN] = 0;
      }
    } else {
      /* An empty line only as the very end of the text. */
      if (!*p) { if (next < end) return -1; break; }
      if (*uninstall) return -1;
      if (n >= max) return -1;
      if (pending) {
        if (pending == 'n' && !digits(p, 10)) return -1;
        if (pending == 'w' && !word(p)) return -1;
        if (pending == 'h' && !host(p)) return -1;
        if (pending == 'n' && n > 0 && !strcmp(argv[n - 1], "--parent-pid")) pid_seen = strspn(p, "0") != strlen(p);
        pending = 0;
      } else {
        char k = kind_of(p);
        if (!k) return -1;
        if (k != 'f') pending = k;
      }
      argv[n++] = p;
    }
    line++;
    p = next;
  }
  if (line < 2 || pending) return -1;
  if (*uninstall) return 0;
  /* An engine nobody is the parent of would never end. */
  if (!pid_seen) return -1;
  return n;
}

/* ── Windows: the copies, the task, and a start by the task ─────────────── */
#if defined(_WIN32) && defined(SHROUDLY_RAW)

static const GUID K_CLSID_TaskScheduler = { 0x0f87369f, 0xa4e5, 0x4cfc, { 0xbd, 0x3e, 0x73, 0xe6, 0x15, 0x45, 0x72, 0xdd } };
static const GUID K_IID_ITaskService    = { 0x2faba4c7, 0x4da9, 0x4013, { 0x96, 0x97, 0x20, 0xcc, 0x3f, 0xd4, 0x0f, 0x85 } };

static const wchar_t *FILES[] = { L"shroudly-core-adv.exe", L"WinDivert.dll", L"WinDivert64.sys" };

static int is_plain_dir(const wchar_t *p) {
  DWORD at = GetFileAttributesW(p);
  return at != INVALID_FILE_ATTRIBUTES && (at & FILE_ATTRIBUTE_DIRECTORY) && !(at & FILE_ATTRIBUTE_REPARSE_POINT);
}

/* <Common Files>\Shroudly\advanced, as Windows keeps Common Files (the
 * registry, never %CommonProgramFiles%, which whoever starts this could set
 * to anywhere). make: created when missing. */
static int admin_dir(wchar_t out[MAX_PATH], int make) {
  DWORD sz = MAX_PATH * sizeof(wchar_t);
  if (RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion", L"CommonFilesDir",
                   RRF_RT_REG_SZ, NULL, out, &sz) != ERROR_SUCCESS) return 0;
  out[MAX_PATH - 1] = 0;
  size_t n = wcslen(out);
  if (n < 3 || out[1] != L':' || out[2] != L'\\' || n + 80 >= MAX_PATH) return 0;
  /* Nothing a task's XML would read as markup. */
  if (wcspbrk(out, L"<>&\"'")) return 0;
  if (!is_plain_dir(out)) return 0;
  static const wchar_t *parts[] = { L"\\Shroudly", L"\\advanced" };
  for (int i = 0; i < 2; i++) {
    wcscat(out, parts[i]);
    if (make && !CreateDirectoryW(out, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) return 0;
    if (!is_plain_dir(out)) return 0;
  }
  return 1;
}

/* %LOCALAPPDATA%\Shroudly\advanced: the user's own, where the app leaves its
 * request. Only ever read from. */
static int user_dir(wchar_t out[MAX_PATH]) {
  DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", out, MAX_PATH);
  if (n < 3 || n + 80 >= MAX_PATH || out[1] != L':' || out[2] != L'\\') return 0;
  wcscat(out, L"\\Shroudly\\advanced");
  return 1;
}

static int own_name(wchar_t out[UNLEN + 1]) {
  DWORD n = UNLEN + 1;
  return GetUserNameW(out, &n) && out[0];
}

static int own_sid(wchar_t *out, size_t max) {
  HANDLE tok = NULL;
  union { TOKEN_USER u; BYTE b[256]; } tu;
  DWORD got = 0;
  LPWSTR s = NULL;
  int ok = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) return 0;
  if (GetTokenInformation(tok, TokenUser, &tu, sizeof(tu), &got) && ConvertSidToStringSidW(tu.u.User.Sid, &s) && s) {
    if (wcslen(s) < max) { wcscpy(out, s); ok = 1; }
    LocalFree(s);
  }
  CloseHandle(tok);
  return ok;
}

/* The task's name: one per user, so two users of one PC never take each
 * other's. A user name has none of the characters a task name may not. */
static void task_name(wchar_t *out, size_t max, const wchar_t *user) {
  _snwprintf(out, max, L"Shroudly Advanced mode (%ls)", user);
  out[max - 1] = 0;
}

static int same_bytes(const wchar_t *a, const wchar_t *b) {
  HANDLE fa = CreateFileW(a, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
  HANDLE fb = CreateFileW(b, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
  int same = fa != INVALID_HANDLE_VALUE && fb != INVALID_HANDLE_VALUE;
  static BYTE ba[65536], bb[65536];
  while (same) {
    DWORD na = 0, nb = 0;
    if (!ReadFile(fa, ba, sizeof(ba), &na, NULL) || !ReadFile(fb, bb, sizeof(bb), &nb, NULL) || na != nb) { same = 0; break; }
    if (na == 0) break;
    if (memcmp(ba, bb, na) != 0) same = 0;
  }
  if (fa != INVALID_HANDLE_VALUE) CloseHandle(fa);
  if (fb != INVALID_HANDLE_VALUE) CloseHandle(fb);
  return same;
}

/* The root folder of the Task Scheduler. COM stays initialised for the
 * short life of the process that asks. */
static HRESULT task_root(ITaskService **svc, ITaskFolder **root) {
  *svc = NULL; *root = NULL;
  HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
  if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) return hr;
  hr = CoCreateInstance(&K_CLSID_TaskScheduler, NULL, CLSCTX_INPROC_SERVER, &K_IID_ITaskService, (void **)svc);
  if (FAILED(hr)) return hr;
  VARIANT none; VariantInit(&none);
  hr = ITaskService_Connect(*svc, none, none, none, none);
  if (SUCCEEDED(hr)) {
    BSTR path = SysAllocString(L"\\");
    hr = path ? ITaskService_GetFolder(*svc, path, root) : E_OUTOFMEMORY;
    SysFreeString(path);
  }
  if (FAILED(hr)) { ITaskService_Release(*svc); *svc = NULL; }
  return hr;
}

/* On demand only (no trigger), as this user, with the highest privileges;
 * never stopped for being on battery or for running long, at the usual
 * priority (a task's default is below it), and a new start never waits for
 * an engine that is still on its way out. */
static HRESULT register_task(const wchar_t *name, const wchar_t *sid, const wchar_t *dir) {
  static wchar_t xml[4096], sddl[256];
  _snwprintf(xml, 4096,
    L"<?xml version=\"1.0\" encoding=\"UTF-16\"?>"
    L"<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">"
    L"<RegistrationInfo><Author>Shroudly</Author><Description>Starts Shroudly's Advanced mode with the administrator "
    L"permission given once, when Shroudly asks for it. Removed when Shroudly is uninstalled.</Description></RegistrationInfo>"
    L"<Triggers />"
    L"<Principals><Principal id=\"Author\"><UserId>%ls</UserId><LogonType>InteractiveToken</LogonType>"
    L"<RunLevel>HighestAvailable</RunLevel></Principal></Principals>"
    L"<Settings><MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>"
    L"<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"
    L"<AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>false</StartWhenAvailable>"
    L"<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>"
    L"<IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>"
    L"<AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden>"
    L"<RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun>"
    L"<ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>4</Priority></Settings>"
    L"<Actions Context=\"Author\"><Exec><Command>\"%ls\\%ls\"</Command><Arguments>--task</Arguments></Exec></Actions>"
    L"</Task>", sid, dir, FILES[0]);
  xml[4095] = 0;
  /* Administrators and the system: everything. This user: read and run,
   * nothing else (not change, not delete). Nobody else, and nothing
   * inherited from the tasks' folder (P), which would give the user who
   * registered it everything. */
  _snwprintf(sddl, 256, L"D:P(A;;FA;;;BA)(A;;FA;;;SY)(A;;GRGX;;;%ls)", sid);
  sddl[255] = 0;

  ITaskService *svc; ITaskFolder *root;
  HRESULT hr = task_root(&svc, &root);
  if (FAILED(hr)) return hr;
  BSTR bname = SysAllocString(name), bxml = SysAllocString(xml);
  VARIANT none, sd;
  VariantInit(&none);
  VariantInit(&sd);
  sd.vt = VT_BSTR;
  sd.bstrVal = SysAllocString(sddl);
  IRegisteredTask *task = NULL;
  if (!bname || !bxml || !sd.bstrVal) hr = E_OUTOFMEMORY;
  else {
    hr = ITaskFolder_RegisterTask(root, bname, bxml, TASK_CREATE_OR_UPDATE, none, none, TASK_LOGON_INTERACTIVE_TOKEN, sd, &task);
    /* A Windows that will not take the access list: its own (the task's
     * user may start it there too). */
    if (FAILED(hr)) hr = ITaskFolder_RegisterTask(root, bname, bxml, TASK_CREATE_OR_UPDATE, none, none, TASK_LOGON_INTERACTIVE_TOKEN, none, &task);
  }
  if (task) IRegisteredTask_Release(task);
  SysFreeString(bname); SysFreeString(bxml); SysFreeString(sd.bstrVal);
  ITaskFolder_Release(root);
  ITaskService_Release(svc);
  return hr;
}

static void install_result(const wchar_t *run, int ok, const char *why, HRESULT hr) {
  wchar_t path[MAX_PATH];
  _snwprintf(path, MAX_PATH, L"%ls\\install.log", run); path[MAX_PATH - 1] = 0;
  HANDLE f = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (f == INVALID_HANDLE_VALUE) return;
  char line[160];
  int n = snprintf(line, sizeof(line), "{\"type\":\"task_install\",\"ok\":%d,\"why\":\"%s\",\"hr\":\"0x%08lx\"}\n", ok, why, (unsigned long)hr);
  DWORD wrote = 0;
  if (n > 0) WriteFile(f, line, (DWORD)n, &wrote, NULL);
  CloseHandle(f);
}

int advtask_install(const char *user_utf8) {
  wchar_t want[UNLEN + 1], user[UNLEN + 1], sid[128], dir[MAX_PATH], run[MAX_PATH], src[MAX_PATH], from[MAX_PATH], to[MAX_PATH], name[UNLEN + 64];
  if (!user_utf8 || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, user_utf8, -1, want, UNLEN + 1)) return 2;
  /* Asked by one user and allowed by another (an administrator's password
   * typed for a standard user): the task would be the administrator's, and
   * the user who asked could not start it. Nothing is installed then. */
  if (!own_name(user) || _wcsicmp(user, want) != 0) return 3;
  if (!own_sid(sid, 128)) return 3;
  if (!admin_dir(dir, 1)) return 4;
  _snwprintf(run, MAX_PATH, L"%ls\\run", dir); run[MAX_PATH - 1] = 0;
  if (!CreateDirectoryW(run, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) return 4;
  if (!is_plain_dir(run)) return 4;

  DWORD n = GetModuleFileNameW(NULL, src, MAX_PATH);
  wchar_t *slash = (n > 0 && n < MAX_PATH) ? wcsrchr(src, L'\\') : NULL;
  if (!slash) { install_result(run, 0, "self", 0); return 5; }
  *slash = 0;
  if (wcslen(src) + 32 >= MAX_PATH) { install_result(run, 0, "self", 0); return 5; }
  for (int i = 0; i < 3; i++) {
    _snwprintf(from, MAX_PATH, L"%ls\\%ls", src, FILES[i]); from[MAX_PATH - 1] = 0;
    _snwprintf(to, MAX_PATH, L"%ls\\%ls", dir, FILES[i]); to[MAX_PATH - 1] = 0;
    if (_wcsicmp(from, to) == 0) continue;
    /* One in use (the driver loaded from it) cannot be replaced: the same
     * bytes there are as good; anything else is not used. */
    if (!same_bytes(from, to)) {
      CopyFileW(from, to, FALSE);
      if (!same_bytes(from, to)) { install_result(run, 0, "copy", (HRESULT)GetLastError()); return 6; }
    }
  }
  task_name(name, UNLEN + 64, user);
  HRESULT hr = register_task(name, sid, dir);
  install_result(run, SUCCEEDED(hr) ? 1 : 0, SUCCEEDED(hr) ? "ok" : "register", hr);
  return SUCCEEDED(hr) ? 0 : 7;
}

void advtask_install_spawn(int *argc, char **argv) {
  int at = -1;
  for (int i = 1; i + 1 < *argc; i++) if (!strcmp(argv[i], "--task-install")) { at = i; break; }
  if (at < 0) return;
  const char *user = argv[at + 1];
  wchar_t wuser[UNLEN + 1], self[MAX_PATH];
  static wchar_t cmd[MAX_PATH + UNLEN + 64];
  int ok = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, user, -1, wuser, UNLEN + 1) > 0
        && !wcspbrk(wuser, L"\"\\") && wuser[0];
  for (int i = at; i + 2 <= *argc; i++) argv[i] = argv[i + 2];
  *argc -= 2;
  if (!ok) return;
  DWORD n = GetModuleFileNameW(NULL, self, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) return;
  _snwprintf(cmd, MAX_PATH + UNLEN + 64, L"\"%ls\" --task-install-only \"%ls\"", self, wuser);
  cmd[MAX_PATH + UNLEN + 63] = 0;
  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  memset(&si, 0, sizeof(si));
  si.cb = sizeof(si);
  if (CreateProcessW(self, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  }
}

/* The task and the copies taken away again. The engine cannot delete its
 * own running file: Windows does, at its next start. */
static int uninstall(void) {
  wchar_t user[UNLEN + 1], name[UNLEN + 64], dir[MAX_PATH], path[MAX_PATH], pat[MAX_PATH];
  if (own_name(user)) {
    task_name(name, UNLEN + 64, user);
    ITaskService *svc; ITaskFolder *root;
    if (SUCCEEDED(task_root(&svc, &root))) {
      BSTR b = SysAllocString(name);
      if (b) ITaskFolder_DeleteTask(root, b, 0);
      SysFreeString(b);
      ITaskFolder_Release(root);
      ITaskService_Release(svc);
    }
  }
  if (!admin_dir(dir, 0)) return 0;
  _snwprintf(pat, MAX_PATH, L"%ls\\run\\*", dir); pat[MAX_PATH - 1] = 0;
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(pat, &fd);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
      _snwprintf(path, MAX_PATH, L"%ls\\run\\%ls", dir, fd.cFileName); path[MAX_PATH - 1] = 0;
      DeleteFileW(path);
    } while (FindNextFileW(h, &fd));
    FindClose(h);
  }
  _snwprintf(path, MAX_PATH, L"%ls\\run", dir); path[MAX_PATH - 1] = 0;
  if (!RemoveDirectoryW(path)) MoveFileExW(path, NULL, MOVEFILE_DELAY_UNTIL_REBOOT);
  for (int i = 2; i >= 0; i--) {
    _snwprintf(path, MAX_PATH, L"%ls\\%ls", dir, FILES[i]); path[MAX_PATH - 1] = 0;
    if (!DeleteFileW(path) && GetLastError() != ERROR_FILE_NOT_FOUND) MoveFileExW(path, NULL, MOVEFILE_DELAY_UNTIL_REBOOT);
  }
  if (!RemoveDirectoryW(dir)) MoveFileExW(dir, NULL, MOVEFILE_DELAY_UNTIL_REBOOT);
  return 0;
}

static char *utf8_of(const wchar_t *w) {
  int len = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
  char *s = len > 0 ? malloc((size_t)len) : NULL;
  if (s && !WideCharToMultiByte(CP_UTF8, 0, w, -1, s, len, NULL, NULL)) { free(s); s = NULL; }
  return s;
}

int advtask_task(int *argc, char ***argv) {
  static char text[ADVTASK_REQ_MAX + 1];
  static char *req[ADVTASK_MAX_ARGS];
  static char *out[ADVTASK_MAX_ARGS + 8];
  wchar_t udir[MAX_PATH], adir[MAX_PATH], path[MAX_PATH], pat[MAX_PATH], wid[ADVTASK_ID_LEN + 1];
  char id[ADVTASK_ID_LEN + 1];
  int un = 0;

  if (!user_dir(udir)) return 3;
  _snwprintf(path, MAX_PATH, L"%ls\\request", udir); path[MAX_PATH - 1] = 0;
  HANDLE f = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
  if (f == INVALID_HANDLE_VALUE) return 3;
  LARGE_INTEGER size;
  DWORD got = 0;
  int ok = GetFileType(f) == FILE_TYPE_DISK && GetFileSizeEx(f, &size) && size.QuadPart > 0 && size.QuadPart <= ADVTASK_REQ_MAX
        && ReadFile(f, text, ADVTASK_REQ_MAX, &got, NULL) && got == (DWORD)size.QuadPart;
  CloseHandle(f);
  if (!ok) return 3;
  int n = advtask_parse(text, got, id, req, ADVTASK_MAX_ARGS, &un);
  if (n < 0) return 3;
  if (un) return uninstall() == 0 ? 1 : 3;

  /* Run only from the copies' own folder, and write only there. */
  if (!admin_dir(adir, 0)) return 4;
  DWORD ml = GetModuleFileNameW(NULL, path, MAX_PATH);
  wchar_t *slash = (ml > 0 && ml < MAX_PATH) ? wcsrchr(path, L'\\') : NULL;
  if (!slash) return 4;
  *slash = 0;
  if (_wcsicmp(path, adir) != 0) return 4;
  for (int i = 0; i <= ADVTASK_ID_LEN; i++) wid[i] = (wchar_t)id[i];

  /* A new file: an id is used once, so a request started twice (or again
   * by someone else) never takes over a running engine's status. */
  wchar_t own[ADVTASK_ID_LEN + 8], spath[MAX_PATH];
  _snwprintf(own, ADVTASK_ID_LEN + 8, L"%ls.log", wid); own[ADVTASK_ID_LEN + 7] = 0;
  _snwprintf(spath, MAX_PATH, L"%ls\\run\\%ls", adir, own); spath[MAX_PATH - 1] = 0;
  HANDLE s = CreateFileW(spath, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (s == INVALID_HANDLE_VALUE) return 5;
  CloseHandle(s);
  /* The status files of engines that have ended (one still running keeps
   * its own open, and it stays). */
  _snwprintf(pat, MAX_PATH, L"%ls\\run\\*.log", adir); pat[MAX_PATH - 1] = 0;
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(pat, &fd);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || !_wcsicmp(fd.cFileName, L"install.log") || !_wcsicmp(fd.cFileName, own)) continue;
      _snwprintf(path, MAX_PATH, L"%ls\\run\\%ls", adir, fd.cFileName); path[MAX_PATH - 1] = 0;
      DeleteFileW(path);
    } while (FindNextFileW(h, &fd));
    FindClose(h);
  }

  int k = 0;
  out[k++] = (*argv)[0];
  for (int i = 0; i < n; i++) out[k++] = req[i];
  out[k++] = "--status-file";
  if (!(out[k++] = utf8_of(spath))) return 5;
  _snwprintf(path, MAX_PATH, L"%ls\\%ls", udir, wid); path[MAX_PATH - 1] = 0;
  out[k++] = "--control-base";
  if (!(out[k++] = utf8_of(path))) return 5;
  out[k++] = "--from-task";
  out[k] = NULL;
  *argc = k;
  *argv = out;
  return 0;
}

#endif
