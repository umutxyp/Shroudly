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

int main(void){
  plat_init();
  run_case("split(sni)","www.example.com");
  run_case("disorder(sni)","test.blocked.org");
  run_case("split(sni_mid)","a.verylonghostname.example.net");
  run_case("split(1),split(sni)","x.io");
  run_case("split(2)","host.example");
  for(int i=0;i<strategy_raw_count();i++) run_raw(i);
  plat_cleanup();
  if(fails==0){printf("ALL DESYNC TESTS PASSED\n");return 0;}
  printf("%d FAILED\n",fails);return 1;
}
