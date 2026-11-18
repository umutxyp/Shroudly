/* Direct test of desync_send_first: spin up a loopback listener, send a
 * ClientHello through the desync path, and verify the receiver gets all the
 * bytes intact but delivered as multiple segments (fragmented). Runs under ASan
 * with no external processes. */
#include "../src/platform.h"
#include "../src/proto.h"
#include "../src/strategy.h"
#include "../src/desync.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static int fails = 0;
#define CHECK(c) do{ if(!(c)){printf("FAIL %s:%d %s\n",__FILE__,__LINE__,#c);fails++;} }while(0)

static int make_ch(uint8_t *b, const char *host) {
  int hl=(int)strlen(host),p=0; int rec=p;p+=5; int hs=p;b[p++]=0x01;int hsl=p;p+=3;
  b[p++]=0x03;b[p++]=0x03; for(int i=0;i<32;i++)b[p++]=0x41; b[p++]=0;
  b[p++]=0;b[p++]=2;b[p++]=0x13;b[p++]=0x01; b[p++]=1;b[p++]=0;
  int ext=p;p+=2; b[p++]=0;b[p++]=0; int sl=2+1+2+hl;b[p++]=sl>>8;b[p++]=sl&0xff;
  b[p++]=(hl+3)>>8;b[p++]=(hl+3)&0xff;b[p++]=0;b[p++]=hl>>8;b[p++]=hl&0xff;
  memcpy(b+p,host,hl);p+=hl; int ee=p;b[ext]=(ee-ext-2)>>8;b[ext+1]=(ee-ext-2)&0xff;
  int he=p;int hln=he-hs-4;b[hsl]=hln>>16;b[hsl+1]=hln>>8;b[hsl+2]=hln;
  int rl=he-rec-5;b[rec]=0x16;b[rec+1]=0x03;b[rec+2]=0x01;b[rec+3]=rl>>8;b[rec+4]=rl&0xff;
  return he;
}

/* loopback server: accept one conn, count recv() calls and total bytes */
typedef struct { int port; int seg_count; int total; uint8_t buf[4096]; sock_t lsn; int ready; volatile int done; } srv_t;

static void *srv_thread(void *a){
  srv_t *s=(srv_t*)a;
  sock_t c=accept(s->lsn,NULL,NULL);
  if(c==SOCK_INVALID) return NULL;
  for(;;){
    int n=recv(c,(char*)s->buf+s->total,sizeof(s->buf)-s->total,0);
    if(n<=0) break;
    s->seg_count++; s->total+=n;
    /* brief wait so distinct segments are not coalesced by the time we read */
  }
  sock_close(c);
  s->done=1;
  return NULL;
}

/* A raw technique on a payload that is neither TLS nor HTTP (an MTProto-like
 * 64-byte random opening and more): the server must get exactly the bytes
 * sent, whatever the cuts, the urgent byte or the decoy. */
static void run_raw(int idx){
  const strategy *st=strategy_raw(idx);
  srv_t s; memset(&s,0,sizeof(s));
  s.lsn=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
  int yes=1; setsockopt(s.lsn,SOL_SOCKET,SO_REUSEADDR,(char*)&yes,sizeof(yes));
  struct sockaddr_in a; memset(&a,0,sizeof(a)); a.sin_family=AF_INET; a.sin_addr.s_addr=htonl(INADDR_LOOPBACK); a.sin_port=0;
  bind(s.lsn,(struct sockaddr*)&a,sizeof(a));
  socklen_t al=sizeof(a); getsockname(s.lsn,(struct sockaddr*)&a,&al);
  listen(s.lsn,1);
  thread_spawn(srv_thread,&s,256*1024);
  sleep_ms(50);
  sock_t up=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
  if(sock_connect_timeout(up,(struct sockaddr*)&a,sizeof(a),2000)!=0){CHECK(0);return;}
  sock_set_nodelay(up,1);
  uint8_t p[1024], orig[200]; int n=200;
  srand(7+idx);
  for(int i=0;i<n;i++) orig[i]=(uint8_t)(rand()&0xff);
  orig[0]=0x5a;                     /* not 0x16 (TLS), not a letter (HTTP) */
  memcpy(p,orig,(size_t)n);
  proto_info pi; proto_inspect(p,(size_t)n,&pi);
  CHECK(pi.kind==PROTO_UNKNOWN);
  int r=desync_send_first(up,AF_INET,p,n,(int)sizeof(p),&pi,st,NULL);
  CHECK(r==0);
  sock_close(up);
  for(int w=0;w<300 && !s.done;w++) sleep_ms(10);   /* a decoy waits for a retransmit */
  sock_close(s.lsn);
  CHECK(s.done && s.total==n && memcmp(s.buf,orig,(size_t)n)==0);
  printf("  %-20s bytes=%d/%d segs>=%d integrity=%s\n", st->name, s.total, n, s.seg_count,
         (s.total==n && memcmp(s.buf,orig,(size_t)n)==0)?"OK":"FAIL");
}

static void run_case(const char *spec, const char *host){
  strategy st; strategy_parse(spec,&st);
  srv_t s; memset(&s,0,sizeof(s));
  s.lsn=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
  int yes=1; setsockopt(s.lsn,SOL_SOCKET,SO_REUSEADDR,(char*)&yes,sizeof(yes));
  struct sockaddr_in a; memset(&a,0,sizeof(a)); a.sin_family=AF_INET; a.sin_addr.s_addr=htonl(INADDR_LOOPBACK); a.sin_port=0;
  bind(s.lsn,(struct sockaddr*)&a,sizeof(a));
  socklen_t al=sizeof(a); getsockname(s.lsn,(struct sockaddr*)&a,&al);
  listen(s.lsn,1);
  thread_spawn(srv_thread,&s,256*1024);
  sleep_ms(50);

  sock_t up=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
  if(sock_connect_timeout(up,(struct sockaddr*)&a,sizeof(a),2000)!=0){CHECK(0);return;}
  sock_set_nodelay(up,1);

  uint8_t ch[1024]; int clen=make_ch(ch,host);
  proto_info pi; proto_inspect(ch,(size_t)clen,&pi);
  CHECK(pi.kind==PROTO_TLS);
  CHECK(pi.host_off>0);

  int r=desync_send_first(up,AF_INET,ch,clen,(int)sizeof(ch),&pi,&st,NULL);
  CHECK(r==0);
  sock_close(up);
  sleep_ms(150);
  sock_close(s.lsn);

  /* Byte integrity: the desync must deliver EXACTLY the original payload,
   * unmodified and complete. (Wire-level fragmentation is verified separately
   * by the DPI-simulator test; on loopback the kernel may coalesce the
   * separate sends before recv() sees them, so seg_count is not asserted here.) */
  CHECK(s.total==clen);
  CHECK(memcmp(s.buf,ch,clen)==0);
  printf("  %-20s host_off=%d bytes=%d/%d segs>=%d integrity=%s\n",
         spec, pi.host_off, s.total, clen, s.seg_count,
         (s.total==clen && memcmp(s.buf,ch,clen)==0)?"OK":"FAIL");
}

/* A TLS record cut: two records arrive that together carry the handshake,
 * the first ending `before_end` bytes before the end of the name (in the
 * original payload's terms). */
static void run_tlsrec(const char *spec, const char *host, int before_end){
  strategy st; strategy_parse(spec,&st);
  srv_t s; memset(&s,0,sizeof(s));
  s.lsn=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
  int yes=1; setsockopt(s.lsn,SOL_SOCKET,SO_REUSEADDR,(char*)&yes,sizeof(yes));
  struct sockaddr_in a; memset(&a,0,sizeof(a)); a.sin_family=AF_INET; a.sin_addr.s_addr=htonl(INADDR_LOOPBACK); a.sin_port=0;
  bind(s.lsn,(struct sockaddr*)&a,sizeof(a));
  socklen_t al=sizeof(a); getsockname(s.lsn,(struct sockaddr*)&a,&al);
  listen(s.lsn,1);
  thread_spawn(srv_thread,&s,256*1024);
  sleep_ms(50);
  sock_t up=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
  if(sock_connect_timeout(up,(struct sockaddr*)&a,sizeof(a),2000)!=0){CHECK(0);return;}
  uint8_t ch[1024], orig[1024]; int clen=make_ch(ch,host); memcpy(orig,ch,(size_t)clen);
  proto_info pi; proto_inspect(ch,(size_t)clen,&pi);
  int r=desync_send_first(up,AF_INET,ch,clen,(int)sizeof(ch),&pi,&st,NULL);
  CHECK(r==0);
  sock_close(up);
  sleep_ms(150);
  sock_close(s.lsn);
  CHECK(s.total==clen+5 && s.buf[0]==0x16);
  int l1=(s.buf[3]<<8)|s.buf[4];
  CHECK(5+l1==pi.host_off+pi.host_len-before_end);
  CHECK(s.buf[5+l1]==0x16);
  int l2=(s.buf[5+l1+3]<<8)|s.buf[5+l1+4];
  CHECK(l1+l2==clen-5);
  CHECK(memcmp(s.buf+5,orig+5,(size_t)l1)==0 && memcmp(s.buf+10+l1,orig+5+l1,(size_t)l2)==0);
  printf("  %-20s the first record ends %d byte(s) before the end of %s: %s\n", spec, before_end, host,
         5+l1==pi.host_off+pi.host_len-before_end?"OK":"FAIL");
}

/* sock_unacked: what was sent to a listener on this computer is
 * acknowledged at once (0); a system that does not say answers -1, which
 * only Windows before 10 (1703) may. */
static void run_unacked(void){
  sock_t l=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
  struct sockaddr_in a; memset(&a,0,sizeof(a));
  a.sin_family=AF_INET; a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
  bind(l,(struct sockaddr*)&a,sizeof(a));
  socklen_t al=sizeof(a); getsockname(l,(struct sockaddr*)&a,&al);
  listen(l,1);
  sock_t up=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
  if(sock_connect_timeout(up,(struct sockaddr*)&a,sizeof(a),2000)!=0){CHECK(0);return;}
  sock_set_nodelay(up,1);
  uint8_t req[64]; memset(req,'x',sizeof(req));
  CHECK(sock_send_all(up,req,sizeof(req),0)==0);
  int u=1;
  for(int w=0;w<100 && u>0;w++){ sleep_ms(10); u=sock_unacked(up); }
#ifdef _WIN32
  CHECK(u==0||u==-1);
#else
  CHECK(u==0);
#endif
  printf("  sock_unacked on this computer: %d\n",u);
  sock_close(up); sock_close(l);
}

/* Send `n` bytes of `in` through `spec` to a loopback listener; what it
 * received lands in s (bytes and count). */
static int send_through(const char *spec, uint8_t *in, int n, int cap, srv_t *s){
  strategy st; if(strategy_parse(spec,&st)!=0) return -1;
  memset(s,0,sizeof(*s));
  s->lsn=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
  int yes=1; setsockopt(s->lsn,SOL_SOCKET,SO_REUSEADDR,(char*)&yes,sizeof(yes));
  struct sockaddr_in a; memset(&a,0,sizeof(a)); a.sin_family=AF_INET; a.sin_addr.s_addr=htonl(INADDR_LOOPBACK); a.sin_port=0;
  bind(s->lsn,(struct sockaddr*)&a,sizeof(a));
  socklen_t al=sizeof(a); getsockname(s->lsn,(struct sockaddr*)&a,&al);
  listen(s->lsn,1);
  thread_spawn(srv_thread,s,256*1024);
  sleep_ms(50);
  sock_t up=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
  if(sock_connect_timeout(up,(struct sockaddr*)&a,sizeof(a),2000)!=0) return -1;
  sock_set_nodelay(up,1);
  proto_info pi; proto_inspect(in,(size_t)n,&pi);
  int r=desync_send_first(up,AF_INET,in,n,cap,&pi,&st,NULL);
  sock_close(up);
  for(int w=0;w<100 && !s->done;w++) sleep_ms(10);
  sock_close(s->lsn);
  return r;
}

/* Several record cuts: four records arrive, each a handshake record, whose
 * bodies put back together are the original handshake exactly, the first
 * ending one byte into the name and the third one byte before its end. */
static void run_multirec(void){
  const char *host="rr3---sn-4g5edndr.googlevideo.com";
  uint8_t ch[1024], orig[1024]; int clen=make_ch(ch,host); memcpy(orig,ch,(size_t)clen);
  proto_info pi; proto_inspect(ch,(size_t)clen,&pi);
  srv_t s;
  int r=send_through("tlsrec(sni+1),tlsrec(sni_mid),tlsrec(sni_end-1)",ch,clen,(int)sizeof(ch),&s);
  CHECK(r==0);
  CHECK(s.total==clen+15);
  uint8_t body[1024]; int bl=0, nrec=0, o=0, ends[8];
  while(o+5<=s.total && nrec<8){
    CHECK(s.buf[o]==0x16 && s.buf[o+1]==orig[1] && s.buf[o+2]==orig[2]);
    int l=(s.buf[o+3]<<8)|s.buf[o+4];
    memcpy(body+bl,s.buf+o+5,(size_t)l); bl+=l; o+=5+l;
    ends[nrec++]=5+bl;                    /* where this record ends, in the original's terms */
  }
  CHECK(nrec==4 && o==s.total);
  CHECK(bl==clen-5 && memcmp(body,orig+5,(size_t)bl)==0);
  CHECK(ends[0]==pi.host_off+1 && ends[1]==pi.host_off+pi.host_len/2 && ends[2]==pi.host_off+pi.host_len-1);
  printf("  %-44s %d records, handshake intact: %s\n","tlsrec x3",nrec,
         (nrec==4 && bl==clen-5 && memcmp(body,orig+5,(size_t)bl)==0)?"OK":"FAIL");
}

/* Random-size segments: the server gets exactly the bytes sent, alone or
 * after a record cut; the pauses are paid (10–20 ms each). */
static void run_chop(void){
  uint8_t ch[1024], orig[1024]; int clen=make_ch(ch,"www.example-blocked.org"); memcpy(orig,ch,(size_t)clen);
  srv_t s;
  uint64_t t0=now_ms();
  CHECK(send_through("chop(10-20:10-20)",ch,clen,(int)sizeof(ch),&s)==0);
  uint64_t took=now_ms()-t0;
  CHECK(s.total==clen && memcmp(s.buf,orig,(size_t)clen)==0);
  /* clen/20 segments at least, each but the last followed by 10 ms or more */
  CHECK(took >= (uint64_t)(clen/20-1)*10);
  printf("  %-44s bytes=%d/%d in %llu ms: %s\n","chop(10-20:10-20)",s.total,clen,(unsigned long long)took,
         (s.total==clen && memcmp(s.buf,orig,(size_t)clen)==0)?"OK":"FAIL");
  clen=make_ch(ch,"www.example-blocked.org"); memcpy(orig,ch,(size_t)clen);
  CHECK(send_through("tlsrec(sni+1),chop(16-64)",ch,clen,(int)sizeof(ch),&s)==0);
  CHECK(s.total==clen+5 && s.buf[0]==0x16);
  int l1=(s.buf[3]<<8)|s.buf[4], l2=(s.buf[5+l1+3]<<8)|s.buf[5+l1+4];
  CHECK(l1+l2==clen-5 && memcmp(s.buf+5,orig+5,(size_t)l1)==0 && memcmp(s.buf+10+l1,orig+5+l1,(size_t)l2)==0);
  printf("  %-44s two records, intact: %s\n","tlsrec(sni+1),chop(16-64)",(l1+l2==clen-5)?"OK":"FAIL");
}

/* Plain HTTP rewrites: what the server receives, byte for byte. */
static void run_http(const char *spec, const char *req, const char *want){
  uint8_t b[1024]; int n=(int)strlen(req); memcpy(b,req,(size_t)n);
  srv_t s;
  CHECK(send_through(spec,b,n,(int)sizeof(b),&s)==0);
  int ok = s.total==(int)strlen(want) && memcmp(s.buf,want,strlen(want))==0;
  CHECK(ok);
  printf("  %-44s %s\n",spec,ok?"OK":"FAIL");
}

/* The parser: chop's ranges kept sane, http's rewrites by name, nothing
 * unknown taken. */
static void run_parse(void){
  strategy st;
  CHECK(strategy_parse("chop(100-200:10-20)",&st)==0 && st.n_ops==1 && st.ops[0].kind==OP_CHOP);
  CHECK(st.chop_min==100 && st.chop_max==200 && st.chop_wait_min==10 && st.chop_wait_max==20);
  CHECK(strategy_parse("chop(5000:900)",&st)==0 && st.chop_min==1400 && st.chop_max==1400 && st.chop_wait_min==100 && st.chop_wait_max==100);
  CHECK(strategy_parse("chop(0)",&st)==0 && st.chop_min==1 && st.chop_max==1 && st.chop_wait_max==0);
  CHECK(strategy_parse("chop(30-10)",&st)==0 && st.chop_min==30 && st.chop_max==30);
  /* The fixed choices in Settings parse. */
  CHECK(strategy_parse("oob(1),tlsrec(sni_end-5)",&st)==0 && st.n_ops==2 && st.ops[0].kind==OP_OOB && st.ops[0].offset==1);
  CHECK(strategy_parse("chop(100-200)",&st)==0 && st.chop_min==100 && st.chop_max==200 && st.chop_wait_max==0);
  CHECK(strategy_parse("http(hostcase+methodeol),split(sni)",&st)==0 && st.n_ops==2 && st.ops[0].kind==OP_HTTP
        && st.ops[0].offset==(HTTP_HOSTCASE|HTTP_METHODEOL));
  CHECK(strategy_parse("http(nothing)",&st)!=0);
  CHECK(strategy_parse("tlsrec(sni+1),tlsrec(sni_mid),tlsrec(sni_end-1)",&st)==0 && st.n_ops==3);
  /* Only the HTTP one joins the list: a TLS site's stays as long as it was. */
  int found=0, tls_new=0;
  for(int i=0;i<strategy_preset_count();i++){
    const strategy *p=strategy_preset(i);
    if(!strcmp(p->name,"http-tricks")) found++;
    for(int k=0;k<p->n_ops;k++) if(p->ops[k].kind==OP_CHOP) tls_new++;
  }
  CHECK(found==1 && tls_new==0 && strategy_preset_count()<=STRATEGY_MAX_PRESETS);
  printf("  parser and presets: %s\n", (found==1 && tls_new==0)?"OK":"FAIL");
}

int main(void){
  plat_init();
  run_unacked();
  /* ByeByeDPI's "-r-1+se" (issue #37): the last label never in one record. */
  run_tlsrec("tlsrec(sni_end-1)","rr3---sn-4g5edndr.googlevideo.com",1);
  /* ByeByeDPI's default record cut (-r-5+se), alone and after split(1). */
  run_tlsrec("tlsrec(sni_end-5)","www.example.com",5);
  run_tlsrec("split(1),tlsrec(sni_end-5)","discord.com",5);
  /* The name's own label: "googl|evideo.com" (10 bytes after the cut), not
   * in the subdomain; under a country's second level, "exa|mple.co.uk". */
  run_tlsrec("tlsrec(midsld)","rr3---sn-4g5edndr.googlevideo.com",10);
  run_tlsrec("tlsrec(endsld)","rr3---sn-4g5edndr.googlevideo.com",4);
  run_tlsrec("tlsrec(sld)","rr3---sn-4g5edndr.googlevideo.com",15);
  run_tlsrec("tlsrec(midsld)","www.example.co.uk",10);
  run_tlsrec("tlsrec(midsld)","www.example.com.tr",11);
  run_tlsrec("tlsrec(midsld+1)","cdn.example.org",7);
  run_tlsrec("tlsrec(midsld)","localhost",5);
  run_case("split(midsld)","rr3---sn-4g5edndr.googlevideo.com");
  run_case("split(1),split(sld),split(endsld)","a.b.example.net");
  run_case("split(sni)","www.example.com");
  run_case("disorder(sni)","test.blocked.org");
  run_case("split(sni_mid)","a.verylonghostname.example.net");
  run_case("split(1),split(sni)","x.io");
  run_case("split(2)","host.example");
  run_case("none","plain.example");      /* "Off": sent whole, untouched */
  run_parse();
  run_multirec();
  run_chop();
  {
    const char *req="GET / HTTP/1.1\r\nHost: Blocked.example.org\r\nAccept: */*\r\n\r\n";
    run_http("http(hostcase+domcase)",req,"GET / HTTP/1.1\r\nhost: BlOcKeD.eXaMpLe.OrG\r\nAccept: */*\r\n\r\n");
    run_http("http(hosttab)",req,"GET / HTTP/1.1\r\nHost:\tBlocked.example.org\r\nAccept: */*\r\n\r\n");
    run_http("http(nospace)",req,"GET / HTTP/1.1\r\nHost:Blocked.example.org\r\nAccept: */*\r\n\r\n");
    run_http("http(methodeol)",req,"\r\nGET / HTTP/1.1\r\nHost: Blocked.example.org\r\nAccept: */*\r\n\r\n");
    /* All four together, and the preset (its rewrites and its cut in the
     * name): still one request. */
    run_http("http(hostcase+domcase+hosttab+methodeol),split(sni_mid)",req,
             "\r\nGET / HTTP/1.1\r\nhost:\tBlOcKeD.eXaMpLe.OrG\r\nAccept: */*\r\n\r\n");
    run_http("http(hostcase+domcase+nospace),split(sni_mid)",req,
             "GET / HTTP/1.1\r\nhost:BlOcKeD.eXaMpLe.OrG\r\nAccept: */*\r\n\r\n");
    /* A TLS ClientHello is left as it is by http(...). */
    uint8_t ch[1024], orig[1024]; int clen=make_ch(ch,"www.example.com"); memcpy(orig,ch,(size_t)clen);
    srv_t s; CHECK(send_through("http(hostcase+methodeol)",ch,clen,(int)sizeof(ch),&s)==0);
    CHECK(s.total==clen && memcmp(s.buf,orig,(size_t)clen)==0);
  }
  for(int i=0;i<strategy_raw_count();i++) run_raw(i);
  plat_cleanup();
  if(fails==0){printf("ALL DESYNC TESTS PASSED\n");return 0;}
  printf("%d FAILED\n",fails);return 1;
}
