/* winprocs.c: see winprocs.h. */
#include "platform.h"
#include "engine.h"
#include "winprocs.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#ifndef _WIN32

void winprocs_emit(void) { engine_printf("{\"type\":\"procs_end\",\"n\":-1}\n"); }
void wintcp_emit(void) { engine_printf("{\"type\":\"tcp_end\",\"n\":-1}\n"); }

#else

#include <windows.h>
#include <tlhelp32.h>
#include <iphlpapi.h>
#include <ws2tcpip.h>

/* A program's name, UTF-8 and fit for JSON; "" if it is not. */
static void json_name(const WCHAR *w, char *out, size_t cap) {
  char u[MAX_PATH * 4];
  out[0] = 0;
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, u, (int)sizeof(u), NULL, NULL);
  if (n <= 0) return;
  size_t o = 0;
  for (const unsigned char *p = (const unsigned char *)u; *p && o + 7 < cap; p++) {
    if (*p == '"' || *p == '\\') { out[o++] = '\\'; out[o++] = (char)*p; }
    else if (*p < 0x20) { o += (size_t)snprintf(out + o, cap - o, "\\u%04x", *p); }
    else out[o++] = (char)*p;
  }
  out[o] = 0;
}

void winprocs_emit(void) {
  int count = 0;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap != INVALID_HANDLE_VALUE) {
    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(pe);
    for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe)) {
      char name[MAX_PATH * 6];
      json_name(pe.szExeFile, name, sizeof(name));
      if (!name[0]) continue;
      DWORD session = 0;
      long s = ProcessIdToSessionId(pe.th32ProcessID, &session) ? (long)session : -1;
      engine_printf("{\"type\":\"proc\",\"n\":\"%s\",\"p\":%lu,\"s\":%ld}\n", name, (unsigned long)pe.th32ProcessID, s);
      count++;
    }
    CloseHandle(snap);
  } else {
    count = -1;
  }
  engine_printf("{\"type\":\"procs_end\",\"n\":%d}\n", count);
}

static const char *TCP_STATE[] = { "", "CLOSED", "LISTENING", "SYN_SENT", "SYN_RECEIVED", "ESTABLISHED", "FIN_WAIT_1",
  "FIN_WAIT_2", "CLOSE_WAIT", "CLOSING", "LAST_ACK", "TIME_WAIT", "DELETE_TCB" };

static const char *state_name(DWORD st) {
  return st < sizeof(TCP_STATE) / sizeof(TCP_STATE[0]) ? TCP_STATE[st] : "";
}

/* The table of one family, grown until it fits. NULL if it cannot be read. */
static void *tcp_table(ULONG family) {
  DWORD size = 64 * 1024;
  for (int i = 0; i < 4; i++) {
    void *t = malloc(size);
    if (!t) return NULL;
    DWORD rc = GetExtendedTcpTable(t, &size, FALSE, family, TCP_TABLE_OWNER_PID_ALL, 0);
    if (rc == NO_ERROR) return t;
    free(t);
    if (rc != ERROR_INSUFFICIENT_BUFFER) return NULL;
    size += 16 * 1024;
  }
  return NULL;
}

void wintcp_emit(void) {
  int count = 0, read = 0;
  MIB_TCPTABLE_OWNER_PID *t4 = (MIB_TCPTABLE_OWNER_PID *)tcp_table(AF_INET);
  if (t4) {
    read = 1;
    for (DWORD i = 0; i < t4->dwNumEntries; i++) {
      MIB_TCPROW_OWNER_PID *r = &t4->table[i];
      char l[64], rm[64];
      struct in_addr a;
      a.s_addr = r->dwLocalAddr;
      inet_ntop(AF_INET, &a, l, sizeof(l));
      size_t n = strlen(l);
      snprintf(l + n, sizeof(l) - n, ":%u", (unsigned)ntohs((u_short)r->dwLocalPort));
      a.s_addr = r->dwRemoteAddr;
      inet_ntop(AF_INET, &a, rm, sizeof(rm));
      n = strlen(rm);
      snprintf(rm + n, sizeof(rm) - n, ":%u", r->dwState == MIB_TCP_STATE_LISTEN ? 0u : (unsigned)ntohs((u_short)r->dwRemotePort));
      engine_printf("{\"type\":\"tcp\",\"l\":\"%s\",\"r\":\"%s\",\"st\":\"%s\",\"p\":%lu}\n", l, rm, state_name(r->dwState), (unsigned long)r->dwOwningPid);
      count++;
    }
    free(t4);
  }
  MIB_TCP6TABLE_OWNER_PID *t6 = (MIB_TCP6TABLE_OWNER_PID *)tcp_table(AF_INET6);
  if (t6) {
    read = 1;
    for (DWORD i = 0; i < t6->dwNumEntries; i++) {
      MIB_TCP6ROW_OWNER_PID *r = &t6->table[i];
      char la[INET6_ADDRSTRLEN], ra[INET6_ADDRSTRLEN];
      inet_ntop(AF_INET6, r->ucLocalAddr, la, sizeof(la));
      inet_ntop(AF_INET6, r->ucRemoteAddr, ra, sizeof(ra));
      engine_printf("{\"type\":\"tcp\",\"l\":\"[%s]:%u\",\"r\":\"[%s]:%u\",\"st\":\"%s\",\"p\":%lu}\n",
                    la, (unsigned)ntohs((u_short)r->dwLocalPort), ra,
                    r->dwState == MIB_TCP_STATE_LISTEN ? 0u : (unsigned)ntohs((u_short)r->dwRemotePort),
                    state_name(r->dwState), (unsigned long)r->dwOwningPid);
      count++;
    }
    free(t6);
  }
  engine_printf("{\"type\":\"tcp_end\",\"n\":%d}\n", read ? count : -1);
}

#endif
