#include "../src/proto.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static int mkch(uint8_t*b,const char*host){
  int hl=(int)strlen(host),p=0;int rec=p;p+=5;int hs=p;b[p++]=0x01;int hsl=p;p+=3;
  b[p++]=0x03;b[p++]=0x03;for(int i=0;i<32;i++)b[p++]=0x41;b[p++]=0;
  b[p++]=0;b[p++]=2;b[p++]=0x13;b[p++]=0x01;b[p++]=1;b[p++]=0;
  int ext=p;p+=2;b[p++]=0;b[p++]=0;int sl=2+1+2+hl;b[p++]=sl>>8;b[p++]=sl&0xff;
  b[p++]=(hl+3)>>8;b[p++]=(hl+3)&0xff;b[p++]=0;b[p++]=hl>>8;b[p++]=hl&0xff;
  memcpy(b+p,host,hl);p+=hl;int ee=p;b[ext]=(ee-ext-2)>>8;b[ext+1]=(ee-ext-2)&0xff;
  int he=p;int hh=he-hs-4;b[hsl]=hh>>16;b[hsl+1]=hh>>8;b[hsl+2]=hh;
  int rl=he-rec-5;b[rec]=0x16;b[rec+1]=0x03;b[rec+2]=0x01;b[rec+3]=rl>>8;b[rec+4]=rl&0xff;
  return he;
}
int main(void){
  uint8_t base[512]; int n=mkch(base,"www.some-host.example.com");
  const char*http="GET /a/b HTTP/1.1\r\nHost: target.example.org\r\nUA: x\r\n\r\n";
  srand(12345);
  for(long it=0; it<2000000; it++){
    uint8_t b[600]; int ln;
    if(it&1){ memcpy(b,base,n); ln=n; } else { ln=(int)strlen(http); memcpy(b,http,ln); }
    int muts=1+rand()%8;
    for(int m=0;m<muts;m++){ int pos=rand()%ln; b[pos]=(uint8_t)rand(); }
    if(rand()%4==0) ln=rand()%(ln+1); /* random truncation */
    proto_info pi; proto_inspect(b,(size_t)ln,&pi);
    tls_expected_len(b,(size_t)ln);
    if(pi.host_off>=0 && pi.host_off+pi.host_len>ln){ printf("BOUNDS BUG at it=%ld\n",it); return 1; }
  }
  printf("MUTATION FUZZ OK (2M iters, no bounds violations)\n");
  return 0;
}
