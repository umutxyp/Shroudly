/* The ad and tracker list (adblock.c): what a list line gives, which entries
 * are skipped, how a name is matched (itself and every name under a listed
 * one), the user's allowed names and Shroudly's own, the blocked DNS answer,
 * the check a downloaded list must pass, and a timing and memory measurement
 * on a list the size of the one the app downloads. Ends with a random pass so
 * the parser is shown never to read outside its text (run under ASan by
 * make test-asan). */
#include "../src/adblock.h"
#include "../src/platform.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int fails = 0;
#define CHECK(c) do { if(!(c)){ printf("FAIL %s:%d %s\n",__FILE__,__LINE__,#c); fails++; } } while(0)

static adb_list *parse(const char *s, adb_stats *st) { return adb_parse(s, strlen(s), ADB_MAX_ENTRIES, st); }

static void test_formats(void) {
  const char *text =
    "# a hosts file\n"
    "127.0.0.1 localhost\n"
    "::1 localhost ip6-localhost\n"
    "fe80::1%lo0 localhost\n"
    "255.255.255.255 broadcasthost\n"
    "0.0.0.0 0.0.0.0\n"
    "127.0.0.1 localhost.localdomain\n"
    "0.0.0.0 ads.example.com  # a trailing comment\n"
    "0.0.0.0\ttrack.example.net\r\n"
    "127.0.0.1 one.example two.example.org\n"
    ":: v6.example.io\n"
    "plain.example.com\n"
    "  Mixed.Case.Example.COM.  \n"
    "||rule.example.net^\n"
    "||withopts.example.net^$third-party\n"
    "@@||exception.example.net^\n"
    "! an ad-blocker comment\n"
    "[Adblock Plus 2.0]\n"
    "/regex.*/\n"
    "dead.beef\n"
    "1.2.3.4\n"
    "nodots\n"
    "two words here\n"
    "co.uk\n"
    "com.tr\n"
    "blogspot.com\n"
    "someone.blogspot.com\n"
    "printer.local\n"
    "box.home.arpa\n"
    "under_score.example.com\n"
    "bad..dots.com\n"
    "-\n";
  adb_stats st;
  adb_list *l = parse(text, &st);
  CHECK(l != NULL);
  CHECK(adb_listed(l, "ads.example.com"));
  CHECK(adb_listed(l, "track.example.net"));
  CHECK(adb_listed(l, "two.example.org"));
  CHECK(adb_listed(l, "one.example"));
  CHECK(adb_listed(l, "v6.example.io"));
  CHECK(adb_listed(l, "plain.example.com"));
  CHECK(adb_listed(l, "mixed.case.example.com"));
  CHECK(adb_listed(l, "rule.example.net"));
  CHECK(!adb_listed(l, "withopts.example.net"));   /* options are about pages */
  CHECK(!adb_listed(l, "exception.example.net"));
  CHECK(adb_listed(l, "dead.beef"));               /* hex letters are a name, not an address */
  CHECK(!adb_listed(l, "localhost.localdomain"));
  CHECK(!adb_listed(l, "example.co.uk"));          /* "co.uk" skipped */
  CHECK(!adb_listed(l, "example.com.tr"));
  CHECK(!adb_listed(l, "other.blogspot.com"));     /* a shared parent skipped */
  CHECK(adb_listed(l, "someone.blogspot.com"));    /* a name under it is fine */
  CHECK(adb_listed(l, "under_score.example.com"));
  CHECK(!adb_listed(l, "printer.local"));
  CHECK(!adb_listed(l, "box.home.arpa"));
  CHECK(st.entries == 11);
  CHECK(st.skipped >= 10);
  adb_free(l);
}

static void test_matching(void) {
  adb_list *l = parse("doubleclick.net\n0.0.0.0 tracker.example.com\n", NULL);
  CHECK(adb_listed(l, "doubleclick.net"));
  CHECK(adb_listed(l, "ad.doubleclick.net"));
  CHECK(adb_listed(l, "a.b.c.doubleclick.net"));
  CHECK(adb_listed(l, "AD.DoubleClick.NET."));
  CHECK(!adb_listed(l, "notdoubleclick.net"));     /* a suffix of the text, not of the labels */
  CHECK(!adb_listed(l, "doubleclick.net.example.org"));
  CHECK(!adb_listed(l, "net"));
  CHECK(adb_listed(l, "x.tracker.example.com"));
  CHECK(!adb_listed(l, "example.com"));            /* the parent of an entry is not on the list */
  CHECK(!adb_listed(l, "www.example.com"));
  CHECK(!adb_listed(l, ""));
  CHECK(!adb_listed(l, "bad name.doubleclick.net"));
  CHECK(!adb_listed(NULL, "doubleclick.net"));
  /* A name of 253 characters: 127 labels. */
  char longname[300]; size_t n = 0;
  while (n + 2 < 253 - 16) { longname[n++] = 'a'; longname[n++] = '.'; }
  memcpy(longname + n, "doubleclick.net", 16); n += 15;
  CHECK(n <= 253);
  CHECK(adb_listed(l, longname));
  adb_free(l);

  char out[256];
  CHECK(adb_norm("Example.COM.", out, sizeof(out)) == 0 && strcmp(out, "example.com") == 0);
  CHECK(adb_norm(".example.com", out, sizeof(out)) != 0);
  CHECK(adb_norm("a..b", out, sizeof(out)) != 0);
  CHECK(adb_norm("", out, sizeof(out)) != 0);
  CHECK(adb_norm(".", out, sizeof(out)) != 0);
  CHECK(adb_norm("ex ample.com", out, sizeof(out)) != 0);
  CHECK(adb_norm("2001:db8::1", out, sizeof(out)) != 0);
}

static void test_kept(void) {
  CHECK(adb_kept("discord.com"));
  CHECK(adb_kept("click.discord.com"));
  CHECK(adb_kept("metrics.roblox.com"));
  CHECK(adb_kept("api.github.com"));
  CHECK(adb_kept("objects.githubusercontent.com"));
  CHECK(adb_kept("shroudly.codeshare.me"));
  CHECK(adb_kept("cloudflare-dns.com"));
  CHECK(adb_kept("dns.google"));
  CHECK(!adb_kept("google.com"));
  CHECK(!adb_kept("doubleclick.net"));
  CHECK(!adb_kept("notdiscord.com"));
}

static const char *write_tmp(const char *name, const char *text) {
  static char path[3][512];
  static int k = 0;
  char *p = path[k++ % 3];
  snprintf(p, 512, "/tmp/shroudly_adblock_%s_%ld.txt", name, (long)getpid());
  FILE *f = fopen(p, "wb");
  if (!f) return NULL;
  fwrite(text, 1, strlen(text), f);
  fclose(f);
  return p;
}

static void test_engine_state(void) {
  adblock_init();
  adblock_reset();
  CHECK(!adblock_on());
  CHECK(!adblock_blocked("doubleclick.net"));      /* off */
  const char *p = write_tmp("small", "doubleclick.net\nads.roblox.com\nads.example.org\n");
  adb_stats st;
  const char *why = NULL;
  CHECK(adblock_use(p, &st, &why) == 0 && st.entries == 3);
  CHECK(adblock_on());
  CHECK(adblock_blocked("doubleclick.net"));
  CHECK(adblock_blocked("stats.g.doubleclick.net"));
  CHECK(!adblock_blocked("example.org"));
  CHECK(!adblock_blocked("ads.roblox.com"));        /* Shroudly's own, whatever the list says */
  CHECK(!adblock_blocked("1.2.3.4"));
  CHECK(!adblock_blocked("::1"));
  CHECK(!adblock_blocked(NULL));
  /* The user's exceptions: the name and every name under it. */
  CHECK(adblock_allow("Example.org") == 0);
  CHECK(!adblock_blocked("ads.example.org"));
  CHECK(adblock_allow("stats.g.doubleclick.net") == 0);
  CHECK(!adblock_blocked("stats.g.doubleclick.net"));
  CHECK(!adblock_blocked("x.stats.g.doubleclick.net"));
  CHECK(adblock_blocked("ad.doubleclick.net"));
  CHECK(adblock_allow("not a name") != 0);
  adblock_allow_clear();
  CHECK(adblock_blocked("ads.example.org"));
  for (int i = 0; i < ADBLOCK_ALLOW_MAX; i++) { char n[64]; snprintf(n, sizeof n, "a%d.example.org", i); CHECK(adblock_allow(n) == 0); }
  CHECK(adblock_allow("one-too-many.example.org") != 0);
  CHECK(adblock_allow("a7.example.org") == 0);      /* already there */
  adblock_allow_clear();
  /* A list that cannot be read leaves the one in use. */
  CHECK(adblock_use("/nonexistent/shroudly/list.txt", NULL, &why) != 0 && why);
  CHECK(adblock_blocked("doubleclick.net"));
  /* Counting. */
  uint64_t before = adblock_total();
  adblock_count(); adblock_count();
  CHECK(adblock_total() == before + 2);
  adblock_off();
  CHECK(!adblock_on() && !adblock_blocked("doubleclick.net"));
  adblock_reset();
  CHECK(adblock_total() == 0);
  remove(p);
}

/* What snprintf wrote at t + *k, added to *k; the test stops if it did not
 * fit (a truncated write would leave *k past the buffer, and cap - *k would
 * wrap around). */
static void put(size_t cap, size_t *k, int w) {
  if (w < 0 || (size_t)w >= cap - *k) { fprintf(stderr, "big_list: buffer too small\n"); exit(1); }
  *k += (size_t)w;
}

/* A list like the downloaded one: n entries, the two every ad list has. */
static char *big_list(size_t n, size_t *len) {
  size_t cap = n * 64 + 256, k = 0;
  char *t = (char *)malloc(cap);
  if (!t) { fprintf(stderr, "big_list: out of memory\n"); exit(1); }
  put(cap, &k, snprintf(t + k, cap - k, "# Title: test\n0.0.0.0 doubleclick.net\n0.0.0.0 googlesyndication.com\n"));
  for (size_t i = 0; i < n; i++) put(cap, &k, snprintf(t + k, cap - k, "0.0.0.0 ads%zu.tracker%zu.example-net.com\n", i, i % 977));
  *len = k;
  return t;
}

static void test_check(void) {
  const char *why = NULL;
  adb_stats st;
  const char *small = write_tmp("few", "doubleclick.net\ngooglesyndication.com\n");
  CHECK(adblock_check(small, &st, &why) != 0 && why && strstr(why, "few"));
  size_t len;
  char *t = big_list(20000, &len);
  FILE *f;
  char path[512]; snprintf(path, sizeof path, "/tmp/shroudly_adblock_big_%ld.txt", (long)getpid());
  f = fopen(path, "wb"); fwrite(t, 1, len, f); fclose(f);
  why = NULL;
  CHECK(adblock_check(path, &st, &why) == 0);
  CHECK(st.entries == 20002);
  /* The same with a site no list may take. */
  f = fopen(path, "ab"); fputs("0.0.0.0 youtube.com\n", f); fclose(f);
  CHECK(adblock_check(path, &st, &why) != 0 && strstr(why, "no list"));
  /* Without the names every ad list has: an error page, another list. */
  char *t2 = big_list(20000, &len);
  char *cut = strstr(t2, "0.0.0.0 doubleclick.net\n");
  memset(cut, '#', 8);
  f = fopen(path, "wb"); fwrite(t2, 1, len, f); fclose(f);
  CHECK(adblock_check(path, &st, &why) != 0 && strstr(why, "not an ad list"));
  /* HTML instead of a list. */
  const char *html = write_tmp("html", "<!DOCTYPE html>\n<html><body>404: Not Found</body></html>\n");
  CHECK(adblock_check(html, &st, &why) != 0);
  free(t); free(t2);
  remove(path); remove(small); remove(html);
}

/* Time and memory for a list the size of the one the app downloads (about
 * 80 000 names) and for the most a list may hold. */
static void test_measure(void) {
  size_t sizes[] = { 80000, ADB_MAX_ENTRIES - 2 };
  for (int s = 0; s < 2; s++) {
    size_t len;
    char *t = big_list(sizes[s], &len);
    uint64_t t0 = now_ms();
    adb_stats st;
    adb_list *l = adb_parse(t, len, ADB_MAX_ENTRIES, &st);
    uint64_t t1 = now_ms();
    CHECK(l != NULL && st.entries == sizes[s] + 2);
    char name[96];
    uint64_t t2 = now_ms();
    int hits = 0;
    for (int i = 0; i < 1000000; i++) {
      snprintf(name, sizeof name, "img%d.cdn%d.static-site-%d.example.org", i, i % 7, i % 1000);
      hits += adb_listed(l, name);
    }
    hits += adb_listed(l, "x.ads5.tracker5.example-net.com");
    uint64_t t3 = now_ms();
    CHECK(hits == 1);
    printf("test_adblock: %zu entries: parse %llu ms, table %zu KB (%.1f bytes each), 1M lookups %llu ms\n",
           st.entries, (unsigned long long)(t1 - t0), st.bytes / 1024, (double)st.bytes / (double)st.entries,
           (unsigned long long)(t3 - t2));
    CHECK(st.bytes <= 4u * 1024 * 1024);
    adb_free(l);
    free(t);
  }
  /* One over the most: refused, not cut short. */
  size_t len;
  char *t = big_list(ADB_MAX_ENTRIES, &len);
  CHECK(adb_parse(t, len, ADB_MAX_ENTRIES, NULL) == NULL);
  free(t);
}

static void test_dns_answer(void) {
  /* A query for ads.example.com, type A, with RD, and one for AAAA, and MX. */
  uint8_t q[64] = { 0x12, 0x34, 0x01, 0x00, 0,1, 0,0, 0,0, 0,0 };
  size_t p = 12;
  const char *labels[] = { "ads", "example", "com" };
  for (int i = 0; i < 3; i++) { q[p++] = (uint8_t)strlen(labels[i]); memcpy(q + p, labels[i], strlen(labels[i])); p += strlen(labels[i]); }
  q[p++] = 0;
  q[p++] = 0; q[p++] = 1; q[p++] = 0; q[p++] = 1;
  uint8_t out[128];
  int n = adb_dns_answer(q, p, out, sizeof out);
  CHECK(n == (int)p + 16);
  CHECK(out[0] == 0x12 && out[1] == 0x34);
  CHECK(out[2] == 0x81 && out[3] == 0x80);             /* QR RD, RA NOERROR */
  CHECK(out[5] == 1 && out[7] == 1 && out[9] == 0 && out[11] == 0);
  CHECK(memcmp(out + 12, q + 12, p - 12) == 0);
  CHECK(out[p] == 0xc0 && out[p + 1] == 0x0c && out[p + 3] == 1 && out[p + 5] == 1);
  CHECK(out[p + 9] == ADB_TTL && out[p + 11] == 4);
  CHECK(memcmp(out + p + 12, "\0\0\0\0", 4) == 0);
  q[p - 3] = 28;                                        /* AAAA */
  n = adb_dns_answer(q, p, out, sizeof out);
  CHECK(n == (int)p + 28 && out[p + 11] == 16 && out[p + 3] == 28);
  q[p - 3] = 15;                                        /* MX: no answer */
  n = adb_dns_answer(q, p, out, sizeof out);
  CHECK(n == (int)p && out[7] == 0);
  q[2] = 0x00;                                          /* no RD asked: none in the answer */
  n = adb_dns_answer(q, p, out, sizeof out);
  CHECK(out[2] == 0x80);
  CHECK(adb_dns_answer(q, p, out, p - 1) == -1);
  CHECK(adb_dns_answer(q, 10, out, sizeof out) == -1);
}

static void test_fuzz(void) {
  srand(7);
  const char alphabet[] = "abc.-_|^#!$ \t\r\n0123456789:%@/*[]";
  for (int it = 0; it < 20000; it++) {
    size_t n = (size_t)(rand() % 300);
    char *b = (char *)malloc(n ? n : 1);
    for (size_t i = 0; i < n; i++) b[i] = rand() % 4 ? alphabet[rand() % (int)(sizeof(alphabet) - 1)] : (char)(rand() & 0xff);
    adb_list *l = adb_parse(b, n, 64, NULL);
    if (l) { adb_listed(l, "a.b"); adb_free(l); }
    free(b);
  }
}

int main(void) {
  plat_init();
  test_formats();
  test_matching();
  test_kept();
  test_engine_state();
  test_check();
  test_dns_answer();
  test_measure();
  test_fuzz();
  if (fails) { printf("test_adblock: %d FAILED\n", fails); return 1; }
  printf("test_adblock: all passed\n");
  return 0;
}
