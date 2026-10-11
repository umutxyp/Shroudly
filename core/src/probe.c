#include "probe.h"
#include "platform.h"
#include "proto.h"
#include "desync.h"
#include "doh.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

/* Build a minimal but realistic TLS 1.2+ ClientHello for `host` with an SNI
 * extension, so the probe exercises the same code path as a real browser. */
static int build_clienthello(uint8_t *b, const char *host) {
  int hl = (int)strlen(host);
  if (hl > 200) return -1;
  int p = 0;
  /* TLS record header filled at end */
  int rec = p; p += 5;
  int hs = p;
  b[p++] = 0x01;                 /* ClientHello */
  int hslen = p; p += 3;         /* handshake length */
  b[p++] = 0x03; b[p++] = 0x03;  /* version 1.2 */
  for (int i = 0; i < 32; i++) b[p++] = (uint8_t)(now_ms() + i); /* random */
  b[p++] = 0;                    /* session id len */
  b[p++] = 0x00; b[p++] = 0x08;  /* cipher suites len = 8 */
  b[p++]=0x13;b[p++]=0x01; b[p++]=0x13;b[p++]=0x02;
  b[p++]=0xc0;b[p++]=0x2f; b[p++]=0x00;b[p++]=0xff;
  b[p++] = 0x01; b[p++] = 0x00;  /* compression: null */
  int ext = p; p += 2;           /* extensions length */
  /* SNI */
  b[p++]=0x00;b[p++]=0x00;
  int snilen = 2 + 1 + 2 + hl;
  b[p++]=(snilen>>8)&0xff; b[p++]=snilen&0xff;
  b[p++]=((hl+3)>>8)&0xff; b[p++]=(hl+3)&0xff;
  b[p++]=0x00;
  b[p++]=(hl>>8)&0xff; b[p++]=hl&0xff;
  memcpy(b+p, host, hl); p += hl;
  /* supported_versions (TLS 1.3) */
  b[p++]=0x00;b[p++]=0x2b; b[p++]=0x00;b[p++]=0x03; b[p++]=0x02; b[p++]=0x03;b[p++]=0x04;
  int extend = p;
  b[ext] = ((extend-ext-2)>>8)&0xff; b[ext+1] = (extend-ext-2)&0xff;
  int hsend = p;
  int hlen = hsend - hs - 4;
  b[hslen] = (hlen>>16)&0xff; b[hslen+1]=(hlen>>8)&0xff; b[hslen+2]=hlen&0xff;
  int reclen = hsend - rec - 5;
  b[rec]=0x16; b[rec+1]=0x03; b[rec+2]=0x01;
  b[rec+3]=(reclen>>8)&0xff; b[rec+4]=reclen&0xff;
  return hsend;
}

static sock_t dial_probe(const char *host, int use_doh, int *fam) {
  struct sockaddr_storage sa; socklen_t sl;
  if (use_doh) {
    if (doh_resolve(host, 443, 0, &sa, &sl) != 0) return SOCK_INVALID;
  } else {
    struct addrinfo h, *r=NULL; memset(&h,0,sizeof(h));
    h.ai_family=AF_INET; h.ai_socktype=SOCK_STREAM;
    if (getaddrinfo(host,"443",&h,&r)!=0||!r) return SOCK_INVALID;
    memcpy(&sa,r->ai_addr,r->ai_addrlen); sl=(socklen_t)r->ai_addrlen; freeaddrinfo(r);
  }
  sock_t s = socket(sa.ss_family, SOCK_STREAM, IPPROTO_TCP);
  if (s==SOCK_INVALID) return s;
  if (sock_connect_timeout(s,(struct sockaddr*)&sa,(int)sl,5000)!=0){sock_close(s);return SOCK_INVALID;}
  sock_set_nodelay(s,1);
  if (fam) *fam = sa.ss_family;
  return s;
}

/* Returns 1 if the server answered with a TLS handshake (ServerHello/alert that
 * is a real TLS record, i.e. not a reset/timeout from DPI). */
static int test_strategy(const char *host, const strategy *st, int use_doh) {
  int fam=0;
  sock_t s = dial_probe(host, use_doh, &fam);
  if (s==SOCK_INVALID) return 0;

  uint8_t ch[512];
  int chlen = build_clienthello(ch, host);
  if (chlen<0){sock_close(s);return 0;}
  proto_info pi; proto_inspect(ch,(size_t)chlen,&pi);

  if (st) desync_send_first(s, fam, ch, chlen, &pi, st, NULL);
  else sock_send_all(s, ch, (size_t)chlen, 0);

  int ok = 0;
  if (sock_wait_readable(s, 4000) == 1) {
    uint8_t r[16];
    int n = recv(s,(char*)r,sizeof(r),0);
    /* 0x16 = handshake (ServerHello), 0x15 = alert. Either means the server
     * received a coherent ClientHello -> DPI did not swallow it. */
    if (n>=1 && (r[0]==0x16 || r[0]==0x15)) ok = 1;
  }
  sock_close(s);
  return ok;
}

int probe_host(const char *host, const engine_config *cfg) {
  /* 1. Baseline: does a plain handshake already work? Then the host isn't
   *    blocked here and no desync is needed. */
  if (test_strategy(host, NULL, cfg->use_doh)) {
    printf("{\"type\":\"probe\",\"host\":\"%s\",\"ok\":true,\"strategy\":\"none\","
           "\"blocked\":false}\n", host);
    fflush(stdout);
    return -2; /* -2 = not blocked, relay as-is */
  }

  /* 2. Try each userspace strategy (split/disorder). */
  int n = strategy_preset_count();
  for (int i = 0; i < n; i++) {
    const strategy *st = strategy_preset(i);
    if (test_strategy(host, st, cfg->use_doh)) {
      printf("{\"type\":\"probe\",\"host\":\"%s\",\"strategy\":\"%s\",\"ok\":true,"
             "\"blocked\":true}\n", host, st->name);
      fflush(stdout);
      engine_learn(host, i);
      return i;
    }
  }

  /* 3. Nothing at this level worked. The host is blocked by DPI that userspace
   *    split/disorder cannot defeat (likely stateful reassembly, e.g. Iran/China).
   *    Signal the UI to offer Advanced (packet-layer) mode. */
  printf("{\"type\":\"probe\",\"host\":\"%s\",\"ok\":false,\"blocked\":true,"
         "\"suggest\":\"advanced\"}\n", host);
  fflush(stdout);
  return -1;
}
