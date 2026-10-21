/* White-box test of the engine's per-host memory, by including engine.c:
 * which names make one site, what a name takes from its site and when, where
 * a silent ladder resumes (and that it is one name's alone), when a learned
 * technique is due to be checked again, and where a cut moves a host on to. */
#include "../src/engine.c"
#include <stdio.h>

static int fails = 0;
#define CHECK(c) do{ if(!(c)){ printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #c); fails++; } }while(0)

/* site_of(h) is `want`, or there is none when want is NULL. */
static int site_is(const char *h, const char *want) {
  char out[256];
  int r = site_of(h, out, sizeof(out));
  return want ? (r == 1 && strcmp(out, want) == 0) : r == 0;
}

/* Where the ladder starts: the resume point, else the learned technique as
 * 100 + preset (or 200 + preset when it is the site's), else -1. */
static int start_of(const char *h) {
  int from, learned, inh, stale;
  ladder_start(h, 1, &from, &learned, &inh, &stale);
  return from >= 0 ? from : learned >= 0 ? (inh ? 200 : 100) + learned : -1;
}

/* Whether the technique h's ladder would open with is due to be checked. */
static int stale_of(const char *h) {
  int from, learned, inh, stale;
  ladder_start(h, 1, &from, &learned, &inh, &stale);
  return learned >= 0 && stale;
}

/* The next usable preset after i, round the list. */
static int next_usable(int i) {
  int np = strategy_preset_count();
  for (int k = 1; k <= np; k++)
    if (preset_usable(strategy_preset((i + k) % np))) return (i + k) % np;
  return -1;
}

int main(void) {
  plat_init();
  mutex_init(&g_hs_mx);
  g_cfg.auto_probe = 1;

  /* 1. what a site is */
  CHECK(site_is("a.blocked.example", "blocked.example"));
  CHECK(site_is("gateway-us-east1-b.discord.gg", "discord.gg"));
  CHECK(site_is("cdn.discordapp.com", "discordapp.com"));
  CHECK(site_is("discord.com", "discord.com"));
  CHECK(site_is("WWW.Example.COM.", "example.com"));
  CHECK(site_is("www.example.co.uk", "example.co.uk"));
  CHECK(site_is("x.y.example.com.tr", "example.com.tr"));
  CHECK(site_is("example.com.tr", "example.com.tr"));
  CHECK(site_is("a.b.example.ac.ir", "example.ac.ir"));
  CHECK(site_is("a.example.uk", "example.uk"));          /* "example" is no generic level */
  CHECK(site_is("fonts.googleapis.com", "googleapis.com"));
  CHECK(site_is("co.uk", NULL));                          /* a suffix is nobody's site */
  CHECK(site_is("com.tr", NULL));
  CHECK(site_is("x.github.io", NULL) && site_is("github.io", NULL));
  CHECK(site_is("a.b.storage.googleapis.com", NULL));
  CHECK(site_is("d1234.cloudfront.net", NULL) && site_is("x.y.akamaized.net", NULL));
  CHECK(site_is("evil-github.io", "evil-github.io"));     /* only a whole label matches */
  CHECK(site_is("127.0.0.1", NULL) && site_is("::1", NULL) && site_is("2001:db8::1", NULL));
  CHECK(site_is("localhost", NULL) && site_is("", NULL));
  /* second levels that are public suffixes: each name under them is its own */
  CHECK(site_is("www.ankara.bel.tr", "ankara.bel.tr") && site_is("izmir.bel.tr", "izmir.bel.tr"));
  CHECK(site_is("x.okul.k12.tr", "okul.k12.tr") && site_is("www.msb.mil.tr", "msb.mil.tr"));
  CHECK(site_is("a.trust.nhs.uk", "trust.nhs.uk") && site_is("www.nhs.uk", "www.nhs.uk"));
  CHECK(site_is("a.b.sch.uk", NULL) && site_is("www.school.lea.sch.uk", NULL));
  CHECK(site_is("www.example.gr.jp", "example.gr.jp") && site_is("x.example.ad.jp", "example.ad.jp"));
  CHECK(site_is("www.madrese.sch.ir", "madrese.sch.ir") && site_is("x.someone.id.ir", "someone.id.ir"));
  CHECK(site_is("www.shop.msk.ru", "shop.msk.ru") && site_is("x.example.uk.com", "example.uk.com"));
  CHECK(site_is("uk.com", NULL) && site_is("bel.tr", NULL));
  CHECK(site_is("www.ci.boston.ma.us", NULL) && site_is("example.us", "example.us"));
  CHECK(site_is("www.example.gob.mx", "example.gob.mx"));
  /* platforms whose customers are strangers to each other */
  const char *shared[] = { "tumblr.com", "wixsite.com", "myshopify.com", "substack.com", "gitlab.io",
                           "neocities.org", "itch.io", "run.app", "azureedge.net", "b-cdn.net", NULL };
  for (int i = 0; shared[i]; i++) {
    char a[128], b[128];
    snprintf(a, sizeof(a), "alice.%s", shared[i]); snprintf(b, sizeof(b), "www.bob.%s", shared[i]);
    CHECK(site_is(a, NULL) && site_is(b, NULL));
  }
  CHECK(site_is("x.blogspot.com.tr", NULL) && site_is("x.blogspot.de", NULL));
  /* and real sites that only look like those stay sites */
  CHECK(site_is("mail.web.de", "web.de") && site_is("www.ad.nl", "ad.nl"));
  CHECK(site_is("cdn.wixstatic.com", "wixstatic.com"));
  printf("  site of a name: OK\n");

  /* 2. learned: a name with nothing of its own takes its site's; its own wins */
  hs_put("a.blocked.example", 3);
  int inh = -1;
  CHECK(hs_get("a.blocked.example", &inh) == 3 && inh == 0);
  CHECK(hs_get("b.blocked.example", &inh) == 3 && inh == 1);
  CHECK(hs_get("blocked.example", &inh) == 3 && inh == 0);   /* the site's own name is the site */
  hs_put("c.blocked.example", 5);                             /* learned anew: the site follows */
  CHECK(hs_get("b.blocked.example", NULL) == 5);
  CHECK(hs_get("a.blocked.example", NULL) == 3);              /* but a's own stays */
  CHECK(hs_get("other.example", NULL) == -1);
  hs_put("x.github.io", 2);
  CHECK(hs_get("x.github.io", NULL) == 2 && hs_get("y.github.io", NULL) == -1);
  hs_put("10.1.2.3", 4);
  CHECK(hs_get("10.1.2.3", NULL) == 4 && hs_get("10.1.2.4", NULL) == -1);
  printf("  learned per name and per site, own wins: OK\n");

  /* 3. un-learning: from where it came */
  hs_unlearn("b.blocked.example", 1);                         /* inherited: the site entry goes */
  CHECK(hs_get("b.blocked.example", NULL) == -1);
  CHECK(hs_get("a.blocked.example", NULL) == 3 && hs_get("c.blocked.example", NULL) == 5);
  hs_unlearn("a.blocked.example", 0);                         /* its own */
  CHECK(hs_get("a.blocked.example", NULL) == -1);
  printf("  un-learning: OK\n");

  /* 4. where a ladder starts: a silent search resumes for its own name only
   *    (an outage of one name says nothing about the others); a resume point
   *    before a learned technique; something learned for any name of a site
   *    stops every name of it searching */
  rs_put("a.silent.example", 6);
  CHECK(start_of("a.silent.example") == 6 && start_of("b.silent.example") == -1);
  rs_put("b.silent.example", 9);
  CHECK(start_of("a.silent.example") == 6 && start_of("b.silent.example") == 9);
  CHECK(start_of("c.silent.example") == -1 && start_of("silent.example") == -1);
  rs_drop("c.silent.example");                                /* another name answered: no change */
  CHECK(start_of("a.silent.example") == 6 && start_of("b.silent.example") == 9);
  rs_drop("b.silent.example");                                /* answered: its own goes */
  CHECK(start_of("b.silent.example") == -1 && start_of("a.silent.example") == 6);
  rs_put("b.silent.example", 9);
  hs_put("a.silent.example", 1);
  CHECK(start_of("a.silent.example") == 101 && start_of("b.silent.example") == 201);
  hs_put("x.prec.example", 2);
  rs_put("y.prec.example", 5);             /* a sibling's search */
  CHECK(start_of("x.prec.example") == 102);                   /* its own technique wins */
  CHECK(start_of("y.prec.example") == 5);                     /* its own search */
  CHECK(start_of("z.prec.example") == 202);                   /* the site's technique, not y's search */
  hs_put("w.prec.example", 3);
  CHECK(start_of("z.prec.example") == 203 && start_of("y.prec.example") == 203);
  hs_put("m.own.example", 2);
  rs_put("m.own.example", 8);              /* its own technique came to nothing since */
  CHECK(start_of("m.own.example") == 8);
  rs_put("q.github.io", 7);
  CHECK(start_of("q.github.io") == 7 && start_of("r.github.io") == -1);
  { int f, l, i, st; ladder_start("q.github.io", 0, &f, &l, &i, &st); CHECK(f == -1); }   /* not TLS */
  /* an expired entry is no entry */
  rs_put("old.example", 4);
  { int i = rs_find("old.example"); CHECK(i >= 0); if (i >= 0) g_rs[i].t -= RS_TTL_MS + 1; }
  CHECK(start_of("old.example") == -1);
  /* one stored by another thread after this one read the clock is the newest
   * there is, not one that expired half a billion years ago */
  rs_put("future.example", 4);
  { int i = rs_find("future.example"); CHECK(i >= 0); if (i >= 0) g_rs[i].t = now_ms() + 5000; }
  CHECK(start_of("future.example") == 4 && start_of("future.example") == 4);
  CHECK(age_ms(1000, 2000) == 0 && age_ms(2000, 1000) == 1000);
  printf("  silent-ladder resume per name: OK\n");

  /* 4b. a technique learned long ago is due to be checked; a fresh one, or
   *     one confirmed since, is not; the site's ages with it */
  hs_put("a.aged.example", 2);
  CHECK(!stale_of("a.aged.example") && !stale_of("b.aged.example"));
  { int i;
    mutex_lock(&g_hs_mx);
    if ((i = hs_find("a.aged.example")) >= 0) g_hs[i].t -= HS_VERIFY_MS + 1;
    if ((i = hs_find("aged.example")) >= 0) g_hs[i].t -= HS_VERIFY_MS + 1;
    mutex_unlock(&g_hs_mx); }
  CHECK(stale_of("a.aged.example") && stale_of("b.aged.example"));
  CHECK(start_of("a.aged.example") == 102);                   /* still the technique to race */
  hs_put("a.aged.example", 2);                                /* confirmed */
  CHECK(!stale_of("a.aged.example") && !stale_of("b.aged.example"));
  printf("  learned techniques age: OK\n");

  /* 5. a cut moves the host on to the next technique that can work here,
   *    round the end of the list, and only the host, not its site */
  int np = strategy_preset_count();
  int last = -1;
  for (int i = 0; i < np; i++) if (preset_usable(strategy_preset(i))) last = i;
  CHECK(last >= 0);
  hs_put("cut.rotate.example", last);
  hs_on_cut("cut.rotate.example");
  int now = hs_get("cut.rotate.example", NULL);
  CHECK(now == next_usable(last) && preset_usable(strategy_preset(now)));
  CHECK(now == 0);                         /* past the last usable one: the first */
  CHECK(hs_get("other.rotate.example", NULL) == last);        /* the site did not move */
  if (!fake_available()) {
    /* The decoy is listed last and cannot be sent here: never cycled onto. */
    CHECK(!preset_usable(strategy_preset(np - 1)));
    hs_put("d.rotate2.example", np - 2);
    hs_on_cut("d.rotate2.example");
    CHECK(hs_get("d.rotate2.example", NULL) == 0);
  }
  hs_on_cut("fresh.rotate3.example");     /* nothing learned: the first technique */
  CHECK(hs_get("fresh.rotate3.example", NULL) == next_usable(-1));
  /* a cut is a guess, not the end of a silent search */
  rs_put("cut.keep.example", 5);
  hs_on_cut("cut.keep.example");
  CHECK(start_of("cut.keep.example") == 5);
  printf("  cut rotation skips what cannot work here, keeps a search: OK\n");

  /* 6. an unreachable host is told once a minute, even when another thread
   *    told it just after this one read the clock */
  {
    mutex_init(&g_unreach_mx);
    dial_info di; memset(&di, 0, sizeof(di)); di.resolved = 1; di.tried = 1;
    snprintf(g_unreach[0].host, sizeof(g_unreach[0].host), "%s", "twice.example");
    uint64_t later = now_ms() + 5000;
    g_unreach[0].t = later;
    report_unreachable("twice.example", 443, &di);
    CHECK(g_unreach[0].t == later);                          /* not told again */
  }
  printf("  unreachable told once: OK\n");

  /* 7. a host that came to nothing keeps fewer connections open for a while,
   *    for that name alone, until something answers for it */
  {
    mutex_init(&g_cool_mx);
    CHECK(!cool_is("dead.cool.example"));
    cool_put("dead.cool.example");
    CHECK(cool_is("dead.cool.example") && !cool_is("www.cool.example"));
    for (int i = 0; i < COOL_SLOTS; i++)
      if (strcmp(g_cool[i].host, "dead.cool.example") == 0) g_cool[i].t -= COOL_MS + 1;
    CHECK(!cool_is("dead.cool.example"));                    /* over after COOL_MS */
    cool_put("dead.cool.example");
    cool_drop("dead.cool.example");
    CHECK(!cool_is("dead.cool.example"));                    /* something answered */
    /* a full table makes room by forgetting the oldest */
    char h[64];
    for (int i = 0; i < COOL_SLOTS + 1; i++) { snprintf(h, sizeof(h), "h%d.cool.example", i); cool_put(h); }
    CHECK(cool_is(h));
  }
  printf("  cooling after nothing answered: OK\n");

  /* 8. the ladders' extra connections, all together, stop at EXTRA_LEGS_MAX */
  {
    int got = 0;
    for (int i = 0; i < EXTRA_LEGS_MAX + 10; i++) got += room_take();
    CHECK(got == EXTRA_LEGS_MAX && !room_take());
    room_give();
    CHECK(room_take() && !room_take());
    for (int i = 0; i < EXTRA_LEGS_MAX; i++) room_give();
    CHECK(atomic_load(&g_extra_legs) == 0);
    /* a set limited to LEG_COOL_MAX keeps the untouched request and the newest */
    legset L; memset(&L, 0, sizeof(L)); L.max = LEG_COOL_MAX;
    for (int i = 0; i < 4; i++) {
      leg g; memset(&g, 0, sizeof(g));
      g.s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); g.cand = i == 0 ? ATT_PLAIN : i; g.idx = i;
      g.room = i > 0 && room_take();
      legs_add(&L, g);
    }
    CHECK(L.n == 2 && L.l[0].cand == ATT_PLAIN && L.l[1].idx == 3);
    CHECK(atomic_load(&g_extra_legs) == 1);                  /* the dropped ones gave theirs back */
    leg t = legs_take(&L, 1);
    CHECK(t.room == 0 && atomic_load(&g_extra_legs) == 0);   /* relayed: no longer an extra one */
    sock_close(t.s);
    legs_close(&L);
  }
  printf("  extra connections capped: OK\n");

  /* 9. UDP relay: destinations it refuses, and the client endpoint a request
   *    names */
  {
    struct sockaddr_storage ss; memset(&ss, 0, sizeof(ss));
    struct sockaddr_in *s4 = (struct sockaddr_in *)&ss;
    s4->sin_family = AF_INET;
    uint32_t bad4[] = { 0x7f000001, 0x7f0000fe, 0x7fffffff, 0x00000000, 0x00010203 };
    for (size_t i = 0; i < sizeof(bad4) / 4; i++) { s4->sin_addr.s_addr = htonl(bad4[i]); CHECK(udp_dst_forbidden(&ss)); }
    uint32_t ok4[] = { 0x08080808, 0xc0a80101, 0x0a000001, 0x80000001, 0x01000000 };
    for (size_t i = 0; i < sizeof(ok4) / 4; i++) { s4->sin_addr.s_addr = htonl(ok4[i]); CHECK(!udp_dst_forbidden(&ss)); }
    struct sockaddr_in6 *s6 = (struct sockaddr_in6 *)&ss;
    memset(&ss, 0, sizeof(ss)); s6->sin6_family = AF_INET6;
    const char *bad6[] = { "::1", "::", "::ffff:127.0.0.1", "::ffff:0.0.0.0", "::ffff:127.9.9.9" };
    for (size_t i = 0; i < sizeof(bad6) / sizeof(*bad6); i++) { inet_pton(AF_INET6, bad6[i], &s6->sin6_addr); CHECK(udp_dst_forbidden(&ss)); }
    const char *ok6[] = { "2001:db8::1", "fe80::1", "::ffff:8.8.8.8", "::2", "fd00::1" };
    for (size_t i = 0; i < sizeof(ok6) / sizeof(*ok6); i++) { inet_pton(AF_INET6, ok6[i], &s6->sin6_addr); CHECK(!udp_dst_forbidden(&ss)); }
    ss.ss_family = 0; CHECK(udp_dst_forbidden(&ss));

    struct sockaddr_storage peer; memset(&peer, 0, sizeof(peer));
    ((struct sockaddr_in *)&peer)->sin_family = AF_INET;
    ((struct sockaddr_in *)&peer)->sin_addr.s_addr = htonl(0x7f000001);
    socks_req rq; struct sockaddr_in got;
    memset(&rq, 0, sizeof(rq)); rq.atyp = 1; rq.port = 4000;                   /* 0.0.0.0:4000 */
    CHECK(udp_request_endpoint(&rq, &peer, &got) && got.sin_addr.s_addr == htonl(0x7f000001) && ntohs(got.sin_port) == 4000);
    rq.addr[0] = 127; rq.addr[3] = 1;                                           /* 127.0.0.1:4000 */
    CHECK(udp_request_endpoint(&rq, &peer, &got) && ntohs(got.sin_port) == 4000);
    rq.addr[3] = 2;                                                             /* another address */
    CHECK(!udp_request_endpoint(&rq, &peer, &got));
    memset(rq.addr, 0, 16); rq.port = 0;                                        /* 0.0.0.0:0 */
    CHECK(!udp_request_endpoint(&rq, &peer, &got));
    rq.atyp = 4; rq.port = 5000;                                                /* [::]:5000 */
    CHECK(udp_request_endpoint(&rq, &peer, &got) && ntohs(got.sin_port) == 5000);
    inet_pton(AF_INET6, "::ffff:127.0.0.1", rq.addr);
    CHECK(udp_request_endpoint(&rq, &peer, &got) && ntohs(got.sin_port) == 5000);
    inet_pton(AF_INET6, "::1", rq.addr);
    CHECK(!udp_request_endpoint(&rq, &peer, &got));
    rq.atyp = 3; CHECK(!udp_request_endpoint(&rq, &peer, &got));               /* a name */
  }
  printf("  UDP relay destinations and client endpoint: OK\n");

  /* 10. the --auth-file and the comparison of what a client gives */
  {
    engine_config c; memset(&c, 0, sizeof(c));
    const char *path = "/tmp/shroudly_test_auth";
    struct { const char *body; int ok; const char *u, *p; } cases[] = {
      { "user:pa:ss\n", 1, "user", "pa:ss" },
      { "u:p", 1, "u", "p" },
      { "u:p\r\n", 1, "u", "p" },
      { ":p\n", 0, 0, 0 }, { "u:\n", 0, 0, 0 }, { "nocolon\n", 0, 0, 0 },
      { "u:p\nmore\n", 0, 0, 0 }, { "", 0, 0, 0 },
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(*cases); i++) {
      FILE *f = fopen(path, "wb"); fputs(cases[i].body, f); fclose(f);
      memset(&c, 0, sizeof(c));
      int r = engine_load_auth(&c, path);
      CHECK((r == 0) == cases[i].ok);
      if (cases[i].ok) CHECK(!strcmp(c.auth_user, cases[i].u) && !strcmp(c.auth_pass, cases[i].p));
    }
    char longu[300]; memset(longu, 'a', 256); strcpy(longu + 256, ":p");
    FILE *f = fopen(path, "wb"); fputs(longu, f); fclose(f);
    CHECK(engine_load_auth(&c, path) != 0);                      /* a 256-byte user */
    remove(path);
    CHECK(engine_load_auth(&c, path) != 0);                      /* no file */
    CHECK(same_secret((const uint8_t *)"secret", 6, "secret"));
    CHECK(!same_secret((const uint8_t *)"secreT", 6, "secret"));
    CHECK(!same_secret((const uint8_t *)"secret", 5, "secret"));
    CHECK(!same_secret((const uint8_t *)"secretx", 7, "secret"));
  }
  printf("  SOCKS5 authentication file and comparison: OK\n");

  /* 11. plain DNS the relay may send to the forwarder: which queries, and
   *     which resolvers are the LAN's */
  {
    uint8_t q[600]; size_t qe; int edns; char nm[256];
    /* "nas.lan" A, id 0x1234, RD */
    static const uint8_t base[] = { 0x12,0x34, 0x01,0x00, 0,1, 0,0, 0,0, 0,0,
      3,'n','a','s', 3,'l','a','n', 0, 0,1, 0,1 };
    memcpy(q, base, sizeof(base));
    CHECK(dns_query_parse(q, sizeof(base), nm, sizeof(nm), &qe, &edns) == 0 &&
          !strcmp(nm, "nas.lan") && qe == sizeof(base) && !edns);
    /* with an OPT record: EDNS */
    static const uint8_t opt[] = { 0, 0,41, 0x04,0xd0, 0,0,0,0, 0,0 };
    memcpy(q + sizeof(base), opt, sizeof(opt)); q[11] = 1;
    CHECK(dns_query_parse(q, sizeof(base) + sizeof(opt), nm, sizeof(nm), &qe, &edns) == 0 &&
          edns && qe == sizeof(base));
    CHECK(dns_query_parse(q, sizeof(base) + sizeof(opt) - 1, nm, sizeof(nm), &qe, &edns) != 0); /* cut short */
    q[11] = 0;
    /* QR set, another opcode, two questions, none: not a standard query */
    q[2] = 0x81; CHECK(dns_query_parse(q, sizeof(base), nm, sizeof(nm), &qe, &edns) != 0);
    q[2] = 0x01 | (5 << 3); CHECK(dns_query_parse(q, sizeof(base), nm, sizeof(nm), &qe, &edns) != 0);
    q[2] = 0x01; q[5] = 2; CHECK(dns_query_parse(q, sizeof(base), nm, sizeof(nm), &qe, &edns) != 0);
    q[5] = 0; CHECK(dns_query_parse(q, sizeof(base), nm, sizeof(nm), &qe, &edns) != 0);
    q[5] = 1;
    /* a label running past the end, a compression pointer in the question,
     * a dot inside a label */
    q[16] = 60; CHECK(dns_query_parse(q, sizeof(base), nm, sizeof(nm), &qe, &edns) != 0);
    q[16] = 3; q[12] = 0xc0; CHECK(dns_query_parse(q, sizeof(base), nm, sizeof(nm), &qe, &edns) != 0);
    q[12] = 3; q[14] = '.'; CHECK(dns_query_parse(q, sizeof(base), nm, sizeof(nm), &qe, &edns) != 0);
    q[14] = 'a';
    CHECK(dns_query_parse(q, 14, nm, sizeof(nm), &qe, &edns) != 0);
    /* the root */
    static const uint8_t root[] = { 0,1, 0,0, 0,1, 0,0, 0,0, 0,0, 0, 0,2, 0,1 };
    CHECK(dns_query_parse(root, sizeof(root), nm, sizeof(nm), &qe, &edns) == 0 && nm[0] == 0);

    struct sockaddr_storage ss; memset(&ss, 0, sizeof(ss));
    struct sockaddr_in *s4 = (struct sockaddr_in *)&ss; s4->sin_family = AF_INET;
    uint32_t lan[] = { 0x0a000001, 0xac100001, 0xac1fffff, 0xc0a80101, 0xa9fe0101, 0x64400001, 0x647fffff };
    for (size_t i = 0; i < sizeof(lan) / 4; i++) { s4->sin_addr.s_addr = htonl(lan[i]); CHECK(udp_dst_private(&ss)); }
    uint32_t wan[] = { 0x08080808, 0x01010101, 0xac200001, 0xac0fffff, 0x64800001, 0xc0a90101 };
    for (size_t i = 0; i < sizeof(wan) / 4; i++) { s4->sin_addr.s_addr = htonl(wan[i]); CHECK(!udp_dst_private(&ss)); }
    struct sockaddr_in6 *s6 = (struct sockaddr_in6 *)&ss;
    memset(&ss, 0, sizeof(ss)); s6->sin6_family = AF_INET6;
    const char *lan6[] = { "fd00::1", "fc12::1", "fe80::1", "febf::1", "::ffff:192.168.1.1" };
    for (size_t i = 0; i < sizeof(lan6) / sizeof(*lan6); i++) { inet_pton(AF_INET6, lan6[i], &s6->sin6_addr); CHECK(udp_dst_private(&ss)); }
    const char *wan6[] = { "2001:4860:4860::8888", "fec0::1", "::ffff:8.8.8.8" };
    for (size_t i = 0; i < sizeof(wan6) / sizeof(*wan6); i++) { inet_pton(AF_INET6, wan6[i], &s6->sin6_addr); CHECK(!udp_dst_private(&ss)); }
  }
  printf("  plain DNS for the forwarder: standard queries, EDNS, LAN resolvers: OK\n");

  /* 12. --fake-net ranges */
  {
    engine_config c; memset(&c, 0, sizeof(c));
    CHECK(engine_add_fake_net(&c, "198.18.0.0/15") == 0 && c.fake_net_n == 1);
    CHECK(engine_add_fake_net(&c, " fd00:1::/64 , 203.0.113.7") == 0 && c.fake_net_n == 3);
    CHECK(engine_add_fake_net(&c, "198.18.0.0/33") != 0);
    CHECK(engine_add_fake_net(&c, "198.18.0.0/") != 0);
    CHECK(engine_add_fake_net(&c, "nonsense/8") != 0);
    CHECK(engine_add_fake_net(&c, "") != 0);
    g_cfg = c;
    CHECK(host_in_fake_net("198.18.0.1") && host_in_fake_net("198.19.255.255"));
    CHECK(!host_in_fake_net("198.20.0.1") && !host_in_fake_net("198.17.255.255"));
    CHECK(host_in_fake_net("203.0.113.7") && !host_in_fake_net("203.0.113.8"));
    CHECK(host_in_fake_net("fd00:1::5") && !host_in_fake_net("fd00:2::5"));
    CHECK(host_in_fake_net("::ffff:198.18.3.4"));
    CHECK(!host_in_fake_net("example.com"));
    struct sockaddr_storage ss; memset(&ss, 0, sizeof(ss));
    struct sockaddr_in *s4 = (struct sockaddr_in *)&ss; s4->sin_family = AF_INET;
    s4->sin_addr.s_addr = htonl(0xc6120002); CHECK(sa_in_fake_net(&ss));
    s4->sin_addr.s_addr = htonl(0x08080808); CHECK(!sa_in_fake_net(&ss));
    memset(&c, 0, sizeof(c));
    for (int i = 0; i < ENGINE_FAKE_NET_MAX; i++) CHECK(engine_add_fake_net(&c, "10.0.0.0/8") == 0);
    CHECK(engine_add_fake_net(&c, "10.0.0.0/8") != 0);
    memset(&g_cfg, 0, sizeof(g_cfg));
    CHECK(!host_in_fake_net("198.18.0.1"));
  }
  printf("  stand-in address ranges: OK\n");

  /* 13. --watch: names the app hears about */
  {
    engine_config c; memset(&c, 0, sizeof(c));
    CHECK(engine_add_watch(&c, "Discord.Media.") == 0 && strcmp(c.watch[0], "discord.media") == 0);
    CHECK(engine_add_watch(&c, "media") != 0 && engine_add_watch(&c, ".x.com") != 0);
    CHECK(engine_add_watch(&c, "a b.com") != 0 && engine_add_watch(&c, "") != 0 && engine_add_watch(&c, NULL) != 0);
    g_cfg = c;
    memset(g_seen, 0, sizeof(g_seen));
    mutex_init(&g_seen_mx);
    CHECK(watched("discord.media") && watched("c-fra06-1a2b.discord.media") && watched("C-FRA06.Discord.Media"));
    CHECK(!watched("notdiscord.media") && !watched("discord.media.example") && !watched("media"));
    uint64_t t0 = 1000000;
    CHECK(watch_due("c-ist01-1.discord.media", t0) == 1);
    CHECK(watch_due("c-ist01-1.discord.media", t0 + 1000) == 0);          /* told once */
    CHECK(watch_due("C-IST01-1.discord.media", t0 + 2000) == 0);          /* whatever the case */
    CHECK(watch_due("c-ist01-2.discord.media", t0 + 2000) == 1);          /* another name: its own */
    CHECK(watch_due("discord.com", t0 + 2000) == 0);                      /* not watched */
    CHECK(watch_due("c-ist01-1.discord.media", t0 + ENGINE_WATCH_EVERY_MS) == 1);  /* again, later */
    for (int i = 0; i < WATCH_SLOTS + 5; i++) {                            /* bounded */
      char h[64]; snprintf(h, sizeof(h), "n%d.discord.media", i);
      CHECK(watch_due(h, t0 + 5000 + (uint64_t)i) == 1);
    }
    CHECK(watch_due("n0.discord.media", t0 + 6000) == 1);                 /* pushed out: told again */
    memset(&c, 0, sizeof(c));
    for (int i = 0; i < ENGINE_WATCH_MAX; i++) CHECK(engine_add_watch(&c, "x.example") == 0);
    CHECK(engine_add_watch(&c, "y.example") != 0);
    memset(&g_cfg, 0, sizeof(g_cfg));
    CHECK(watch_due("c-ist01-9.discord.media", t0) == 0);                 /* nothing watched */
  }
  printf("  watched names: OK\n");

  /* 14. A start is a fresh engine: what an earlier start in the same process
   * learned (the Android app restarts the engine in its own process) is
   * gone, as it was with a new process. */
  {
    engine_init_once();
    hs_put("forget.example", 1);
    rs_put("forget2.example", 2);
    cool_put("forget3.example");
    ok_put("forget4.example");
    struct sockaddr_storage w; memset(&w, 0, sizeof(w)); w.ss_family = AF_INET;
    winner_put("forget5.example", &w);
    CHECK(hs_get("forget.example", NULL) == 1 && cool_is("forget3.example") && ok_recent("forget4.example"));
    engine_forget();
    int from, learned, inh, stale;
    ladder_start("forget2.example", 1, &from, &learned, &inh, &stale);
    CHECK(hs_get("forget.example", NULL) == -1);
    CHECK(from == -1 && learned == -1);
    CHECK(!cool_is("forget3.example"));
    CHECK(!ok_recent("forget4.example"));
    struct sockaddr_storage out;
    CHECK(!winner_get("forget5.example", &out));
  }
  printf("  a new start forgets what the last one learned: OK\n");

  /* Two untouched failures of k, the second RAW_SECOND_FAIL_MS after the
   * first (what starts a search). */
  /* (defined as a macro so it can use the test's locals) */
#define PLAIN_TWICE(k, port, how) do { \
    raw_result((k), (port), ATT_PLAIN, 0, 0, (how), AF_INET, 0); \
    mutex_lock(&g_raw_mx); { int _i = raw_find(k); if (_i >= 0) g_raw[_i].first_fail -= RAW_SECOND_FAIL_MS; } mutex_unlock(&g_raw_mx); \
    raw_result((k), (port), ATT_PLAIN, 0, 0, (how), AF_INET, 0); } while (0)

  /* 15. streams that are not TLS or HTTP: a search across the app's own
   * connections, one technique per failed connection, learned when one is
   * answered, said once and rested when none is, never moved twice by
   * connections that went out together, and a neighbour's technique first. */
  {
    engine_init_once();
    engine_forget();
    FILE *out = tmpfile();
    engine_set_output(out);
    int inh = 0, n = raw_usable_count();
    CHECK(n >= 4 && strategy_raw_count() <= STRATEGY_MAX_RAW);
    for (int i = 0; i < strategy_raw_count(); i++)
      for (int k = 0; k < strategy_raw(i)->n_ops; k++) CHECK(strategy_raw(i)->ops[k].kind != OP_OOB);   /* never into an unknown stream */
    for (int i = 0; i < strategy_raw_count(); i++)
      CHECK(strncmp(strategy_raw(i)->name, "raw-", 4) == 0);
    /* untouched until something fails */
    CHECK(raw_pick("203.0.113.10", &inh) == ATT_PLAIN && !inh);
    /* answered untouched: nothing kept */
    raw_result("203.0.113.10", 443, ATT_PLAIN, 0, 1, 0, AF_INET, 0);
    mutex_lock(&g_raw_mx); CHECK(raw_find("203.0.113.10") < 0); mutex_unlock(&g_raw_mx);
    /* refused untouched once: nothing yet (a server restarting); a second
     * failure at the same moment (connections that went out together):
     * still nothing; a second one a moment later: the search starts */
    raw_result("203.0.113.10", 443, ATT_PLAIN, 0, 0, RAW_FAIL_REFUSED, AF_INET, 0);
    CHECK(raw_pick("203.0.113.10", &inh) == ATT_PLAIN);
    raw_result("203.0.113.10", 443, ATT_PLAIN, 0, 0, RAW_FAIL_REFUSED, AF_INET, 0);
    CHECK(raw_pick("203.0.113.10", &inh) == ATT_PLAIN);
    /* answered untouched in between: forgotten, counting starts over */
    raw_result("203.0.113.10", 443, ATT_PLAIN, 0, 1, 0, AF_INET, 0);
    mutex_lock(&g_raw_mx); CHECK(raw_find("203.0.113.10") < 0); mutex_unlock(&g_raw_mx);
    PLAIN_TWICE("203.0.113.10", 443, RAW_FAIL_REFUSED);
    int c1 = raw_pick("203.0.113.10", &inh);
    CHECK(c1 == ATT_RAW_BASE + raw_after(-1));
    /* a second untouched connection that went out together fails late: no move */
    raw_result("203.0.113.10", 443, ATT_PLAIN, 0, 0, RAW_FAIL_SILENT, AF_INET, 0);
    CHECK(raw_pick("203.0.113.10", &inh) == c1);
    /* the first technique fails: the next one */
    raw_result("203.0.113.10", 443, c1, 0, 0, RAW_FAIL_REFUSED, AF_INET, 0);
    int c2 = raw_pick("203.0.113.10", &inh);
    CHECK(c2 == ATT_RAW_BASE + raw_after(c1 - ATT_RAW_BASE));
    /* c1 failing again late moves nothing */
    raw_result("203.0.113.10", 443, c1, 0, 0, RAW_FAIL_REFUSED, AF_INET, 0);
    CHECK(raw_pick("203.0.113.10", &inh) == c2);
    /* c2 is answered: learned, and told (with no hold: nothing to look up) */
    long before = ftell(out);
    CHECK(raw_result("203.0.113.10", 443, c2, 0, 1, 0, AF_INET, 4321) == 0);
    CHECK(raw_pick("203.0.113.10", &inh) == c2 && !inh);
    char line[512] = {0};
    fflush(out); fseek(out, before, SEEK_SET);
    CHECK(fgets(line, sizeof(line), out) != NULL);
    CHECK(strstr(line, "\"type\":\"bypass\"") && strstr(line, "\"raw\":true") &&
          strstr(line, strategy_raw(c2 - ATT_RAW_BASE)->name) && strstr(line, "\"attempts\":4") &&
          strstr(line, "\"cport\":4321") && strstr(line, "\"port\":443"));
    fseek(out, 0, SEEK_END);
    /* a neighbour (same /24) starts with it; another /24 does not */
    CHECK(raw_pick("203.0.113.77", &inh) == c2 && inh);
    CHECK(raw_pick("203.0.114.77", &inh) == ATT_PLAIN && !inh);
    CHECK(raw_pick("2001:db8:1:2::5", &inh) == ATT_PLAIN);
    /* the neighbour's technique works there too: its own now */
    raw_result("203.0.113.77", 443, c2, 1, 1, 0, AF_INET, 0);
    mutex_lock(&g_raw_mx); { int i = raw_find("203.0.113.77"); CHECK(i >= 0 && g_raw[i].learned == c2 - ATT_RAW_BASE); } mutex_unlock(&g_raw_mx);
    /* a neighbour where it fails searches on its own from the next one */
    raw_result("203.0.113.78", 443, c2, 1, 0, RAW_FAIL_REFUSED, AF_INET, 0);
    CHECK(raw_pick("203.0.113.78", &inh) == ATT_RAW_BASE + raw_after(c2 - ATT_RAW_BASE) && !inh);
    /* nothing works anywhere: every technique once, then one line, then rest */
    const char *d = "198.51.100.9";
    PLAIN_TWICE(d, 5222, RAW_FAIL_SILENT);
    int seen[STRATEGY_MAX_RAW] = {0}, rounds = 0;
    for (;;) {
      int c = raw_pick(d, &inh);
      if (c == ATT_PLAIN) break;
      CHECK(c >= ATT_RAW_BASE && raw_usable(c - ATT_RAW_BASE));
      CHECK(!seen[c - ATT_RAW_BASE]);                       /* never the same one twice */
      seen[c - ATT_RAW_BASE] = 1;
      before = ftell(out);
      raw_result(d, 5222, c, 0, 0, RAW_FAIL_SILENT, AF_INET, 0);
      if (++rounds > STRATEGY_MAX_RAW + 1) break;
    }
    CHECK(rounds == n);                                     /* each usable one had its turn */
    /* the last one's result was told: a hold is wanted for a "blocked" line */
    fflush(out); fseek(out, before, SEEK_SET);
    memset(line, 0, sizeof(line));
    CHECK(fgets(line, sizeof(line), out) != NULL);
    CHECK(strstr(line, "\"type\":\"blocked\"") && strstr(line, "\"raw\":true") &&
          strstr(line, "\"note\":\"silent\"") && strstr(line, "198.51.100.9"));
    fseek(out, 0, SEEK_END);
    /* resting: untouched, and further failures move nothing and say nothing */
    before = ftell(out);
    raw_result(d, 5222, ATT_PLAIN, 0, 0, RAW_FAIL_SILENT, AF_INET, 0);
    CHECK(raw_pick(d, &inh) == ATT_PLAIN);
    fflush(out); CHECK(ftell(out) == before);
    /* after the rest, failures start a new round (two again) */
    mutex_lock(&g_raw_mx); { int i = raw_find(d); if (i >= 0) g_raw[i].rest_until = 0; } mutex_unlock(&g_raw_mx);
    raw_result(d, 5222, ATT_PLAIN, 0, 0, RAW_FAIL_REFUSED, AF_INET, 0);
    CHECK(raw_pick(d, &inh) == ATT_PLAIN);
    PLAIN_TWICE(d, 5222, RAW_FAIL_REFUSED);
    CHECK(raw_pick(d, &inh) >= ATT_RAW_BASE);
    /* what was learned stops working: unlearned, searched on from the next */
    raw_result("203.0.113.10", 443, c2, 0, 0, RAW_FAIL_REFUSED, AF_INET, 0);
    CHECK(raw_pick("203.0.113.10", &inh) == ATT_RAW_BASE + raw_after(c2 - ATT_RAW_BASE));
    /* now and then a learned technique is set aside for one untouched
     * connection: still needed (it fails) -> kept; not needed -> gone */
    {
      const char *r = "203.0.120.200";
      PLAIN_TWICE(r, 443, RAW_FAIL_REFUSED);
      int t1 = raw_pick(r, &inh);
      raw_result(r, 443, t1, 0, 1, 0, AF_INET, 0);
      CHECK(raw_pick(r, &inh) == t1);                       /* learned, used */
      mutex_lock(&g_raw_mx); { int i = raw_find(r); g_raw[i].checked -= RAW_RECHECK_MS; } mutex_unlock(&g_raw_mx);
      CHECK(raw_pick(r, &inh) == ATT_PLAIN);                /* the check */
      CHECK(raw_pick(r, &inh) == t1);                       /* only one */
      raw_result(r, 443, ATT_PLAIN, 0, 0, RAW_FAIL_REFUSED, AF_INET, 0);
      CHECK(raw_pick(r, &inh) == t1);                       /* still needed: kept, no new search */
      mutex_lock(&g_raw_mx); { int i = raw_find(r); g_raw[i].checked -= RAW_RECHECK_MS; } mutex_unlock(&g_raw_mx);
      CHECK(raw_pick(r, &inh) == ATT_PLAIN);
      raw_result(r, 443, ATT_PLAIN, 0, 1, 0, AF_INET, 0);   /* answered untouched */
      CHECK(raw_pick(r, &inh) == ATT_PLAIN);
      mutex_lock(&g_raw_mx); CHECK(raw_find(r) < 0); mutex_unlock(&g_raw_mx);
    }
    /* restored from an earlier run, by name (recently: no check yet);
     * unknown names refused */
    CHECK(engine_restore("149.154.167.50", strategy_raw(0)->name, 1000) == 0);
    CHECK(raw_pick("149.154.167.50", &inh) == ATT_RAW_BASE + 0 && !inh);
    CHECK(engine_restore("149.154.167.60", strategy_raw(0)->name, RAW_RECHECK_MS + 1000) == 0);
    CHECK(raw_pick("149.154.167.60", &inh) == ATT_PLAIN);  /* learned long ago: checked first */
    CHECK(engine_restore("149.154.167.51", "raw-nonesuch", 0) == -1);
    CHECK(engine_restore("bad host", strategy_raw(0)->name, 0) == -1);
    CHECK(engine_restore("149.154.167.52", strategy_preset(0)->name, 0) == -1);   /* TLS ones: names only */
    /* addresses on this computer or its network are never told unreachable */
    dial_info di; memset(&di, 0, sizeof(di)); di.resolved = 1; di.tried = 1;
    CHECK(report_raw_unreachable("127.0.0.1", 9000, &di, 0) == 0);
    CHECK(report_raw_unreachable("192.168.1.20", 9000, &di, 0) == 0);
    CHECK(report_raw_unreachable("fe80::1", 9000, &di, 0) == 0);
    CHECK(report_raw_unreachable("239.1.2.3", 9000, &di, 0) == 0);
    CHECK(report_raw_unreachable("www.example.com", 443, &di, 0) == 0);    /* report_unreachable's */
    CHECK(report_raw_unreachable("149.154.175.50", 443, &di, 0) == 1);
    CHECK(report_raw_unreachable("149.154.175.50", 443, &di, 0) == 0);     /* once in a while */
    /* not the network's doing: no route from here, or the name did not resolve */
    { dial_info nr = di; nr.noroute = 1; CHECK(report_raw_unreachable("149.154.175.51", 443, &nr, 0) == 0); }
    { dial_info dn = di; dn.resolved = 0; dn.tried = 0; CHECK(report_raw_unreachable("mqtt2.example.com", 8883, &dn, 0) == 0); }
    /* an address whose neighbour (same /24) took a connection lately */
    { struct sockaddr_storage ss; memset(&ss, 0, sizeof(ss)); ss.ss_family = AF_INET;
      inet_pton(AF_INET, "149.154.170.9", &((struct sockaddr_in *)&ss)->sin_addr);
      raw_seen_put(&ss);
      CHECK(report_raw_unreachable("149.154.170.20", 443, &di, 0) == 0);
      CHECK(report_raw_unreachable("149.154.171.20", 443, &di, 0) == 1); }
    /* names only this computer's DNS knows: what the system says for them */
    CHECK(osdns_classify("localhost") == 2);               /* loopback: followed only if public DNS has nothing */
    CHECK(osdns_classify("no-such-name.invalid") == 3);    /* nothing: public DNS as usual */
    CHECK(osdns_follow("127.0.0.1") == 0);                 /* an address: nothing to decide */
    /* has_route: loopback yes */
    { struct sockaddr_storage ss; memset(&ss, 0, sizeof(ss)); ss.ss_family = AF_INET;
      ((struct sockaddr_in *)&ss)->sin_port = htons(9); inet_pton(AF_INET, "127.0.0.1", &((struct sockaddr_in *)&ss)->sin_addr);
      CHECK(has_route(&ss)); }
    CHECK(report_raw_unreachable("mqtt.example.com", 8883, &di, 0) == 1);
    int told = 0;
    char hb[64];
    for (int i = 0; i < 100; i++) { snprintf(hb, sizeof(hb), "198.51.100.%d", i); told += report_raw_unreachable(hb, 6881, &di, 0); }
    CHECK(told == RAW_UNREACH_BURST - 3);                   /* a burst is capped */
    engine_forget();
    CHECK(raw_pick("149.154.167.50", &inh) == ATT_PLAIN);
    engine_set_output(stdout);
    fclose(out);
  }
  printf("  streams that are not TLS or HTTP: searched, learned, told, rested: OK\n");

  if (fails == 0) { printf("ENGINE MEMORY TESTS PASSED\n"); return 0; }
  printf("%d FAILED\n", fails);
  return 1;
}
