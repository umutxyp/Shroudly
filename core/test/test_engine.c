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

  if (fails == 0) { printf("ENGINE MEMORY TESTS PASSED\n"); return 0; }
  printf("%d FAILED\n", fails);
  return 1;
}
