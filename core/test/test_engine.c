/* White-box test of the engine's per-host memory, by including engine.c:
 * which names make one site, what a name takes from its site and when, where
 * a silent ladder resumes, and where a cut moves a host on to. */
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
  int from, learned, inh;
  ladder_start(h, 1, &from, &learned, &inh);
  return from >= 0 ? from : learned >= 0 ? (inh ? 200 : 100) + learned : -1;
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

  /* 4. where a ladder starts: a silent search resumes per name and per site;
   *    a name's own entries first, a resume point before a learned technique;
   *    of the site's, the newer; something learned for any name of a site
   *    stops every name of it searching */
  rs_put("a.silent.example", 6);
  CHECK(start_of("a.silent.example") == 6 && start_of("b.silent.example") == 6);
  rs_put("b.silent.example", 9);
  CHECK(start_of("a.silent.example") == 6 && start_of("c.silent.example") == 9);
  rs_drop("c.silent.example");                                /* answered: the site's goes */
  CHECK(start_of("c.silent.example") == -1 && start_of("a.silent.example") == 6);
  hs_put("a.silent.example", 1);
  CHECK(start_of("a.silent.example") == 101 && start_of("b.silent.example") == 201);
  hs_put("x.prec.example", 2);
  rs_put("y.prec.example", 5);             /* a sibling's search, newer than the site's technique */
  CHECK(start_of("x.prec.example") == 102);                   /* its own technique wins */
  CHECK(start_of("z.prec.example") == 5);                     /* the site's newer word */
  hs_put("w.prec.example", 3);
  CHECK(start_of("z.prec.example") == 203 && start_of("y.prec.example") == 203);
  hs_put("m.own.example", 2);
  rs_put("m.own.example", 8);              /* its own technique came to nothing since */
  CHECK(start_of("m.own.example") == 8);
  rs_put("q.github.io", 7);
  CHECK(start_of("q.github.io") == 7 && start_of("r.github.io") == -1);
  { int f, l, i; ladder_start("q.github.io", 0, &f, &l, &i); CHECK(f == -1); }   /* not TLS */
  /* an expired entry is no entry */
  rs_put("old.example", 4);
  { int i = rs_find("old.example"); CHECK(i >= 0); if (i >= 0) g_rs[i].t -= RS_TTL_MS + 1; }
  CHECK(start_of("old.example") == -1);
  printf("  silent-ladder resume per name and site: OK\n");

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
  printf("  cut rotation skips what cannot work here: OK\n");

  if (fails == 0) { printf("ENGINE MEMORY TESTS PASSED\n"); return 0; }
  printf("%d FAILED\n", fails);
  return 1;
}
