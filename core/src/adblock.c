/*
 * adblock — see adblock.h.
 */
#include "adblock.h"
#include "platform.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── names never blocked ─────────────────────────────────────────────────
 * What Shroudly itself needs, whatever a list says. Keep in step with the
 * app: the encrypted-DNS routes
 * (electron/doh-forwarder.js, android DohForwarder.kt), updates and the list
 * download (GitHub), the live count (codeshare.me), and every domain of the
 * services the autopilot looks after, with the captchas their logins show
 * (electron/families.js, discord-relay.js). */
static const char *const KEPT[] = {
  /* Shroudly: the live count, the downloads page */
  "codeshare.me",
  /* updates, and the list itself */
  "github.com", "githubusercontent.com",
  /* encrypted DNS */
  "cloudflare-dns.com", "one.one.one.one", "dns.google", "quad9.net", "adguard-dns.com",
  "opendns.com", "doh.sb", "dns.sb", "mullvad.net",
  /* Discord */
  "discord.com", "discord.gg", "discord.co", "discord.media", "discord.new", "discord.gift",
  "discord.gifts", "discord.dev", "discord.design", "discord.store", "discord.tools",
  "discord.app", "discordapp.com", "discordapp.net", "discordcdn.com", "discordstatus.com",
  "discordsays.com", "discordsez.com", "discordactivities.com", "discord-activities.com",
  "discordpartygames.com", "discordmerch.com", "dis.gd", "klipy.com", "tenor.com", "giphy.com",
  "discord-attachments-uploads-prd.storage.googleapis.com",
  /* Roblox */
  "roblox.com", "rbxcdn.com", "rbxinfra.net", "rbx.com", "rblx.org", "blox.com", "rbxcdn.net",
  "robloxcdn.com", "simulprod.com", "withpersona.com", "rbxtrk.com", "robloxlabs.com", "guilded.gg",
  /* captchas */
  "hcaptcha.com", "arkoselabs.com", "funcaptcha.com", "recaptcha.net", "challenges.cloudflare.com",
  "px-cloud.net", "captcha-delivery.com", "datadome.co", "awswaf.com",
  NULL
};

/* ── entries skipped ─────────────────────────────────────────────────────
 * Parents whose names belong to unrelated people (hosting, blogs, CDN
 * customers, dynamic DNS): as a list entry each would take thousands of
 * sites with it. A name under one ("ads.example.blogspot.com") is fine. */
static const char *const SHARED[] = {
  "github.io", "githubusercontent.com", "gitlab.io", "pages.dev", "vercel.app", "netlify.app",
  "herokuapp.com", "appspot.com", "run.app", "cloudfunctions.net", "firebaseapp.com", "web.app",
  "workers.dev", "r2.dev", "azurewebsites.net", "azureedge.net", "azurefd.net", "cloudapp.net",
  "cloudapp.azure.com", "trafficmanager.net", "core.windows.net", "windows.net", "amazonaws.com",
  "s3.amazonaws.com", "elasticbeanstalk.com", "cloudfront.net", "googleusercontent.com",
  "googleapis.com", "storage.googleapis.com", "gstatic.com", "blogspot.com", "wordpress.com",
  "tumblr.com", "wixsite.com", "weebly.com", "myshopify.com", "substack.com", "itch.io",
  "akamaized.net", "akamaihd.net", "akamaiedge.net", "edgekey.net", "edgesuite.net", "fastly.net",
  "fastlylb.net", "b-cdn.net", "duckdns.org", "ddns.net", "no-ip.org", "hopto.org", "zapto.org",
  "sytes.net", "dyndns.org", "ngrok.io", "ngrok.app", "ngrok-free.app", "trycloudflare.com",
  NULL
};

/* Second levels under which people register their own names, under a
 * two-letter country domain: "co.uk" as an entry would be all of the UK. */
static const char *const GENERIC_SLD[] = {
  "co", "com", "net", "org", "gov", "edu", "ac", "gen", "biz", "info", "or", "ne", "go",
  "mil", "int", "nom", "ltd", "plc", "sch", "k12", "gob", "gouv", "govt", NULL
};

/* Last labels of names only a local network knows. */
static const char *const LOCAL_TLD[] = {
  "local", "localdomain", "localhost", "lan", "internal", "invalid", "test", "arpa",
  "home", "corp", NULL
};

/* adblock_check: what every ad list lists, and what none may take. */
static const char *const MUST_LIST[] = { "doubleclick.net", "googlesyndication.com", NULL };
static const char *const MUST_SPARE[] = {
  "google.com", "www.google.com", "youtube.com", "www.youtube.com", "googlevideo.com",
  "gstatic.com", "googleapis.com", "wikipedia.org", "github.com", "apple.com", "icloud.com",
  "microsoft.com", "windowsupdate.com", "live.com", "bing.com", "cloudflare.com", "amazon.com",
  "facebook.com", "instagram.com", "whatsapp.com", "whatsapp.net", "telegram.org", "x.com",
  "twitter.com", "netflix.com", "reddit.com", "tiktok.com", "spotify.com", "yandex.ru",
  "vk.com", "duckduckgo.com", "mozilla.org", "jsdelivr.net", "cloudfront.net", "akamaized.net",
  NULL
};

/* ── hashing ───────────────────────────────────────────────────────────── */

/* FNV-1a, then a finaliser (MurmurHash3's) so the low bits used to pick a
 * slot depend on every byte. Never 0: 0 marks an empty slot. */
static uint64_t hash_name(const char *s, size_t n) {
  uint64_t h = 0xcbf29ce484222325ull;
  for (size_t i = 0; i < n; i++) { h ^= (uint8_t)s[i]; h *= 0x100000001b3ull; }
  h ^= h >> 33; h *= 0xff51afd7ed558ccdull;
  h ^= h >> 33; h *= 0xc4ceb9fe1a85ec53ull;
  h ^= h >> 33;
  return h ? h : 1;
}

struct adb_list {
  uint64_t *slot;
  size_t    mask;     /* slots - 1; slots is a power of two */
  size_t    n;
  struct adb_list *ex; /* the exceptions (@@||name^), NULL when none */
};

static int table_init(adb_list *l, size_t slots) {
  l->slot = (uint64_t *)calloc(slots, sizeof(uint64_t));
  if (!l->slot) return -1;
  l->mask = slots - 1;
  l->n = 0;
  l->ex = NULL;
  return 0;
}

static int table_has(const adb_list *l, uint64_t h) {
  if (!l || !l->slot) return 0;
  for (size_t i = (size_t)h & l->mask;; i = (i + 1) & l->mask) {
    if (l->slot[i] == h) return 1;
    if (l->slot[i] == 0) return 0;
  }
}

/* 1 added, 0 already there. The caller keeps it at most 3/4 full. */
static int table_put(adb_list *l, uint64_t h) {
  for (size_t i = (size_t)h & l->mask;; i = (i + 1) & l->mask) {
    if (l->slot[i] == h) return 0;
    if (l->slot[i] == 0) { l->slot[i] = h; l->n++; return 1; }
  }
}

static int table_grow(adb_list *l) {
  adb_list bigger;
  if (table_init(&bigger, (l->mask + 1) * 2) != 0) return -1;
  for (size_t i = 0; i <= l->mask; i++) if (l->slot[i]) table_put(&bigger, l->slot[i]);
  free(l->slot);
  bigger.ex = l->ex;
  *l = bigger;
  return 0;
}

/* ── names ─────────────────────────────────────────────────────────────── */

int adb_norm(const char *name, char *out, size_t cap) {
  if (!name || cap < 256) return -1;
  size_t n = strlen(name);
  if (n && name[n - 1] == '.') n--;
  if (n == 0 || n > 253) return -1;
  size_t label = 0;
  for (size_t i = 0; i < n; i++) {
    char c = name[i];
    if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
    if (c == '.') {
      if (label == 0) return -1;
      label = 0;
    } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
      if (++label > 63) return -1;
    } else {
      return -1;
    }
    out[i] = c;
  }
  if (label == 0) return -1;
  out[n] = 0;
  return 0;
}

static int in_set(const char *s, size_t n, const char *const *set) {
  for (int i = 0; set[i]; i++) if (strlen(set[i]) == n && memcmp(set[i], s, n) == 0) return 1;
  return 0;
}

/* Hashes of every suffix of norm that has two labels or more ("a.b.c" gives
 * "a.b.c" and "b.c"), longest first. How many, at most max. */
static int suffix_hashes(const char *norm, uint64_t *out, int max) {
  size_t n = strlen(norm);
  int k = 0;
  for (size_t i = 0; i < n && k < max; i++) {
    if (i > 0 && norm[i - 1] != '.') continue;
    if (!memchr(norm + i, '.', n - i)) break;          /* one label left */
    out[k++] = hash_name(norm + i, n - i);
  }
  return k;
}

/* A usable entry: two labels or more, not an address, not a public suffix,
 * not a shared parent, not a local name. norm is already normalised. */
static int usable_entry(const char *norm) {
  size_t n = strlen(norm);
  const char *last = strrchr(norm, '.');
  if (!last) return 0;
  const char *tld = last + 1;
  size_t tl = n - (size_t)(tld - norm);
  int digits = 1;
  for (const char *p = norm; *p; p++) if (*p != '.' && (*p < '0' || *p > '9')) { digits = 0; break; }
  if (digits) return 0;                                 /* "0.0.0.0", "1.2.3.4" */
  if (in_set(tld, tl, LOCAL_TLD)) return 0;
  if (in_set(norm, n, SHARED)) return 0;
  /* "co.uk", "com.tr": two labels, a generic second level, a country. */
  if (tl == 2 && !memchr(norm, '.', (size_t)(last - norm)) && in_set(norm, (size_t)(last - norm), GENERIC_SLD)) return 0;
  return 1;
}

/* ── parsing ───────────────────────────────────────────────────────────── */

static int is_space(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\v' || c == '\f'; }

/* An address in front of the names of a hosts line: IPv4 (digits and dots:
 * 0.0.0.0, 127.0.0.1) or IPv6 (has a colon: ::, ::1, fe80::1%lo0). */
static int address_token(const char *s, size_t n) {
  int colon = memchr(s, ':', n) != NULL, digit = 0;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (c == ':') continue;
    else if (c >= '0' && c <= '9') digit = 1;
    else if (c == '%' && colon) break;                 /* a zone: fe80::1%lo0 */
    else if (c == '.') continue;
    else if (colon && ((c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) continue;
    else return 0;
  }
  return colon || digit;
}

typedef struct { adb_list *l; size_t max; size_t skipped; int full; int nomem; } parse_st;

/* An entry (ex 0) or an exception (ex 1) of s[0..n). An exception may be a
 * name any entry would be skipped for but a public suffix, an address or a
 * local name: one above a shared parent takes nothing it should not. */
static void add_name(parse_st *ps, const char *s, size_t n, int ex) {
  char tmp[256], norm[256];
  if (n == 0) return;
  if (n >= sizeof(tmp)) { ps->skipped++; return; }
  memcpy(tmp, s, n); tmp[n] = 0;
  if (adb_norm(tmp, norm, sizeof(norm)) != 0 || !usable_entry(norm)) { ps->skipped++; return; }
  uint64_t h = hash_name(norm, strlen(norm));
  adb_list *t = ps->l;
  if (ex) {
    if (!t->ex) {
      t->ex = (adb_list *)calloc(1, sizeof(*t->ex));
      if (!t->ex || table_init(t->ex, 64) != 0) { free(t->ex); t->ex = NULL; ps->nomem = 1; return; }
    }
    t = t->ex;
  }
  if (table_has(t, h)) return;
  if (t->n >= (ex ? ADB_MAX_EXCEPTIONS : ps->max)) { ps->full = 1; return; }
  if ((t->n + 1) * 4 > (t->mask + 1) * 3 && table_grow(t) != 0) { ps->nomem = 1; return; }
  table_put(t, h);
}

static void add_entry(parse_st *ps, const char *s, size_t n) { add_name(ps, s, n, 0); }

static void parse_line(parse_st *ps, const char *p, size_t n) {
  /* A comment: "#" anywhere, "!" at the start (ad-blocker lists). */
  const char *hash = memchr(p, '#', n);
  if (hash) n = (size_t)(hash - p);
  size_t i = 0;
  while (i < n && is_space(p[i])) i++;
  if (i < n && (p[i] == '!' || p[i] == '[')) return;
  /* The tokens of the line. */
  const char *tok[16]; size_t tl[16]; int nt = 0, more = 0;
  while (i < n) {
    while (i < n && is_space(p[i])) i++;
    if (i >= n) break;
    size_t s = i;
    while (i < n && !is_space(p[i])) i++;
    if (nt < 16) { tok[nt] = p + s; tl[nt] = i - s; nt++; } else more = 1;
  }
  if (nt == 0) return;
  if (more) ps->skipped++;
  if (address_token(tok[0], tl[0]) && nt >= 2) {
    for (int k = 1; k < nt; k++) add_entry(ps, tok[k], tl[k]);
    return;
  }
  if (nt != 1) { ps->skipped++; return; }
  const char *s = tok[0]; size_t len = tl[0];
  if (len > 5 && s[0] == '@' && s[1] == '@' && s[2] == '|' && s[3] == '|') {
    /* @@||example.com^ — an exception, with no options either. */
    if (s[len - 1] != '^') { ps->skipped++; return; }
    add_name(ps, s + 4, len - 5, 1);
    return;
  }
  if (len > 3 && s[0] == '|' && s[1] == '|') {
    /* ||example.com^ — and nothing after the ^ (no options, which are about
     * pages, not names), nor any wildcard or path. */
    if (s[len - 1] != '^') { ps->skipped++; return; }
    add_entry(ps, s + 2, len - 3);
    return;
  }
  if (address_token(s, len)) { ps->skipped++; return; }
  add_entry(ps, s, len);
}

adb_list *adb_parse(const char *text, size_t len, size_t max_entries, adb_stats *st) {
  adb_list *l = (adb_list *)calloc(1, sizeof(*l));
  if (!l) return NULL;
  /* A first guess at the size from the text's length, so a big list grows
   * less often: a line of a hosts file is about 30 bytes. */
  size_t guess = len / 30 + 16, slots = 64;
  while (slots * 3 < guess * 4 && slots < (size_t)1 << 20) slots <<= 1;
  if (table_init(l, slots) != 0) { free(l); return NULL; }
  parse_st ps = { l, max_entries, 0, 0, 0 };
  size_t i = 0;
  while (i < len && !ps.full && !ps.nomem) {
    const char *nl = memchr(text + i, '\n', len - i);
    size_t end = nl ? (size_t)(nl - text) : len;
    parse_line(&ps, text + i, end - i);
    i = end + 1;
  }
  if (ps.full || ps.nomem) { adb_free(l); return NULL; }
  /* As small as it may be (3/4 full at most): the guess above, and growing
   * by doubling, may have left it up to eight times larger. */
  size_t fit = 64;
  while (fit * 3 < l->n * 4) fit <<= 1;
  if (fit < l->mask + 1) {
    adb_list small;
    if (table_init(&small, fit) == 0) {
      for (size_t i = 0; i <= l->mask; i++) if (l->slot[i]) table_put(&small, l->slot[i]);
      free(l->slot);
      small.ex = l->ex;
      *l = small;
    }
  }
  if (st) {
    st->entries = l->n; st->skipped = ps.skipped;
    st->exceptions = l->ex ? l->ex->n : 0;
    st->bytes = (l->mask + 1 + (l->ex ? l->ex->mask + 1 : 0)) * sizeof(uint64_t);
  }
  return l;
}

void adb_free(adb_list *l) {
  if (!l) return;
  if (l->ex) { free(l->ex->slot); free(l->ex); }
  free(l->slot);
  free(l);
}

static FILE *open_utf8(const char *path) {
#ifdef _WIN32
  /* The path as written (UTF-8), not in the system's code page, which has
   * no letters for most user names. */
  wchar_t w[2048];
  if (!MultiByteToWideChar(CP_UTF8, 0, path, -1, w, (int)(sizeof(w) / sizeof(w[0])))) return NULL;
  return _wfopen(w, L"rb");
#else
  return fopen(path, "rb");
#endif
}

adb_list *adb_load(const char *path, adb_stats *st, const char **why) {
  const char *dummy;
  if (!why) why = &dummy;
  FILE *f = path && path[0] ? open_utf8(path) : NULL;
  if (!f) { *why = "cannot be read"; return NULL; }
  size_t cap = 1 << 20, len = 0;
  char *buf = (char *)malloc(cap);
  if (!buf) { fclose(f); *why = "out of memory"; return NULL; }
  for (;;) {
    if (len == cap) {
      if (cap >= ADB_MAX_FILE) { free(buf); fclose(f); *why = "too large"; return NULL; }
      size_t nc = cap * 2 > ADB_MAX_FILE ? ADB_MAX_FILE : cap * 2;
      char *nb = (char *)realloc(buf, nc);
      if (!nb) { free(buf); fclose(f); *why = "out of memory"; return NULL; }
      buf = nb; cap = nc;
    }
    size_t r = fread(buf + len, 1, cap - len, f);
    if (r == 0) break;
    len += r;
  }
  int err = ferror(f);
  fclose(f);
  if (err) { free(buf); *why = "cannot be read"; return NULL; }
  /* One more byte past the most a list may hold: too large. */
  if (len >= ADB_MAX_FILE) { free(buf); *why = "too large"; return NULL; }
  adb_list *l = adb_parse(buf, len, ADB_MAX_ENTRIES, st);
  free(buf);
  if (!l) *why = "too many entries, or out of memory";
  return l;
}

/* Up to 127 suffixes: a name of 253 characters has at most 127 labels. */
#define SUFFIX_MAX 128

static int listed_hashes(const adb_list *l, const uint64_t *h, int k) {
  for (int i = 0; i < k; i++) if (table_has(l, h[i])) return 1;
  return 0;
}

/* On a list: one of the names is an entry and none an exception (an
 * exception wins at any level, as in any ad blocker). */
static int list_match(const adb_list *l, const uint64_t *h, int k) {
  if (l->ex && listed_hashes(l->ex, h, k)) return 0;
  return listed_hashes(l, h, k);
}

int adb_listed(const adb_list *l, const char *name) {
  char norm[256];
  uint64_t h[SUFFIX_MAX];
  if (!l || adb_norm(name, norm, sizeof(norm)) != 0) return 0;
  return list_match(l, h, suffix_hashes(norm, h, SUFFIX_MAX));
}

/* KEPT as a table of its own, made once (adblock_init or the first use). */
static adb_list g_kept;
static _Atomic int g_kept_ready = 0;

static void kept_init(void) {
  if (atomic_load(&g_kept_ready)) return;
  if (table_init(&g_kept, 256) != 0) return;
  for (int i = 0; KEPT[i]; i++) table_put(&g_kept, hash_name(KEPT[i], strlen(KEPT[i])));
  atomic_store(&g_kept_ready, 1);
}

static int kept_hashes(const uint64_t *h, int k) {
  if (!atomic_load(&g_kept_ready)) return 0;
  return listed_hashes(&g_kept, h, k);
}

int adb_kept(const char *name) {
  char norm[256];
  uint64_t h[SUFFIX_MAX];
  kept_init();
  if (adb_norm(name, norm, sizeof(norm)) != 0) return 0;
  return kept_hashes(h, suffix_hashes(norm, h, SUFFIX_MAX));
}

int adb_dns_answer(const uint8_t *q, size_t qend, uint8_t *out, size_t cap) {
  if (qend < 12 + 5) return -1;
  uint16_t qtype = (uint16_t)((q[qend - 4] << 8) | q[qend - 3]);
  uint16_t qclass = (uint16_t)((q[qend - 2] << 8) | q[qend - 1]);
  int a = qclass == 1 && qtype == 1, aaaa = qclass == 1 && qtype == 28;
  size_t rdlen = a ? 4 : aaaa ? 16 : 0;
  size_t need = qend + (rdlen ? 12 + rdlen : 0);
  if (cap < need) return -1;
  memcpy(out, q, qend);
  out[2] = (uint8_t)(0x80 | (q[2] & 0x01));          /* QR, opcode 0, RD as asked */
  out[3] = 0x80;                                       /* RA, NOERROR */
  out[4] = 0; out[5] = 1;                              /* one question */
  out[6] = 0; out[7] = rdlen ? 1 : 0;                  /* the answer, if any */
  memset(out + 8, 0, 4);                               /* no authority, no additional */
  if (!rdlen) return (int)qend;
  uint8_t *r = out + qend;
  r[0] = 0xc0; r[1] = 0x0c;                            /* the question's name */
  r[2] = (uint8_t)(qtype >> 8); r[3] = (uint8_t)qtype;
  r[4] = 0; r[5] = 1;                                  /* IN */
  r[6] = 0; r[7] = 0; r[8] = 0; r[9] = ADB_TTL;
  r[10] = 0; r[11] = (uint8_t)rdlen;
  memset(r + 12, 0, rdlen);                            /* 0.0.0.0 or :: */
  return (int)need;
}

/* ── the engine's ──────────────────────────────────────────────────────── */

static mutex_t  g_mx;
static int      g_mx_ready = 0;
static adb_list *g_list = NULL;       /* the list in use; NULL: none */
static int      g_on = 0;
static uint64_t g_allow[ADBLOCK_ALLOW_MAX];
static int      g_allow_n = 0;
static _Atomic uint64_t g_total = 0;
/* Off, quickly, without the lock: most engines never turn it on. */
static _Atomic int g_on_fast = 0;

void adblock_init(void) {
  if (!g_mx_ready) { mutex_init(&g_mx); g_mx_ready = 1; }
  kept_init();
}

void adblock_reset(void) {
  adblock_init();
  mutex_lock(&g_mx);
  adb_list *old = g_list;
  g_list = NULL;
  g_on = 0;
  g_allow_n = 0;
  atomic_store(&g_on_fast, 0);
  mutex_unlock(&g_mx);
  adb_free(old);
  atomic_store(&g_total, 0);
}

int adblock_use(const char *path, adb_stats *st, const char **why) {
  adblock_init();
  adb_list *l = adb_load(path, st, why);
  if (!l) return -1;
  mutex_lock(&g_mx);
  adb_list *old = g_list;
  g_list = l;
  g_on = 1;
  atomic_store(&g_on_fast, 1);
  mutex_unlock(&g_mx);
  adb_free(old);
  return 0;
}

int adblock_check(const char *path, adb_stats *st, const char **why) {
  const char *dummy;
  if (!why) why = &dummy;
  adb_stats s;
  adb_list *l = adb_load(path, &s, why);
  if (!l) return -1;
  if (st) *st = s;
  int rc = 0;
  if (s.entries < ADB_MIN_DOWNLOADED) { *why = "too few entries"; rc = -1; }
  for (int i = 0; rc == 0 && MUST_LIST[i]; i++)
    if (!adb_listed(l, MUST_LIST[i])) { *why = "not an ad list"; rc = -1; }
  for (int i = 0; rc == 0 && MUST_SPARE[i]; i++)
    if (adb_listed(l, MUST_SPARE[i])) { *why = "blocks a site no list may take"; rc = -1; }
  adb_free(l);
  return rc;
}

void adblock_off(void) {
  adblock_init();
  mutex_lock(&g_mx);
  adb_list *old = g_list;
  g_list = NULL;
  g_on = 0;
  atomic_store(&g_on_fast, 0);
  mutex_unlock(&g_mx);
  adb_free(old);
}

int adblock_on(void) {
  adblock_init();
  mutex_lock(&g_mx);
  int on = g_on;
  mutex_unlock(&g_mx);
  return on;
}

int adblock_allow(const char *name) {
  char norm[256];
  adblock_init();
  if (adb_norm(name, norm, sizeof(norm)) != 0) return -1;
  uint64_t h = hash_name(norm, strlen(norm));
  mutex_lock(&g_mx);
  int rc = 0, have = 0;
  for (int i = 0; i < g_allow_n; i++) if (g_allow[i] == h) have = 1;
  if (!have) {
    if (g_allow_n < ADBLOCK_ALLOW_MAX) g_allow[g_allow_n++] = h;
    else rc = -1;
  }
  mutex_unlock(&g_mx);
  return rc;
}

void adblock_allow_clear(void) {
  adblock_init();
  mutex_lock(&g_mx);
  g_allow_n = 0;
  mutex_unlock(&g_mx);
}

int adblock_blocked(const char *name) {
  if (!atomic_load(&g_on_fast) || !name || !name[0]) return 0;
  char norm[256];
  if (adb_norm(name, norm, sizeof(norm)) != 0) return 0;   /* an IPv6 address, or not a name */
  int digits = 1;
  for (const char *p = norm; *p; p++) if (*p != '.' && (*p < '0' || *p > '9')) { digits = 0; break; }
  if (digits) return 0;                                    /* an IPv4 address */
  uint64_t h[SUFFIX_MAX];
  int k = suffix_hashes(norm, h, SUFFIX_MAX);
  if (k == 0 || kept_hashes(h, k)) return 0;
  int blocked = 0;
  mutex_lock(&g_mx);
  if (g_on && g_list && list_match(g_list, h, k)) {
    blocked = 1;
    for (int i = 0; i < k && blocked; i++)
      for (int j = 0; j < g_allow_n; j++) if (g_allow[j] == h[i]) { blocked = 0; break; }
  }
  mutex_unlock(&g_mx);
  return blocked;
}

void adblock_count(void) { atomic_fetch_add(&g_total, 1); }
uint64_t adblock_total(void) { return atomic_load(&g_total); }
