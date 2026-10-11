/* White-box test of the resolver's poisoning defenses by including doh.c. */
#define main doh_main_unused
#include "../src/doh.c"
#undef main
#include <stdio.h>

static int fails=0;
#define CHECK(c) do{if(!(c)){printf("FAIL %s:%d %s\n",__FILE__,__LINE__,#c);fails++;}}while(0)

/* Build a DNS response with one A record pointing at the given IPv4. */
static int build_resp(uint8_t *b, uint16_t id, const char *name, uint32_t ip) {
  int p=0;
  b[p++]=id>>8; b[p++]=id&0xff;
  b[p++]=0x81; b[p++]=0x80;   /* response, no error */
  b[p++]=0; b[p++]=1;         /* qd */
  b[p++]=0; b[p++]=1;         /* an */
  b[p++]=0; b[p++]=0; b[p++]=0; b[p++]=0;
  /* question */
  const char *s=name;
  while(*s){ const char*d=strchr(s,'.'); int l=d?(int)(d-s):(int)strlen(s);
    b[p++]=(uint8_t)l; memcpy(b+p,s,l); p+=l; if(!d)break; s=d+1; }
  b[p++]=0; b[p++]=0;b[p++]=1; b[p++]=0;b[p++]=1;
  /* answer: name ptr to 0x0c, type A, class IN, ttl, rdlen 4, ip */
  b[p++]=0xc0; b[p++]=0x0c;
  b[p++]=0;b[p++]=1; b[p++]=0;b[p++]=1;
  b[p++]=0;b[p++]=0;b[p++]=0;b[p++]=60;
  b[p++]=0;b[p++]=4;
  b[p++]=(ip>>24)&0xff; b[p++]=(ip>>16)&0xff; b[p++]=(ip>>8)&0xff; b[p++]=ip&0xff;
  return p;
}

int main(void){
  uint8_t b[512]; struct sockaddr_storage ss; socklen_t sl;

  /* 1. a legitimate public IP is accepted */
  int n=build_resp(b,0x1234,"example.com",0x5db8d822 /*93.184.216.34*/);
  CHECK(dns_parse(b,n,0,&ss,&sl,443)==0);
  printf("  legit public IP accepted: OK\n");

  /* 2. poisoned answer -> 127.0.0.1 (loopback bogon) is REJECTED */
  n=build_resp(b,0x1234,"blocked.com",0x7f000001 /*127.0.0.1*/);
  CHECK(dns_parse(b,n,0,&ss,&sl,443)!=0);
  printf("  poisoned 127.0.0.1 rejected: %s\n", dns_parse(b,n,0,&ss,&sl,443)!=0?"OK":"FAIL");

  /* 3. poisoned -> 0.0.0.0 rejected */
  n=build_resp(b,0x1234,"blocked.com",0x00000000);
  CHECK(dns_parse(b,n,0,&ss,&sl,443)!=0);

  /* 4. poisoned -> 10.x private (common sinkhole) rejected */
  n=build_resp(b,0x1234,"blocked.com",0x0a0a0a0a /*10.10.10.10*/);
  CHECK(dns_parse(b,n,0,&ss,&sl,443)!=0);
  printf("  poisoned 10.10.10.10 rejected: OK\n");

  /* 5. poisoned -> 192.168.x rejected */
  n=build_resp(b,0x1234,"blocked.com",0xc0a80001);
  CHECK(dns_parse(b,n,0,&ss,&sl,443)!=0);

  /* 6. bogon filter unit checks */
  CHECK(is_bogon_v4(0x7f000001)==1); /* 127.0.0.1 */
  CHECK(is_bogon_v4(0x0a000001)==1); /* 10.0.0.1 */
  CHECK(is_bogon_v4(0xc0a80001)==1); /* 192.168.0.1 */
  CHECK(is_bogon_v4(0xac100001)==1); /* 172.16.0.1 */
  CHECK(is_bogon_v4(0xa9fe0001)==1); /* 169.254.0.1 */
  CHECK(is_bogon_v4(0xe0000001)==1); /* 224.0.0.1 multicast */
  CHECK(is_bogon_v4(0x08080808)==0); /* 8.8.8.8 ok */
  CHECK(is_bogon_v4(0x5db8d822)==0); /* 93.184.216.34 ok */
  printf("  bogon filter unit checks: OK\n");

  /* 7. truncated response must not crash */
  n=build_resp(b,0x1234,"x.com",0x08080808);
  for(int cut=0;cut<n;cut++){ dns_parse(b,cut,0,&ss,&sl,443); }
  printf("  truncated parse (no crash): OK\n");

  if(fails==0){printf("ANTI-POISONING TESTS PASSED\n");return 0;}
  printf("%d FAILED\n",fails);return 1;
}
