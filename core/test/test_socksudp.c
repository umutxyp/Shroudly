/* The SOCKS5 UDP header (RFC 1928 section 7): what a datagram from the client
 * is parsed into, what is refused (fragments, short or malformed headers, an
 * empty name, a name with a NUL in it, port 0), and the header a reply is sent
 * back with. Ends with a random / mutation pass so the parser is shown never to
 * read outside the datagram (run under ASan by make test-asan). */
#include "../src/socksudp.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fails = 0;
#define CHECK(c) do { if(!(c)){ printf("FAIL %s:%d %s\n",__FILE__,__LINE__,#c); fails++; } } while(0)

static void test_parse_v4(void) {
  const uint8_t d[] = { 0,0, 0, 1, 10,1,2,3, 0x1f,0x90, 'h','i' };
  sudp_dst x;
  CHECK(sudp_parse(d, sizeof(d), &x) == SUDP_OK);
  CHECK(x.atyp == 1 && memcmp(x.addr, "\x0a\x01\x02\x03", 4) == 0);
  CHECK(x.port == 8080 && x.hdr_len == 10);
  struct sockaddr_storage ss; socklen_t sl;
  CHECK(sudp_dst_addr(&x, &ss, &sl) == 0 && ss.ss_family == AF_INET && sl == sizeof(struct sockaddr_in));
  CHECK(ntohs(((struct sockaddr_in *)&ss)->sin_port) == 8080);
  CHECK(memcmp(&((struct sockaddr_in *)&ss)->sin_addr, "\x0a\x01\x02\x03", 4) == 0);
  /* An empty payload is a datagram too. */
  CHECK(sudp_parse(d, 10, &x) == SUDP_OK && x.hdr_len == 10);
  /* One byte short of a port. */
  CHECK(sudp_parse(d, 9, &x) == SUDP_BAD);
}

static void test_parse_v6(void) {
  uint8_t d[4 + 16 + 2 + 3] = { 0,0, 0, 4 };
  for (int i = 0; i < 16; i++) d[4 + i] = (uint8_t)(0x20 + i);
  d[20] = 0x01; d[21] = 0xbb;
  memcpy(d + 22, "abc", 3);
  sudp_dst x;
  CHECK(sudp_parse(d, sizeof(d), &x) == SUDP_OK);
  CHECK(x.atyp == 4 && x.port == 443 && x.hdr_len == 22 && x.addr[0] == 0x20 && x.addr[15] == 0x2f);
  struct sockaddr_storage ss; socklen_t sl;
  CHECK(sudp_dst_addr(&x, &ss, &sl) == 0 && ss.ss_family == AF_INET6 && sl == sizeof(struct sockaddr_in6));
  CHECK(ntohs(((struct sockaddr_in6 *)&ss)->sin6_port) == 443);
  CHECK(sudp_parse(d, 21, &x) == SUDP_BAD);
}

static void test_parse_name(void) {
  uint8_t d[300] = { 0,0, 0, 3, 11 };
  memcpy(d + 5, "example.com", 11);
  d[16] = 0; d[17] = 53;
  sudp_dst x;
  CHECK(sudp_parse(d, 18 + 4, &x) == SUDP_OK);
  CHECK(x.atyp == 3 && strcmp(x.host, "example.com") == 0 && x.port == 53 && x.hdr_len == 18);
  struct sockaddr_storage ss; socklen_t sl;
  CHECK(sudp_dst_addr(&x, &ss, &sl) == -1);   /* a name is the caller's to resolve */
  CHECK(sudp_parse(d, 17, &x) == SUDP_BAD);   /* port cut off */
  /* The longest name there can be. */
  d[4] = 255; memset(d + 5, 'a', 255); d[260] = 0x12; d[261] = 0x34;
  CHECK(sudp_parse(d, 262, &x) == SUDP_OK && strlen(x.host) == 255 && x.port == 0x1234 && x.hdr_len == 262);
  CHECK(sudp_parse(d, 261, &x) == SUDP_BAD);
  /* An empty name, and one with a NUL in it. */
  uint8_t e[] = { 0,0, 0, 3, 0, 0, 53 };
  CHECK(sudp_parse(e, sizeof(e), &x) == SUDP_BAD);
  uint8_t z[] = { 0,0, 0, 3, 3, 'a', 0, 'b', 0, 53 };
  CHECK(sudp_parse(z, sizeof(z), &x) == SUDP_BAD);
  /* Only the length byte. */
  CHECK(sudp_parse(e, 5, &x) == SUDP_BAD);
}

static void test_refused(void) {
  sudp_dst x;
  const uint8_t frag[] = { 0,0, 1, 1, 1,2,3,4, 0,53 };
  CHECK(sudp_parse(frag, sizeof(frag), &x) == SUDP_FRAG);
  const uint8_t frag_end[] = { 0,0, 0x81, 1, 1,2,3,4, 0,53 };
  CHECK(sudp_parse(frag_end, sizeof(frag_end), &x) == SUDP_FRAG);
  const uint8_t atyp[] = { 0,0, 0, 2, 1,2,3,4, 0,53 };
  CHECK(sudp_parse(atyp, sizeof(atyp), &x) == SUDP_BAD);
  const uint8_t port0[] = { 0,0, 0, 1, 1,2,3,4, 0,0 };
  CHECK(sudp_parse(port0, sizeof(port0), &x) == SUDP_BAD);
  CHECK(sudp_parse(port0, 3, &x) == SUDP_BAD);
  CHECK(sudp_parse(port0, 0, &x) == SUDP_BAD);
  CHECK(sudp_parse(NULL, 10, &x) == SUDP_BAD);
  /* RSV is not checked: what matters is FRAG and the address. */
  const uint8_t rsv[] = { 0xff,0xff, 0, 1, 1,2,3,4, 0,53 };
  CHECK(sudp_parse(rsv, sizeof(rsv), &x) == SUDP_OK);
}

static void test_build(void) {
  uint8_t h[SUDP_REPLY_HDR_MAX];
  struct sockaddr_in a4; memset(&a4, 0, sizeof(a4));
  a4.sin_family = AF_INET; a4.sin_port = htons(5353);
  memcpy(&a4.sin_addr, "\x08\x08\x04\x04", 4);
  CHECK(sudp_build((struct sockaddr *)&a4, h, sizeof(h)) == 10);
  CHECK(memcmp(h, "\x00\x00\x00\x01\x08\x08\x04\x04\x14\xe9", 10) == 0);
  CHECK(sudp_build((struct sockaddr *)&a4, h, 9) == -1);   /* no room */

  struct sockaddr_in6 a6; memset(&a6, 0, sizeof(a6));
  a6.sin6_family = AF_INET6; a6.sin6_port = htons(443);
  for (int i = 0; i < 16; i++) ((uint8_t *)&a6.sin6_addr)[i] = (uint8_t)(0xf0 + i);
  CHECK(sudp_build((struct sockaddr *)&a6, h, sizeof(h)) == 22);
  CHECK(h[0] == 0 && h[1] == 0 && h[2] == 0 && h[3] == 4 && h[4] == 0xf0 && h[19] == 0xff && h[20] == 0x01 && h[21] == 0xbb);
  CHECK(sudp_build((struct sockaddr *)&a6, h, 21) == -1);

  /* ::ffff:1.2.3.4 is written as the IPv4 address it is. */
  memset(&a6.sin6_addr, 0, 16);
  memcpy((uint8_t *)&a6.sin6_addr + 10, "\xff\xff\x01\x02\x03\x04", 6);
  CHECK(sudp_build((struct sockaddr *)&a6, h, sizeof(h)) == 10);
  CHECK(memcmp(h, "\x00\x00\x00\x01\x01\x02\x03\x04\x01\xbb", 10) == 0);

  struct sockaddr other; memset(&other, 0, sizeof(other)); other.sa_family = AF_UNIX;
  CHECK(sudp_build(&other, h, sizeof(h)) == -1);
  CHECK(sudp_build(NULL, h, sizeof(h)) == -1);

  /* What is built parses back to the same address. */
  a4.sin_port = htons(40000);
  int n = sudp_build((struct sockaddr *)&a4, h, sizeof(h));
  sudp_dst x;
  CHECK(n == 10 && sudp_parse(h, (size_t)n, &x) == SUDP_OK && x.port == 40000 && memcmp(x.addr, "\x08\x08\x04\x04", 4) == 0);
}

/* Random and mutated datagrams, each in a buffer of exactly its own size so
 * ASan sees any read past the end. */
static void test_fuzz(void) {
  srand(12345);
  uint8_t seed[] = { 0,0, 0, 3, 7, 'a','.','b','.','c','o','m', 0,53, 'x' };
  for (int it = 0; it < 200000; it++) {
    size_t n = (size_t)(rand() % 300);
    uint8_t *b = (uint8_t *)malloc(n ? n : 1);
    if (!b) return;
    if (it & 1) {
      for (size_t i = 0; i < n; i++) b[i] = (uint8_t)rand();
      if (n > 3 && (it & 2)) { b[2] = 0; b[3] = (uint8_t)(1 + rand() % 4); }
    } else {
      if (n > sizeof(seed)) n = sizeof(seed);
      memcpy(b, seed, n);
      if (n) b[rand() % n] = (uint8_t)rand();
    }
    sudp_dst x;
    int r = sudp_parse(b, n, &x);
    if (r == SUDP_OK) {
      CHECK(x.hdr_len <= n && x.port != 0);
      if (x.atyp == 3) CHECK(strlen(x.host) > 0 && strlen(x.host) <= 255);
      else CHECK(x.atyp == 1 || x.atyp == 4);
    } else {
      CHECK(r == SUDP_BAD || r == SUDP_FRAG);
    }
    free(b);
  }
}

int main(void) {
  test_parse_v4();
  test_parse_v6();
  test_parse_name();
  test_refused();
  test_build();
  test_fuzz();
  if (fails) { printf("test_socksudp: %d FAILED\n", fails); return 1; }
  printf("test_socksudp: all passed\n");
  return 0;
}
