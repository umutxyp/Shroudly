/*
 * winreg.c — "shroudly-core --reg ...": Windows' registry where Windows will
 * not start reg.exe (issue #64: a policy, AppLocker or a security program
 * refused it, even to an administrator, and protection could not start). The
 * app runs reg.exe first and comes here only when reg.exe could not start at
 * all (electron/win-reg.js).
 *
 * It takes reg.exe's own arguments for what the app uses, and answers the way
 * reg.exe does, so the app reads both the same:
 *   query KEY [/v NAME | /ve] [/s]
 *   add KEY [/v NAME | /ve] [/t TYPE] [/d DATA] [/f]
 *   delete KEY [/v NAME | /ve] [/f]
 *   refresh          (WinINET told the proxy setting changed; no reg.exe form)
 * Exit 0 when done, 1 when the key or value is not there or Windows refused
 * (reg.exe's codes); the reason goes to stderr. Output is UTF-8. Always the
 * 64-bit registry view, as the 64-bit reg.exe sees it.
 */
#include "platform.h"
#include "winreg.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef _WIN32

int winreg_main(int argc, char **argv) {
  (void)argc; (void)argv;
  fprintf(stderr, "ERROR: --reg is for Windows\n");
  return 2;
}

#else

#include <fcntl.h>
#include <io.h>
#include <wchar.h>

static wchar_t **g_argv = NULL;
static int g_argc = 0;

/* advapi32 and shell32 are loaded here only, so the engine itself links
 * neither (as main.c and watchdog.c do with shell32). */
typedef LONG (WINAPI *open_fn)(HKEY, LPCWSTR, DWORD, REGSAM, PHKEY);
typedef LONG (WINAPI *query_fn)(HKEY, LPCWSTR, LPDWORD, LPDWORD, LPBYTE, LPDWORD);
typedef LONG (WINAPI *enumv_fn)(HKEY, DWORD, LPWSTR, LPDWORD, LPDWORD, LPDWORD, LPBYTE, LPDWORD);
typedef LONG (WINAPI *enumk_fn)(HKEY, DWORD, LPWSTR, LPDWORD, LPDWORD, LPWSTR, LPDWORD, PFILETIME);
typedef LONG (WINAPI *create_fn)(HKEY, LPCWSTR, DWORD, LPWSTR, DWORD, REGSAM, const LPSECURITY_ATTRIBUTES, PHKEY, LPDWORD);
typedef LONG (WINAPI *set_fn)(HKEY, LPCWSTR, DWORD, DWORD, const BYTE *, DWORD);
typedef LONG (WINAPI *delv_fn)(HKEY, LPCWSTR);
typedef LONG (WINAPI *deltree_fn)(HKEY, LPCWSTR);
typedef LONG (WINAPI *delkey_fn)(HKEY, LPCWSTR, REGSAM, DWORD);
typedef LONG (WINAPI *close_fn)(HKEY);
typedef LPWSTR *(WINAPI *argv_fn)(LPCWSTR, int *);
static open_fn p_open; static query_fn p_query; static enumv_fn p_enumv; static enumk_fn p_enumk;
static create_fn p_create; static set_fn p_set; static delv_fn p_delv; static deltree_fn p_deltree;
static delkey_fn p_delkey; static close_fn p_close;

static int load_api(void) {
  HMODULE a = LoadLibraryW(L"advapi32.dll");
  if (!a) return 0;
  p_open = (open_fn)(void *)GetProcAddress(a, "RegOpenKeyExW");
  p_query = (query_fn)(void *)GetProcAddress(a, "RegQueryValueExW");
  p_enumv = (enumv_fn)(void *)GetProcAddress(a, "RegEnumValueW");
  p_enumk = (enumk_fn)(void *)GetProcAddress(a, "RegEnumKeyExW");
  p_create = (create_fn)(void *)GetProcAddress(a, "RegCreateKeyExW");
  p_set = (set_fn)(void *)GetProcAddress(a, "RegSetValueExW");
  p_delv = (delv_fn)(void *)GetProcAddress(a, "RegDeleteValueW");
  p_deltree = (deltree_fn)(void *)GetProcAddress(a, "RegDeleteTreeW");
  p_delkey = (delkey_fn)(void *)GetProcAddress(a, "RegDeleteKeyExW");
  p_close = (close_fn)(void *)GetProcAddress(a, "RegCloseKey");
  return p_open && p_query && p_enumv && p_enumk && p_create && p_set && p_delv && p_deltree && p_delkey && p_close;
}

static void out_w(const wchar_t *s) {
  int n = WideCharToMultiByte(CP_UTF8, 0, s, -1, NULL, 0, NULL, NULL);
  if (n <= 1) return;
  char *b = (char *)malloc((size_t)n);
  if (!b) return;
  WideCharToMultiByte(CP_UTF8, 0, s, -1, b, n, NULL, NULL);
  fputs(b, stdout);
  free(b);
}

static int fail(const char *why) {
  fprintf(stderr, "ERROR: %s\n", why);
  return 1;
}

static int fail_code(LONG rc) {
  if (rc == ERROR_FILE_NOT_FOUND || rc == ERROR_PATH_NOT_FOUND)
    return fail("The system was unable to find the specified registry key or value.");
  if (rc == ERROR_ACCESS_DENIED) return fail("Access is denied.");
  fprintf(stderr, "ERROR: Windows error %ld\n", (long)rc);
  return 1;
}

/* "HKCU\Software\..." -> the root and the rest; the root's long name for
 * the lines reg.exe prints. */
static HKEY split_root(const wchar_t *key, const wchar_t **rest, const wchar_t **longname) {
  static const struct { const wchar_t *s, *l; HKEY k; } roots[] = {
    { L"HKCU", L"HKEY_CURRENT_USER", HKEY_CURRENT_USER },
    { L"HKEY_CURRENT_USER", L"HKEY_CURRENT_USER", HKEY_CURRENT_USER },
    { L"HKLM", L"HKEY_LOCAL_MACHINE", HKEY_LOCAL_MACHINE },
    { L"HKEY_LOCAL_MACHINE", L"HKEY_LOCAL_MACHINE", HKEY_LOCAL_MACHINE },
    { L"HKCR", L"HKEY_CLASSES_ROOT", HKEY_CLASSES_ROOT },
    { L"HKEY_CLASSES_ROOT", L"HKEY_CLASSES_ROOT", HKEY_CLASSES_ROOT },
    { L"HKU", L"HKEY_USERS", HKEY_USERS },
    { L"HKEY_USERS", L"HKEY_USERS", HKEY_USERS },
    { L"HKCC", L"HKEY_CURRENT_CONFIG", HKEY_CURRENT_CONFIG },
    { L"HKEY_CURRENT_CONFIG", L"HKEY_CURRENT_CONFIG", HKEY_CURRENT_CONFIG },
  };
  const wchar_t *slash = wcschr(key, L'\\');
  size_t n = slash ? (size_t)(slash - key) : wcslen(key);
  for (size_t i = 0; i < sizeof(roots) / sizeof(roots[0]); i++) {
    if (wcslen(roots[i].s) == n && !_wcsnicmp(key, roots[i].s, n)) {
      *rest = slash ? slash + 1 : L"";
      *longname = roots[i].l;
      return roots[i].k;
    }
  }
  return NULL;
}

static const wchar_t *type_name(DWORD t) {
  switch (t) {
    case REG_SZ: return L"REG_SZ";
    case REG_EXPAND_SZ: return L"REG_EXPAND_SZ";
    case REG_MULTI_SZ: return L"REG_MULTI_SZ";
    case REG_DWORD: return L"REG_DWORD";
    case REG_QWORD: return L"REG_QWORD";
    case REG_BINARY: return L"REG_BINARY";
    case REG_NONE: return L"REG_NONE";
    default: return L"REG_UNKNOWN";
  }
}

/* "    NAME    REG_SZ    data", as reg.exe prints it. */
static void print_value(const wchar_t *name, DWORD type, const BYTE *data, DWORD size) {
  out_w(L"    ");
  out_w(name && name[0] ? name : L"(Default)");
  out_w(L"    ");
  out_w(type_name(type));
  out_w(L"    ");
  wchar_t buf[64];
  if (type == REG_SZ || type == REG_EXPAND_SZ || type == REG_MULTI_SZ) {
    size_t chars = size / sizeof(wchar_t);
    wchar_t *s = (wchar_t *)calloc(chars + 2, sizeof(wchar_t));
    if (s) {
      memcpy(s, data, size);
      /* A list's entries are shown joined by "\0", as reg.exe does. */
      if (type == REG_MULTI_SZ) {
        size_t len = chars;
        while (len && s[len - 1] == 0) len--;
        for (size_t i = 0; i < len; i++) {
          if (s[i] == 0) out_w(L"\\0");
          else { wchar_t c[2] = { s[i], 0 }; out_w(c); }
        }
      } else {
        out_w(s);
      }
      free(s);
    }
  } else if (type == REG_DWORD && size >= 4) {
    DWORD v; memcpy(&v, data, 4);
    swprintf(buf, 64, L"0x%lx", (unsigned long)v);
    out_w(buf);
  } else if (type == REG_QWORD && size >= 8) {
    unsigned long long v; memcpy(&v, data, 8);
    swprintf(buf, 64, L"0x%llx", v);
    out_w(buf);
  } else {
    for (DWORD i = 0; i < size; i++) { swprintf(buf, 64, L"%02X", data[i]); out_w(buf); }
  }
  out_w(L"\r\n");
}

static int read_value(HKEY k, const wchar_t *name, DWORD *type, BYTE **data, DWORD *size) {
  DWORD sz = 0, t = 0;
  LONG rc = p_query(k, name, NULL, &t, NULL, &sz);
  if (rc != ERROR_SUCCESS) return (int)rc;
  BYTE *b = (BYTE *)malloc(sz + 4);
  if (!b) return ERROR_OUTOFMEMORY;
  rc = p_query(k, name, NULL, &t, b, &sz);
  if (rc != ERROR_SUCCESS) { free(b); return (int)rc; }
  *type = t; *data = b; *size = sz;
  return ERROR_SUCCESS;
}

/* Every value of a key, then (with recurse) each subkey the same way. */
static void query_key(HKEY k, const wchar_t *path, int recurse, int list_subkeys) {
  out_w(L"\r\n");
  out_w(path);
  out_w(L"\r\n");
  wchar_t name[16384];
  for (DWORD i = 0;; i++) {
    DWORD nlen = sizeof(name) / sizeof(name[0]), type = 0, size = 0;
    LONG rc = p_enumv(k, i, name, &nlen, NULL, &type, NULL, &size);
    if (rc == ERROR_NO_MORE_ITEMS) break;
    if (rc != ERROR_SUCCESS) continue;
    BYTE *data = NULL; DWORD t = 0, sz = 0;
    if (read_value(k, name, &t, &data, &sz) == ERROR_SUCCESS) { print_value(name, t, data, sz); free(data); }
  }
  for (DWORD i = 0;; i++) {
    DWORD nlen = sizeof(name) / sizeof(name[0]);
    LONG rc = p_enumk(k, i, name, &nlen, NULL, NULL, NULL, NULL);
    if (rc == ERROR_NO_MORE_ITEMS) break;
    if (rc != ERROR_SUCCESS) continue;
    size_t plen = wcslen(path) + 1 + wcslen(name) + 1;
    wchar_t *sub = (wchar_t *)malloc(plen * sizeof(wchar_t));
    if (!sub) continue;
    swprintf(sub, plen, L"%ls\\%ls", path, name);
    if (recurse) {
      HKEY s;
      if (p_open(k, name, 0, KEY_READ | KEY_WOW64_64KEY, &s) == ERROR_SUCCESS) {
        query_key(s, sub, 1, 0);
        p_close(s);
      }
    } else if (list_subkeys) {
      if (i == 0) out_w(L"\r\n");
      out_w(sub);
      out_w(L"\r\n");
    }
    free(sub);
  }
}

static const wchar_t *opt(const wchar_t *flag, int *present) {
  for (int i = 3; i < g_argc; i++) {
    if (!_wcsicmp(g_argv[i], flag)) {
      if (present) *present = 1;
      return i + 1 < g_argc ? g_argv[i + 1] : NULL;
    }
  }
  return NULL;
}

static int has(const wchar_t *flag) { int p = 0; opt(flag, &p); return p; }

static int do_query(HKEY root, const wchar_t *sub, const wchar_t *full) {
  HKEY k;
  LONG rc = p_open(root, sub, 0, KEY_READ | KEY_WOW64_64KEY, &k);
  if (rc != ERROR_SUCCESS) return fail_code(rc);
  int named = has(L"/v"), dflt = has(L"/ve");
  if (named || dflt) {
    const wchar_t *name = dflt ? L"" : opt(L"/v", NULL);
    if (!name) { p_close(k); return fail("Invalid syntax."); }
    BYTE *data = NULL; DWORD t = 0, sz = 0;
    int r = read_value(k, name, &t, &data, &sz);
    if (r != ERROR_SUCCESS) { p_close(k); return fail_code(r); }
    out_w(L"\r\n"); out_w(full); out_w(L"\r\n");
    print_value(name, t, data, sz);
    out_w(L"\r\n");
    free(data);
  } else {
    query_key(k, full, has(L"/s"), 1);
    out_w(L"\r\n");
  }
  p_close(k);
  return 0;
}

static int parse_dword(const wchar_t *s, unsigned long long *v) {
  wchar_t *end = NULL;
  *v = (s[0] == L'0' && (s[1] == L'x' || s[1] == L'X')) ? wcstoull(s + 2, &end, 16) : wcstoull(s, &end, 10);
  return end && *end == 0 && end != s;
}

static int do_add(HKEY root, const wchar_t *sub) {
  HKEY k;
  LONG rc = p_create(root, sub, 0, NULL, 0, KEY_READ | KEY_WRITE | KEY_WOW64_64KEY, NULL, &k, NULL);
  if (rc != ERROR_SUCCESS) return fail_code(rc);
  int named = has(L"/v"), dflt = has(L"/ve");
  if (!named && !dflt) { p_close(k); out_w(L"The operation completed successfully.\r\n"); return 0; }
  const wchar_t *name = dflt ? L"" : opt(L"/v", NULL);
  const wchar_t *tname = opt(L"/t", NULL);
  const wchar_t *d = opt(L"/d", NULL);
  if (!name) { p_close(k); return fail("Invalid syntax."); }
  if (!d) d = L"";
  DWORD type = REG_SZ;
  if (tname) {
    if (!_wcsicmp(tname, L"REG_SZ")) type = REG_SZ;
    else if (!_wcsicmp(tname, L"REG_EXPAND_SZ")) type = REG_EXPAND_SZ;
    else if (!_wcsicmp(tname, L"REG_MULTI_SZ")) type = REG_MULTI_SZ;
    else if (!_wcsicmp(tname, L"REG_DWORD")) type = REG_DWORD;
    else if (!_wcsicmp(tname, L"REG_QWORD")) type = REG_QWORD;
    else if (!_wcsicmp(tname, L"REG_BINARY")) type = REG_BINARY;
    else { p_close(k); return fail("Invalid type."); }
  }
  if (type == REG_DWORD || type == REG_QWORD) {
    unsigned long long v;
    if (!parse_dword(d, &v) || (type == REG_DWORD && v > 0xffffffffULL)) { p_close(k); return fail("Invalid number."); }
    if (type == REG_DWORD) { DWORD dw = (DWORD)v; rc = p_set(k, name, 0, type, (const BYTE *)&dw, 4); }
    else rc = p_set(k, name, 0, type, (const BYTE *)&v, 8);
  } else if (type == REG_BINARY) {
    size_t n = wcslen(d);
    if (n % 2) { p_close(k); return fail("Invalid binary data."); }
    BYTE *b = (BYTE *)malloc(n / 2 + 1);
    if (!b) { p_close(k); return fail("Out of memory."); }
    for (size_t i = 0; i < n / 2; i++) {
      wchar_t pair[3] = { d[2 * i], d[2 * i + 1], 0 };
      wchar_t *end = NULL;
      unsigned long x = wcstoul(pair, &end, 16);
      if (!end || *end) { free(b); p_close(k); return fail("Invalid binary data."); }
      b[i] = (BYTE)x;
    }
    rc = p_set(k, name, 0, type, b, (DWORD)(n / 2));
    free(b);
  } else if (type == REG_MULTI_SZ) {
    /* reg.exe's "\0" separator, ended by two NULs. */
    size_t n = wcslen(d);
    wchar_t *m = (wchar_t *)calloc(n + 2, sizeof(wchar_t));
    if (!m) { p_close(k); return fail("Out of memory."); }
    size_t j = 0;
    for (size_t i = 0; i < n; i++) {
      if (d[i] == L'\\' && d[i + 1] == L'0') { m[j++] = 0; i++; }
      else m[j++] = d[i];
    }
    m[j++] = 0; m[j++] = 0;
    rc = p_set(k, name, 0, type, (const BYTE *)m, (DWORD)(j * sizeof(wchar_t)));
    free(m);
  } else {
    rc = p_set(k, name, 0, type, (const BYTE *)d, (DWORD)((wcslen(d) + 1) * sizeof(wchar_t)));
  }
  p_close(k);
  if (rc != ERROR_SUCCESS) return fail_code(rc);
  out_w(L"The operation completed successfully.\r\n");
  return 0;
}

static int do_delete(HKEY root, const wchar_t *sub) {
  int named = has(L"/v"), dflt = has(L"/ve");
  LONG rc;
  if (named || dflt) {
    const wchar_t *name = dflt ? L"" : opt(L"/v", NULL);
    if (!name) return fail("Invalid syntax.");
    HKEY k;
    rc = p_open(root, sub, 0, KEY_SET_VALUE | KEY_WOW64_64KEY, &k);
    if (rc != ERROR_SUCCESS) return fail_code(rc);
    rc = p_delv(k, name);
    p_close(k);
  } else {
    /* The key and everything under it; never a root. */
    if (!sub[0]) return fail("Invalid key name.");
    HKEY k;
    rc = p_open(root, sub, 0, DELETE | KEY_ENUMERATE_SUB_KEYS | KEY_QUERY_VALUE | KEY_SET_VALUE | KEY_WOW64_64KEY, &k);
    if (rc != ERROR_SUCCESS) return fail_code(rc);
    rc = p_deltree(k, NULL);
    p_close(k);
    if (rc == ERROR_SUCCESS) rc = p_delkey(root, sub, KEY_WOW64_64KEY, 0);
  }
  if (rc != ERROR_SUCCESS) return fail_code(rc);
  out_w(L"The operation completed successfully.\r\n");
  return 0;
}

/* "--reg refresh": tell WinINET (and the programs that read its settings)
 * that the proxy setting changed, as Internet Options does. wininet.dll is
 * loaded here only. */
static int refresh_wininet(void) {
  typedef BOOL (WINAPI *set_option_fn)(void *, DWORD, void *, DWORD);
  HMODULE w = LoadLibraryW(L"wininet.dll");
  set_option_fn set = w ? (set_option_fn)(void *)GetProcAddress(w, "InternetSetOptionW") : NULL;
  if (!set) return fail("WinINET is not available.");
  BOOL a = set(NULL, 39 /* INTERNET_OPTION_SETTINGS_CHANGED */, NULL, 0);
  BOOL b = set(NULL, 37 /* INTERNET_OPTION_REFRESH */, NULL, 0);
  return a && b ? 0 : fail("WinINET did not take the change.");
}

int winreg_main(int argc, char **argv) {
  if (argc >= 3 && !strcmp(argv[2], "refresh")) return refresh_wininet();
  /* Keys and values may hold any character: the wide command line. */
  HMODULE sh = LoadLibraryW(L"shell32.dll");
  argv_fn to_argv = sh ? (argv_fn)(void *)GetProcAddress(sh, "CommandLineToArgvW") : NULL;
  if (to_argv) g_argv = to_argv(GetCommandLineW(), &g_argc);
  if (!g_argv || g_argc < 4) return fail("Invalid syntax.");
  /* Byte for byte what reg.exe prints: "\r\n" stays "\r\n" (a text-mode
   * stdout would make it "\r\r\n", and the app's readers of reg.exe's
   * lines would not match them). */
  _setmode(_fileno(stdout), _O_BINARY);
  if (!load_api()) return fail("The registry functions are not available.");
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  const wchar_t *op = g_argv[2], *key = g_argv[3], *sub = NULL, *longname = NULL;
  HKEY root = split_root(key, &sub, &longname);
  if (!root) return fail("Invalid key name.");
  size_t flen = wcslen(longname) + 1 + wcslen(sub) + 1;
  wchar_t *full = (wchar_t *)malloc(flen * sizeof(wchar_t));
  if (!full) return fail("Out of memory.");
  swprintf(full, flen, sub[0] ? L"%ls\\%ls" : L"%ls", longname, sub);
  int rc;
  if (!_wcsicmp(op, L"query")) rc = do_query(root, sub, full);
  else if (!_wcsicmp(op, L"add")) rc = do_add(root, sub);
  else if (!_wcsicmp(op, L"delete")) rc = do_delete(root, sub);
  else rc = fail("Invalid operation.");
  free(full);
  fflush(stdout);
  return rc;
}

#endif
