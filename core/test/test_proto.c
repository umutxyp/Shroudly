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

int main(void) {
  test_tls_sni();
  test_tls_expected_len();
  test_http_host();
  test_http_not_xforward();
  test_http_port_strip();
  test_truncated_tls();
  test_strategy_parse();
  test_presets();
  if (fails == 0) { printf("ALL TESTS PASSED\n"); return 0; }
  printf("%d TEST(S) FAILED\n", fails);
  return 1;
}
