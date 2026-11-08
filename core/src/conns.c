/* Connections, by name (conns.h, issue #74). */
#include "conns.h"
#include "engine.h"

#include <ctype.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  char host[256];
  int active;
  uint64_t conns, blocked, last;
  _Atomic uint64_t up, down;
  int route;   /* the last connection's way out */
} host_row;

static host_row g_h[CONNS_HOSTS];
static struct { int used; int h; sock_t a, b; } g_act[CONNS_ACTIVE];
static char g_block[CONNS_BLOCK][256];
static int g_nblock;
/* Names the user sends through Tor (TOR), and the only names Shroudly
 * works on when that is chosen (ONLY, with ONLY-MODE 1). */
static char g_tor[CONNS_BLOCK][256];
static int g_ntor;
static char g_only[CONNS_BLOCK][256];
static int g_nonly;
static int g_only_mode;
static mutex_t g_mx;
static atomic_int g_ready;

void conns_init(void) {
  int expected = 0;
  if (atomic_compare_exchange_strong(&g_ready, &expected, 1)) mutex_init(&g_mx);
}

static void lower(char *out, size_t cap, const char *in) {
  size_t i = 0;
  for (; in && in[i] && i + 1 < cap; i++) out[i] = (char)tolower((unsigned char)in[i]);
  out[i] = 0;
  /* A trailing dot is the same name. */
  if (i > 0 && out[i - 1] == '.') out[i - 1] = 0;
}

/* The row for host, made if missing (the longest idle row with nothing open
 * makes room). Under the lock. */
static int row_for(const char *host) {
  int empty = -1, idle = -1;
  for (int i = 0; i < CONNS_HOSTS; i++) {
    if (!g_h[i].host[0]) { if (empty < 0) empty = i; continue; }
    if (!strcmp(g_h[i].host, host)) return i;
    if (g_h[i].active == 0 && (idle < 0 || g_h[i].last < g_h[idle].last)) idle = i;
  }
  int r = empty >= 0 ? empty : idle;
  if (r < 0) return -1;
  memset(&g_h[r], 0, sizeof(g_h[r]));
  snprintf(g_h[r].host, sizeof(g_h[r].host), "%s", host);
  return r;
}

int conns_begin(const char *host) {
  if (!atomic_load(&g_ready) || !host || !host[0]) return -1;
  char h[256];
  lower(h, sizeof(h), host);
  mutex_lock(&g_mx);
  int slot = -1;
  for (int i = 0; i < CONNS_ACTIVE; i++) if (!g_act[i].used) { slot = i; break; }
  int r = slot >= 0 ? row_for(h) : -1;
  if (r < 0) { mutex_unlock(&g_mx); return -1; }
  g_act[slot].used = 1; g_act[slot].h = r; g_act[slot].a = g_act[slot].b = SOCK_INVALID;
  g_h[r].active++; g_h[r].conns++; g_h[r].last = now_ms();
  mutex_unlock(&g_mx);
  return slot;
}

void conns_name(int slot, const char *host) {
  if (slot < 0 || slot >= CONNS_ACTIVE || !host || !host[0]) return;
  char h[256];
  lower(h, sizeof(h), host);
  mutex_lock(&g_mx);
  if (g_act[slot].used && strcmp(g_h[g_act[slot].h].host, h) != 0) {
    int old = g_act[slot].h;
    int r = row_for(h);
    if (r >= 0) {
      g_h[old].active--;
      /* Counted under the name only: the address it was asked by goes when
       * nothing else came for it. */
      if (g_h[old].conns > 0) g_h[old].conns--;
      if (g_h[old].conns == 0 && g_h[old].active == 0) g_h[old].host[0] = 0;
      g_act[slot].h = r;
      g_h[r].active++; g_h[r].conns++; g_h[r].last = now_ms();
    }
  }
  mutex_unlock(&g_mx);
}

void conns_route(int slot, int route) {
  if (slot < 0 || slot >= CONNS_ACTIVE) return;
  mutex_lock(&g_mx);
  if (g_act[slot].used) g_h[g_act[slot].h].route = route;
  mutex_unlock(&g_mx);
}

void conns_sockets(int slot, sock_t a, sock_t b) {
  if (slot < 0 || slot >= CONNS_ACTIVE) return;
  mutex_lock(&g_mx);
  if (g_act[slot].used) { g_act[slot].a = a; g_act[slot].b = b; }
  mutex_unlock(&g_mx);
}

void conns_bytes(int slot, uint64_t up, uint64_t down) {
  if (slot < 0 || slot >= CONNS_ACTIVE) return;
  /* The row of a used slot stays while it is open (row_for never takes one
   * with anything open), so the counters need no lock. */
  int r = g_act[slot].h;
  if (r < 0 || r >= CONNS_HOSTS) return;
  if (up) atomic_fetch_add(&g_h[r].up, up);
  if (down) atomic_fetch_add(&g_h[r].down, down);
  g_h[r].last = now_ms();
}

void conns_end(int slot) {
  if (slot < 0 || slot >= CONNS_ACTIVE) return;
  mutex_lock(&g_mx);
  if (g_act[slot].used) {
    host_row *row = &g_h[g_act[slot].h];
    if (row->active > 0) row->active--;
    row->last = now_ms();
    g_act[slot].used = 0;
    g_act[slot].a = g_act[slot].b = SOCK_INVALID;
  }
  mutex_unlock(&g_mx);
}

/* host is name or a name under it. */
static int under(const char *host, const char *name) {
  size_t hl = strlen(host), nl = strlen(name);
  if (hl < nl) return 0;
  if (strcmp(host + hl - nl, name) != 0) return 0;
  return hl == nl || host[hl - nl - 1] == '.';
}

int conns_blocked(const char *host) {
  if (!atomic_load(&g_ready) || !host || !host[0]) return 0;
  char h[256];
  lower(h, sizeof(h), host);
  int yes = 0;
  mutex_lock(&g_mx);
  for (int i = 0; i < g_nblock && !yes; i++) if (under(h, g_block[i])) yes = 1;
  if (yes) {
    int r = row_for(h);
    if (r >= 0) { g_h[r].blocked++; g_h[r].last = now_ms(); }
  }
  mutex_unlock(&g_mx);
  return yes;
}

/* A name as the user gives it: letters, digits, dots, dashes, underscores,
 * colons (an IPv6 address); 1..253 characters. */
static int name_ok(const char *h) {
  size_t n = strlen(h);
  if (n == 0 || n > 253) return 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)h[i];
    if (!(isalnum(c) || c == '.' || c == '-' || c == '_' || c == ':')) return 0;
  }
  return 1;
}

int conns_block(const char *host) {
  if (!atomic_load(&g_ready)) conns_init();
  char h[256];
  while (host && *host == ' ') host++;
  lower(h, sizeof(h), host);
  if (!name_ok(h)) return -1;
  mutex_lock(&g_mx);
  int have = 0;
  for (int i = 0; i < g_nblock; i++) if (!strcmp(g_block[i], h)) have = 1;
  if (!have && g_nblock < CONNS_BLOCK) snprintf(g_block[g_nblock++], sizeof(g_block[0]), "%s", h);
  /* Open connections to it end now: shut both ways, the relay sees the end. */
  int ended = 0;
  for (int i = 0; i < CONNS_ACTIVE; i++) {
    if (!g_act[i].used || !under(g_h[g_act[i].h].host, h)) continue;
    if (g_act[i].a != SOCK_INVALID) shutdown(g_act[i].a, SHUT_RDWR_C);
    if (g_act[i].b != SOCK_INVALID) shutdown(g_act[i].b, SHUT_RDWR_C);
    ended++;
  }
  mutex_unlock(&g_mx);
  return ended;
}

int conns_unblock(const char *host) {
  char h[256];
  while (host && *host == ' ') host++;
  lower(h, sizeof(h), host);
  int found = 0;
  if (!atomic_load(&g_ready)) return 0;
  mutex_lock(&g_mx);
  for (int i = 0; i < g_nblock; i++) {
    if (strcmp(g_block[i], h) != 0) continue;
    memmove(g_block[i], g_block[i + 1], (size_t)(g_nblock - i - 1) * sizeof(g_block[0]));
    g_nblock--; found = 1; break;
  }
  mutex_unlock(&g_mx);
  return found;
}

void conns_block_clear(void) {
  if (!atomic_load(&g_ready)) return;
  mutex_lock(&g_mx);
  g_nblock = 0;
  mutex_unlock(&g_mx);
}

/* ── lists of names the user keeps (TOR, ONLY) ───────────────────────────
 * As the blocked names: a name covers every name under it; the app gives
 * the lists again at every start. */
static int list_has(char (*list)[256], int n, const char *host) {
  for (int i = 0; i < n; i++) if (under(host, list[i])) return 1;
  return 0;
}

static int list_add(char (*list)[256], int *n, const char *host) {
  if (!atomic_load(&g_ready)) conns_init();
  char h[256];
  while (host && *host == ' ') host++;
  lower(h, sizeof(h), host);
  if (!name_ok(h)) return -1;
  mutex_lock(&g_mx);
  int have = 0;
  for (int i = 0; i < *n; i++) if (!strcmp(list[i], h)) have = 1;
  if (!have && *n < CONNS_BLOCK) snprintf(list[(*n)++], 256, "%s", h);
  mutex_unlock(&g_mx);
  return 0;
}

static int list_del(char (*list)[256], int *n, const char *host) {
  char h[256];
  while (host && *host == ' ') host++;
  lower(h, sizeof(h), host);
  if (!atomic_load(&g_ready)) return 0;
  int found = 0;
  mutex_lock(&g_mx);
  for (int i = 0; i < *n; i++) {
    if (strcmp(list[i], h) != 0) continue;
    memmove(list[i], list[i + 1], (size_t)(*n - i - 1) * 256);
    (*n)--; found = 1; break;
  }
  mutex_unlock(&g_mx);
  return found;
}

/* Open connections to the name end now, so the app's next ones take the
 * new way (through Tor, or back). */
static int end_open(const char *host) {
  char h[256];
  lower(h, sizeof(h), host);
  int ended = 0;
  mutex_lock(&g_mx);
  for (int i = 0; i < CONNS_ACTIVE; i++) {
    if (!g_act[i].used || !under(g_h[g_act[i].h].host, h)) continue;
    if (g_act[i].a != SOCK_INVALID) shutdown(g_act[i].a, SHUT_RDWR_C);
    if (g_act[i].b != SOCK_INVALID) shutdown(g_act[i].b, SHUT_RDWR_C);
    ended++;
  }
  mutex_unlock(&g_mx);
  return ended;
}

int conns_tor(const char *host) {
  if (!atomic_load(&g_ready) || !host || !host[0]) return 0;
  char h[256];
  lower(h, sizeof(h), host);
  mutex_lock(&g_mx);
  int yes = list_has(g_tor, g_ntor, h);
  mutex_unlock(&g_mx);
  return yes;
}

int conns_tor_add(const char *host) {
  if (list_add(g_tor, &g_ntor, host) != 0) return -1;
  while (host && *host == ' ') host++;
  return end_open(host);
}

int conns_tor_del(const char *host) {
  int found = list_del(g_tor, &g_ntor, host);
  while (host && *host == ' ') host++;
  if (found) end_open(host);
  return found;
}

void conns_tor_clear(void) {
  if (!atomic_load(&g_ready)) return;
  mutex_lock(&g_mx);
  g_ntor = 0;
  mutex_unlock(&g_mx);
}

int conns_only_add(const char *host) { return list_add(g_only, &g_nonly, host); }
int conns_only_del(const char *host) { return list_del(g_only, &g_nonly, host); }

void conns_only_clear(void) {
  if (!atomic_load(&g_ready)) return;
  mutex_lock(&g_mx);
  g_nonly = 0;
  mutex_unlock(&g_mx);
}

void conns_only_mode(int on) {
  if (!atomic_load(&g_ready)) conns_init();
  mutex_lock(&g_mx);
  g_only_mode = on ? 1 : 0;
  mutex_unlock(&g_mx);
}

/* 1 when only listed names are worked on and this one is not among them:
 * it goes out as it is, untouched. */
int conns_only_skip(const char *host) {
  if (!atomic_load(&g_ready) || !host || !host[0]) return 0;
  char h[256];
  lower(h, sizeof(h), host);
  mutex_lock(&g_mx);
  int skip = g_only_mode && !list_has(g_only, g_nonly, h);
  mutex_unlock(&g_mx);
  return skip;
}

static const char *route_name(int r) {
  return r == CONN_TECHNIQUE ? "technique" : r == CONN_SERVER ? "server" : r == CONN_TOR ? "tor" : r == CONN_UDP ? "udp" : "direct";
}

static int by_last(const void *a, const void *b) {
  uint64_t x = g_h[*(const int *)a].last, y = g_h[*(const int *)b].last;
  return x < y ? 1 : x > y ? -1 : 0;
}

void conns_emit(void) {
  if (!atomic_load(&g_ready)) { engine_printf("{\"type\":\"conns_end\",\"n\":0}\n"); return; }
  int idx[CONNS_HOSTS], n = 0;
  mutex_lock(&g_mx);
  uint64_t now = now_ms();
  for (int i = 0; i < CONNS_HOSTS; i++) if (g_h[i].host[0]) idx[n++] = i;
  qsort(idx, (size_t)n, sizeof(int), by_last);
  for (int k = 0; k < n; k++) {
    host_row *r = &g_h[idx[k]];
    /* Names are checked when they come in (proto.c, socks); any other
     * character is left out rather than escaped. */
    char h[256]; size_t o = 0;
    for (size_t i = 0; r->host[i] && o + 1 < sizeof(h); i++) {
      unsigned char c = (unsigned char)r->host[i];
      if (c > 0x20 && c < 0x7f && c != '"' && c != '\\') h[o++] = (char)c;
    }
    h[o] = 0;
    int blocked = 0;
    for (int i = 0; i < g_nblock && !blocked; i++) if (under(r->host, g_block[i])) blocked = 1;
    int tor = list_has(g_tor, g_ntor, r->host);
    engine_printf("{\"type\":\"conn\",\"host\":\"%s\",\"active\":%d,\"conns\":%llu,\"up\":%llu,\"down\":%llu,"
                  "\"route\":\"%s\",\"blocked\":%d,\"refused\":%llu,\"ago\":%llu,\"tor\":%d}\n",
                  h, r->active, (unsigned long long)r->conns, (unsigned long long)atomic_load(&r->up),
                  (unsigned long long)atomic_load(&r->down), route_name(r->route), blocked,
                  (unsigned long long)r->blocked, (unsigned long long)(now > r->last ? now - r->last : 0), tor);
  }
  mutex_unlock(&g_mx);
  engine_printf("{\"type\":\"conns_end\",\"n\":%d}\n", n);
}

void conns_forget(void) {
  if (!atomic_load(&g_ready)) return;
  mutex_lock(&g_mx);
  memset(g_h, 0, sizeof(g_h));
  memset(g_act, 0, sizeof(g_act));
  for (int i = 0; i < CONNS_ACTIVE; i++) g_act[i].a = g_act[i].b = SOCK_INVALID;
  mutex_unlock(&g_mx);
}
