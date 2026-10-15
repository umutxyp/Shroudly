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

/* A response carrying several records: ips[i] (A) with ttls[i]. When cname is
 * set, a CNAME record comes first and the A records hang off a name that is
 * part label, part compression pointer — the shape real resolvers send. */
static int build_multi(uint8_t *b, const char *name, const uint32_t *ips, const uint32_t *ttls,
                       int n, int cname) {
  int p=0;
  b[p++]=0x12; b[p++]=0x34; b[p++]=0x81; b[p++]=0x80;
  b[p++]=0; b[p++]=1; b[p++]=0; b[p++]=(uint8_t)(n+(cname?1:0));
  b[p++]=0; b[p++]=0; b[p++]=0; b[p++]=0;
  const char *s=name;
  while(*s){ const char*d=strchr(s,'.'); int l=d?(int)(d-s):(int)strlen(s);
    b[p++]=(uint8_t)l; memcpy(b+p,s,l); p+=l; if(!d)break; s=d+1; }
  b[p++]=0; b[p++]=0;b[p++]=1; b[p++]=0;b[p++]=1;
  int target=0x0c;
  if(cname){
    b[p++]=0xc0; b[p++]=0x0c; b[p++]=0;b[p++]=5; b[p++]=0;b[p++]=1;
    b[p++]=0;b[p++]=0;b[p++]=0;b[p++]=60; b[p++]=0;b[p++]=6;
    target=p;                                   /* "\x03cdn" + pointer to the name */
    b[p++]=3; b[p++]='c'; b[p++]='d'; b[p++]='n'; b[p++]=0xc0; b[p++]=0x0c;
  }
  for(int i=0;i<n;i++){
    b[p++]=(uint8_t)(0xc0|(target>>8)); b[p++]=(uint8_t)(target&0xff);
    b[p++]=0;b[p++]=1; b[p++]=0;b[p++]=1;
    b[p++]=(uint8_t)(ttls[i]>>24); b[p++]=(uint8_t)(ttls[i]>>16); b[p++]=(uint8_t)(ttls[i]>>8); b[p++]=(uint8_t)ttls[i];
    b[p++]=0;b[p++]=4;
    b[p++]=(uint8_t)(ips[i]>>24); b[p++]=(uint8_t)(ips[i]>>16); b[p++]=(uint8_t)(ips[i]>>8); b[p++]=(uint8_t)ips[i];
  }
  return p;
}

/* dns_parse with the old one-address shape, for the single-record checks. */
static int parse1(const uint8_t *b, int n) {
  uint8_t a[DOH_MAX_ADDRS][16]; int na=0; uint32_t ttl=0;
  return dns_parse(b,n,0,a,DOH_MAX_ADDRS,&na,&ttl);
}

int main(void){
  uint8_t b[512];
  doh_init(NULL,NULL);

  /* 1. a legitimate public IP is accepted */
  int n=build_resp(b,0x1234,"example.com",0x5db8d822 /*93.184.216.34*/);
  CHECK(parse1(b,n)==0);
  printf("  legit public IP accepted: OK\n");

  /* 2. poisoned answer -> 127.0.0.1 (loopback bogon) is REJECTED */
  n=build_resp(b,0x1234,"blocked.com",0x7f000001 /*127.0.0.1*/);
  CHECK(parse1(b,n)!=0);
  printf("  poisoned 127.0.0.1 rejected: %s\n", parse1(b,n)!=0?"OK":"FAIL");

  /* 3. poisoned -> 0.0.0.0 rejected */
  n=build_resp(b,0x1234,"blocked.com",0x00000000);
  CHECK(parse1(b,n)!=0);

  /* 4. poisoned -> 10.x private (common sinkhole) rejected */
  n=build_resp(b,0x1234,"blocked.com",0x0a0a0a0a /*10.10.10.10*/);
  CHECK(parse1(b,n)!=0);
  printf("  poisoned 10.10.10.10 rejected: OK\n");

  /* 5. poisoned -> 192.168.x rejected */
  n=build_resp(b,0x1234,"blocked.com",0xc0a80001);
  CHECK(parse1(b,n)!=0);

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
  for(int cut=0;cut<n;cut++){ parse1(b,cut); }
  printf("  truncated parse (no crash): OK\n");

  /* 8. every usable address comes back, in order, bogons left out, with the
   *    smallest TTL — also through a CNAME with a part-compressed name */
  for(int cname=0;cname<2;cname++){
    uint32_t ips[4]={0x5db8d822,0x7f000001,0x08080808,0x01010101};
    uint32_t ttls[4]={600,5,90,3600};
    n=build_multi(b,"multi.example.com",ips,ttls,4,cname);
    uint8_t a[DOH_MAX_ADDRS][16]; int na=0; uint32_t ttl=0;
    CHECK(dns_parse(b,n,0,a,DOH_MAX_ADDRS,&na,&ttl)==0);
    CHECK(na==3);
    CHECK(a[0][0]==93 && a[1][0]==8 && a[2][0]==1);
    CHECK(ttl==90);                     /* the bogon's TTL does not count */
    na=0; CHECK(dns_parse(b,n,0,a,2,&na,&ttl)==0 && na==2);   /* capped */
    for(int cut=0;cut<n;cut++){ dns_parse(b,cut,0,a,DOH_MAX_ADDRS,&na,&ttl); }
  }
  printf("  all addresses of a name, bogons dropped, min TTL, CNAME: OK\n");

  /* 9. only bogons -> no usable record */
  { uint32_t ips[2]={0x0a000001,0x7f000001}, ttls[2]={60,60};
    n=build_multi(b,"x.com",ips,ttls,2,0);
    uint8_t a[DOH_MAX_ADDRS][16]; int na=0; uint32_t ttl=0;
    CHECK(dns_parse(b,n,0,a,DOH_MAX_ADDRS,&na,&ttl)==DNS_NODATA && na==0); }

  /* 9b. NXDOMAIN is an answer ("no such name"); SERVFAIL is not */
  { uint32_t ips[1]={0x08080808}, ttls[1]={60};
    n=build_multi(b,"x.com",ips,ttls,1,0);
    uint8_t a[DOH_MAX_ADDRS][16]; int na=0; uint32_t ttl=0;
    b[3]=0x83; CHECK(dns_parse(b,n,0,a,DOH_MAX_ADDRS,&na,&ttl)==DNS_NXDOMAIN);
    b[3]=0x82; CHECK(dns_parse(b,n,0,a,DOH_MAX_ADDRS,&na,&ttl)==-1); }

  /* 10. TTL is honoured but held to 20 s .. 5 min */
  CHECK(ttl_clamp(0)==20 && ttl_clamp(19)==20 && ttl_clamp(60)==60 && ttl_clamp(300)==300 && ttl_clamp(86400)==300);
  { uint8_t a[3][16]; memset(a,0,sizeof(a));
    a[0][0]=93; a[0][3]=1; a[1][0]=8; a[1][3]=8; a[2][0]=1; a[2][3]=1;
    uint64_t t0=now_ms();
    mutex_lock(&g_cache_mx); cache_put("ttl.example",AF_INET,a,3,1); cache_entry *e=cache_find("ttl.example",AF_INET);
    CHECK(e && e->expires>=t0+20000 && e->expires<=now_ms()+20000);
    cache_put("ttl.example",AF_INET,a,3,100000); e=cache_find("ttl.example",AF_INET);
    CHECK(e && e->expires<=now_ms()+300000 && e->expires>=t0+300000);
    mutex_unlock(&g_cache_mx);

    /* 11. cached answers come back in full, with the asked port */
    struct sockaddr_storage out[DOH_MAX_ADDRS]; socklen_t ol[DOH_MAX_ADDRS];
    CHECK(doh_resolve_all("ttl.example",8443,0,out,ol,DOH_MAX_ADDRS)==3);
    CHECK(ntohs(((struct sockaddr_in*)&out[1])->sin_port)==8443);
    CHECK(((uint8_t*)&((struct sockaddr_in*)&out[1])->sin_addr)[0]==8);

    /* 12. an address that failed is dropped; once none are left the name
     *     is looked up again */
    doh_forget("ttl.example",&out[0]);
    CHECK(doh_resolve_all("ttl.example",443,0,out,ol,DOH_MAX_ADDRS)==2);
    CHECK(((uint8_t*)&((struct sockaddr_in*)&out[0])->sin_addr)[0]==8);
    doh_forget("ttl.example",&out[0]); doh_forget("ttl.example",&out[1]);
    mutex_lock(&g_cache_mx); CHECK(cache_find("ttl.example",AF_INET)==NULL); mutex_unlock(&g_cache_mx);
  }
  printf("  TTL clamp, multi-address cache, forget-on-failure: OK\n");

  /* 13. block pages a SOCKS4 request is recovered from: the built-in one and
   *     those the app adds — never 0.0.0.0 or loopback, which a hosts file or
   *     the user's own filtering DNS answers with on purpose, and never a LAN
   *     address someone asked for */
  CHECK(doh_ipv4_is_blockpage(0xC3AFFE02u)==1);
  CHECK(doh_ipv4_is_blockpage(0xcb00710a)==0);           /* 203.0.113.10 */
  doh_add_block_ip("203.0.113.10");
  CHECK(doh_ipv4_is_blockpage(0xcb00710a)==1);
  CHECK(doh_ipv4_is_blockpage(0)==0);
  CHECK(doh_ipv4_is_blockpage(0x7f000001)==0 && doh_ipv4_is_blockpage(0x7f0000fe)==0);
  CHECK(doh_ipv4_is_blockpage(0xc0a80101)==0 && doh_ipv4_is_blockpage(0x08080808)==0);
  printf("  block-page addresses: OK\n");

  if(fails==0){printf("ANTI-POISONING TESTS PASSED\n");return 0;}
  printf("%d FAILED\n",fails);return 1;
}
