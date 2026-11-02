#include "../src/proto.h"
#include "../src/strategy.h"
#include <stdio.h>
#include <string.h>
#include <assert.h>

static int fails = 0;
#define CHECK(c) do { if(!(c)){ printf("FAIL %s:%d %s\n",__FILE__,__LINE__,#c); fails++; } } while(0)

/* Build a ClientHello with SNI possibly split across the buffer boundary. */
static int make_ch(uint8_t *b, const char *host) {
  int hl = (int)strlen(host); int p=0;
  int rec=p; p+=5;
  int hs=p; b[p++]=0x01; int hsl=p; p+=3;
  b[p++]=0x03;b[p++]=0x03;
  for(int i=0;i<32;i++) b[p++]=0x41;
  b[p++]=0;
  b[p++]=0;b[p++]=2; b[p++]=0x13;b[p++]=0x01;
  b[p++]=1;b[p++]=0;
  int ext=p; p+=2;
  b[p++]=0;b[p++]=0;
  int sl=2+1+2+hl; b[p++]=(sl>>8);b[p++]=sl&0xff;
  b[p++]=((hl+3)>>8);b[p++]=(hl+3)&0xff; b[p++]=0; b[p++]=(hl>>8);b[p++]=hl&0xff;
  memcpy(b+p,host,hl); p+=hl;
  int ee=p; b[ext]=((ee-ext-2)>>8);b[ext+1]=(ee-ext-2)&0xff;
  int he=p; int hlen=he-hs-4; b[hsl]=(hlen>>16);b[hsl+1]=(hlen>>8);b[hsl+2]=hlen;
  int rl=he-rec-5; b[rec]=0x16;b[rec+1]=0x03;b[rec+2]=0x01;b[rec+3]=(rl>>8);b[rec+4]=rl&0xff;
  return he;
}

static void test_tls_sni(void) {
  uint8_t b[512];
  int n = make_ch(b, "www.example.com");
  proto_info pi; proto_inspect(b,(size_t)n,&pi);
  CHECK(pi.kind == PROTO_TLS);
  CHECK(strcmp(pi.host, "www.example.com") == 0);
  CHECK(pi.host_off > 0);
  CHECK(pi.host_len == 15);
  /* the detected host bytes match */
  CHECK(memcmp(b + pi.host_off, "www.example.com", 15) == 0);
}

static void test_tls_expected_len(void) {
  uint8_t b[512];
  int n = make_ch(b, "a.io");
  CHECK(tls_expected_len(b, 3) == 5);        /* needs header */
  CHECK(tls_expected_len(b, n) == n);        /* full record */
  uint8_t http[] = "GET / HTTP/1.1\r\n";
  CHECK(tls_expected_len(http, sizeof(http)-1) == 0);
}

static void test_http_host(void) {
  const char *req = "GET /path HTTP/1.1\r\nUser-Agent: x\r\nHost: test.example.org\r\n\r\n";
  proto_info pi; proto_inspect((const uint8_t*)req, strlen(req), &pi);
  CHECK(pi.kind == PROTO_HTTP);
  CHECK(strcmp(pi.host, "test.example.org") == 0);
  CHECK(pi.http_hdr_off > 0);
  CHECK(memcmp(req + pi.http_hdr_off, "Host:", 5) == 0);
}

static void test_http_not_xforward(void) {
  /* X-Forwarded-Host must not be picked as the Host header. */
  const char *req = "GET / HTTP/1.1\r\nX-Forwarded-Host: evil\r\nHost: real.site\r\n\r\n";
  proto_info pi; proto_inspect((const uint8_t*)req, strlen(req), &pi);
  CHECK(pi.kind == PROTO_HTTP);
  CHECK(strcmp(pi.host, "real.site") == 0);
}

static void test_http_port_strip(void) {
  const char *req = "GET / HTTP/1.1\r\nHost: site.com:8443\r\n\r\n";
  proto_info pi; proto_inspect((const uint8_t*)req, strlen(req), &pi);
  CHECK(strcmp(pi.host, "site.com") == 0);
}

static void test_truncated_tls(void) {
  /* A ClientHello truncated mid-extension must not read out of bounds. */
  uint8_t b[512];
  int n = make_ch(b, "example.com");
  for (int cut = 6; cut < n; cut++) {
    proto_info pi; proto_inspect(b, (size_t)cut, &pi);
    /* must not crash and must not report a host beyond the buffer */
    if (pi.host_off >= 0) CHECK(pi.host_off + pi.host_len <= cut);
  }
}

static void test_strategy_parse(void) {
  strategy st;
  CHECK(strategy_parse("fake(ttl=4),split(sni)", &st) == 0);
  CHECK(st.n_ops == 2);
  CHECK(st.ops[0].kind == OP_FAKE);
  CHECK(st.fake_ttl == 4);
  CHECK(st.ops[1].kind == OP_SPLIT);
  CHECK(st.ops[1].ref == POS_SNI);

  CHECK(strategy_parse("disorder(sni+1)", &st) == 0);
  CHECK(st.ops[0].kind == OP_DISORDER);
  CHECK(st.ops[0].offset == 1);

  CHECK(strategy_parse("", &st) != 0);
  CHECK(strategy_parse("nonsense", &st) != 0);
  /* "none": no operation at all, accepted (Settings "Off", issue #37). */
  CHECK(strategy_parse("none", &st) == 0 && st.n_ops == 0 && strcmp(st.name, "none") == 0);
}

static void test_presets(void) {
  int n = strategy_preset_count();
  CHECK(n > 0);
  for (int i = 0; i < n; i++) {
    const strategy *s = strategy_preset(i);
    CHECK(s->n_ops > 0);
    CHECK(s->name[0] != 0);
  }
}

/* A ClientHello as browsers send one: a 32-byte session id, a GREASE
 * extension and supported_versions before the server name, padding after. */
static int make_ch2(uint8_t *b, const char *host) {
  int hl = (int)strlen(host), p = 0;
  int rec = p; p += 5;
  int hs = p; b[p++] = 0x01; int hsl = p; p += 3;
  b[p++] = 0x03; b[p++] = 0x03;
  for (int i = 0; i < 32; i++) b[p++] = (uint8_t)(0x10 + i);
  b[p++] = 32; for (int i = 0; i < 32; i++) b[p++] = (uint8_t)(0x80 + i);
  b[p++] = 0; b[p++] = 4; b[p++] = 0x13; b[p++] = 0x01; b[p++] = 0x13; b[p++] = 0x02;
  b[p++] = 1; b[p++] = 0;
  int ext = p; p += 2;
  b[p++] = 0x0a; b[p++] = 0x0a; b[p++] = 0; b[p++] = 1; b[p++] = 0;              /* GREASE */
  b[p++] = 0x00; b[p++] = 0x2b; b[p++] = 0; b[p++] = 3; b[p++] = 2; b[p++] = 0x03; b[p++] = 0x04;
  b[p++] = 0; b[p++] = 0;
  int sl = 2 + 1 + 2 + hl; b[p++] = (uint8_t)(sl >> 8); b[p++] = (uint8_t)sl;
  b[p++] = (uint8_t)((hl + 3) >> 8); b[p++] = (uint8_t)(hl + 3); b[p++] = 0; b[p++] = (uint8_t)(hl >> 8); b[p++] = (uint8_t)hl;
  memcpy(b + p, host, (size_t)hl); p += hl;
  b[p++] = 0x00; b[p++] = 0x15; b[p++] = 0; b[p++] = 20; memset(b + p, 0, 20); p += 20;  /* padding */
  int ee = p; b[ext] = (uint8_t)((ee - ext - 2) >> 8); b[ext + 1] = (uint8_t)(ee - ext - 2);
  int hlen = p - hs - 4; b[hsl] = (uint8_t)(hlen >> 16); b[hsl + 1] = (uint8_t)(hlen >> 8); b[hsl + 2] = (uint8_t)hlen;
  int rl = p - rec - 5; b[rec] = 0x16; b[rec + 1] = 0x03; b[rec + 2] = 0x01; b[rec + 3] = (uint8_t)(rl >> 8); b[rec + 4] = (uint8_t)rl;
  return p;
}

/* Every length in a ClientHello agrees with its size: the record, the
 * handshake, and the extensions, which end exactly where the record does. */
static int ch_consistent(const uint8_t *b, int n) {
  if (n < 9 || b[0] != 0x16 || ((b[3] << 8) | b[4]) != n - 5) return 0;
  if (((b[6] << 16) | (b[7] << 8) | b[8]) != n - 9) return 0;
  int p = 9 + 34; p += 1 + b[p]; p += 2 + ((b[p] << 8) | b[p + 1]); p += 1 + b[p];
  if (p + 2 > n || p + 2 + ((b[p] << 8) | b[p + 1]) != n) return 0;
  for (int q = p + 2; q < n; ) {                    /* each extension in bounds */
    if (q + 4 > n) return 0;
    q += 4 + ((b[q + 2] << 8) | b[q + 3]);
    if (q > n) return 0;
  }
  return 1;
}

static int labels_ok(const uint8_t *h, int len) {
  if (len < 1 || h[0] == '.' || h[len - 1] == '.') return 0;
  int label = 0;
  for (int i = 0; i < len; i++) {
    if (h[i] == '.') { if (!label) return 0; label = 0; continue; }
    if (!((h[i] >= 'a' && h[i] <= 'z') || (h[i] >= '0' && h[i] <= '9') || h[i] == '-')) return 0;
    if (++label > 63) return 0;
  }
  return 1;
}

static void test_decoy_names(void) {
  uint8_t real[1024], out[1600];
  proto_info pi, po;

  /* Only host names are taken, at most eight. */
  proto_decoy_names_reset();
  CHECK(proto_decoy_name_add("divar.ir") == 0);
  CHECK(proto_decoy_name_add("WWW.Digikala.COM") == 0);
  CHECK(proto_decoy_name_add("no dots") == -1);
  CHECK(proto_decoy_name_add("nodot") == -1);
  CHECK(proto_decoy_name_add(".lead.ir") == -1);
  CHECK(proto_decoy_name_add("a..b.ir") == -1);
  CHECK(proto_decoy_name_add("x.ir;rm") == -1);
  CHECK(proto_decoy_name_add(NULL) == -1);
  CHECK(proto_decoy_name_count() == 2);
  for (int i = 0; i < 10; i++) proto_decoy_name_add("www.aparat.com");
  CHECK(proto_decoy_name_count() == PROTO_DECOY_NAMES);

  /* No names: nothing is rewritten (the caller scrambles, as before). */
  proto_decoy_names_reset();
  int n = make_ch2(real, "www.blocked.example");
  proto_inspect(real, (size_t)n, &pi);
  CHECK(pi.kind == PROTO_TLS && pi.host_len == 19);
  CHECK(proto_decoy_rename(out, sizeof out, real, n, 1, pi.host_off, pi.host_len, 1200) == 0);
  CHECK(proto_decoy_fill(real, n, pi.host_off, pi.host_len) == 0);

  /* A shorter allowed name: every length rewritten, the engine's own parser
   * reads the new name, and the rest of the request is untouched. */
  CHECK(proto_decoy_name_add("divar.ir") == 0);
  int m = proto_decoy_rename(out, sizeof out, real, n, 1, pi.host_off, pi.host_len, 1200);
  CHECK(m == n - 11);
  proto_inspect(out, (size_t)m, &po);
  CHECK(po.kind == PROTO_TLS && strcmp(po.host, "divar.ir") == 0);
  CHECK(ch_consistent(real, n) && ch_consistent(out, m));
  CHECK(tls_expected_len(out, (size_t)m) == m);
  /* Unchanged: the record type and version, the hello up to its extensions
   * length (offset 84 in make_ch2), the extensions before the server name. */
  CHECK(memcmp(out, real, 3) == 0 && memcmp(out + 9, real + 9, 84 - 9) == 0);
  CHECK(memcmp(out + 86, real + 86, (size_t)(pi.host_off - 9 - 86)) == 0);
  CHECK(memcmp(out + po.host_off + 8, real + pi.host_off + 19, (size_t)(n - pi.host_off - 19)) == 0);

  /* A longer one, and the names used in turn. */
  proto_decoy_names_reset();
  proto_decoy_name_add("www.digikala.com");
  proto_decoy_name_add("www.zoomit.ir");
  int s1 = make_ch2(real, "x.io");
  proto_inspect(real, (size_t)s1, &pi);
  int a = proto_decoy_rename(out, sizeof out, real, s1, 1, pi.host_off, pi.host_len, 1200);
  proto_inspect(out, (size_t)a, &po);
  CHECK(a == s1 + 12 && strcmp(po.host, "www.digikala.com") == 0 && ch_consistent(out, a));
  a = proto_decoy_rename(out, sizeof out, real, s1, 1, pi.host_off, pi.host_len, 1200);
  proto_inspect(out, (size_t)a, &po);
  CHECK(a == s1 + 9 && strcmp(po.host, "www.zoomit.ir") == 0 && ch_consistent(out, a));

  /* No room for anything longer: a name that fits is taken, none is 0. */
  CHECK(proto_decoy_rename(out, sizeof out, real, s1, 1, pi.host_off, pi.host_len, s1 + 9) == s1 + 9);
  CHECK(proto_decoy_rename(out, sizeof out, real, s1, 1, pi.host_off, pi.host_len, s1) == 0);
  CHECK(proto_decoy_rename(out, s1 + 5, real, s1, 1, pi.host_off, pi.host_len, 1200) == 0);

  /* Not the server_name extension where it should be: left alone. */
  CHECK(proto_decoy_rename(out, sizeof out, real, s1, 1, pi.host_off + 1, pi.host_len, 1200) == 0);
  CHECK(proto_decoy_rename(out, sizeof out, real, s1 - 30, 1, pi.host_off, pi.host_len, 1200) == 0 || s1 - 30 >= pi.host_off + pi.host_len);

  /* HTTP: the Host value replaced, any length. */
  const char *req = "GET /a HTTP/1.1\r\nHost: www.blocked.lab\r\nAccept: */*\r\n\r\n";
  proto_inspect((const uint8_t *)req, strlen(req), &pi);
  CHECK(pi.kind == PROTO_HTTP);
  proto_decoy_names_reset(); proto_decoy_name_add("divar.ir");
  int h = proto_decoy_rename(out, sizeof out, (const uint8_t *)req, (int)strlen(req), 0, pi.host_off, pi.host_len, 1200);
  CHECK(h == (int)strlen(req) - 7);
  proto_inspect(out, (size_t)h, &po);
  CHECK(po.kind == PROTO_HTTP && strcmp(po.host, "divar.ir") == 0);
  CHECK(h > 0 && memcmp(out + h - 15, "Accept: */*\r\n\r\n", 15) == 0);

  /* The same length (the Linux stream decoy): the name itself where it is
   * exactly as long, else a subdomain of it, always a valid host name. */
  proto_decoy_names_reset(); proto_decoy_name_add("www.aparat.com");
  n = make_ch2(real, "www.blocked.lab");   /* 15 bytes */
  proto_inspect(real, (size_t)n, &pi);
  uint8_t before[1024]; memcpy(before, real, (size_t)n);
  CHECK(proto_decoy_fill(real, n, pi.host_off, pi.host_len) == 0);       /* 14 + "." leaves 0 */
  proto_decoy_name_add("divar.ir");
  CHECK(proto_decoy_fill(real, n, pi.host_off, pi.host_len) == 1);
  proto_inspect(real, (size_t)n, &po);
  CHECK(po.host_len == 15 && labels_ok(real + po.host_off, 15) && memcmp(real + po.host_off + 6, ".divar.ir", 9) == 0);
  CHECK(memcmp(real, before, (size_t)pi.host_off) == 0 && memcmp(real + pi.host_off + 15, before + pi.host_off + 15, (size_t)(n - pi.host_off - 15)) == 0);
  for (int len = 9; len <= 200; len++) {                                   /* every length that fits */
    char hn[256]; memset(hn, 'q', (size_t)len); hn[len] = 0; hn[0] = 'a'; hn[len - 3] = '.';
    int k = make_ch2(real, hn);
    proto_inspect(real, (size_t)k, &pi);
    proto_decoy_names_reset(); proto_decoy_name_add("divar.ir");
    int ok = proto_decoy_fill(real, k, pi.host_off, pi.host_len);
    CHECK(ok == (len != 9) || len == 8);
    if (ok) {
      proto_inspect(real, (size_t)k, &po);
      CHECK(po.host_len == len && labels_ok(real + po.host_off, len) && memcmp(real + po.host_off + len - 8, "divar.ir", 8) == 0);
    }
  }
  proto_decoy_names_reset();
}

int main(void) {
  test_tls_sni();
  test_tls_expected_len();
  test_http_host();
  test_http_not_xforward();
  test_http_port_strip();
  test_truncated_tls();
  test_strategy_parse();
  test_presets();
  test_decoy_names();
  if (fails == 0) { printf("ALL TESTS PASSED\n"); return 0; }
  printf("%d TEST(S) FAILED\n", fails);
  return 1;
}
