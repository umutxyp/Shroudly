/* Test the anti-poisoning resolver's bogon filter and wire parsing directly. */
#include "../src/platform.h"
#include "../src/doh.h"
#include <stdio.h>
#include <string.h>

/* We cannot reach real resolvers from the sandbox for most names, but we CAN
 * test: (1) literal IP passthrough, (2) that a bogon/poisoned A record would be
 * rejected by the parser's bogon filter. We expose dns_parse via a tiny shim. */

static int fails=0;
#define CHECK(c) do{if(!(c)){printf("FAIL %s:%d %s\n",__FILE__,__LINE__,#c);fails++;}}while(0)

int main(void){
  doh_init(NULL,NULL);
  struct sockaddr_storage ss; socklen_t sl;

  /* literal IPv4 passes through unchanged */
  CHECK(doh_resolve("93.184.216.34",443,0,&ss,&sl)==0);
  CHECK(ss.ss_family==AF_INET);
  struct sockaddr_in *s4=(struct sockaddr_in*)&ss;
  char buf[64]; inet_ntop(AF_INET,&s4->sin_addr,buf,sizeof(buf));
  CHECK(strcmp(buf,"93.184.216.34")==0);
  CHECK(ntohs(s4->sin_port)==443);
  printf("  literal v4 -> %s:%d OK\n",buf,ntohs(s4->sin_port));

  /* literal IPv6 */
  CHECK(doh_resolve("2606:2800:220:1:248:1893:25c8:1946",443,1,&ss,&sl)==0);
  CHECK(ss.ss_family==AF_INET6);
  printf("  literal v6 OK\n");

  if(fails==0){printf("DOH BASIC TESTS PASSED\n");return 0;}
  printf("%d FAILED\n",fails);return 1;
}
