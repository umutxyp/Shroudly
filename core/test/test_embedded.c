/* The engine run inside another program's process (engine_main with
 * embedded = 1, as the Android app runs it): commands from one pipe, JSON
 * lines to another, no signal handlers, a run that returns when told to
 * stop (STOP, or the end of the command pipe), its port free again at once,
 * a second run in the same process on the same port, and nothing written to
 * a stream after its run has ended. POSIX only. */
#include "../src/engine.h"

#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int fails = 0;
#define CHECK(c) do{ if(!(c)){ printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #c); fails++; } }while(0)

typedef struct {
  int argc;
  char **argv;
  FILE *in, *out;
  int rc;
} run_arg;

static void *runner(void *p) {
  run_arg *r = (run_arg *)p;
  r->rc = engine_main(r->argc, r->argv, r->in, r->out, 1);
  return NULL;
}

/* One line from f, waiting at most ~5 s; "" on timeout or end. */
static void read_line(int fd, char *buf, size_t cap) {
  size_t n = 0;
  buf[0] = 0;
  for (int waited = 0; n + 1 < cap && waited < 5000;) {
    struct pollfd p = { fd, POLLIN, 0 };
    if (poll(&p, 1, 100) <= 0) { waited += 100; continue; }
    char c;
    ssize_t k = read(fd, &c, 1);
    if (k <= 0) break;
    if (c == '\n') break;
    buf[n++] = c;
  }
  buf[n] = 0;
}

static int connect_ok(int port) {
  sock_t s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  struct sockaddr_in a;
  memset(&a, 0, sizeof(a));
  a.sin_family = AF_INET;
  a.sin_port = htons((uint16_t)port);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int ok = connect(s, (struct sockaddr *)&a, sizeof(a)) == 0;
  sock_close(s);
  return ok;
}

static int free_port(void) {
  sock_t s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  struct sockaddr_in a;
  memset(&a, 0, sizeof(a));
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  bind(s, (struct sockaddr *)&a, sizeof(a));
  socklen_t l = sizeof(a);
  getsockname(s, (struct sockaddr *)&a, &l);
  sock_close(s);
  return ntohs(a.sin_port);
}

/* Starts a run on port; fills cmd (to write commands) and ev (to read lines). */
static void start_run(pthread_t *th, run_arg *ra, char **argv, int argc, int *cmd_w, int *ev_r) {
  int cmd[2], ev[2];
  CHECK(pipe(cmd) == 0 && pipe(ev) == 0);
  ra->argc = argc;
  ra->argv = argv;
  ra->in = fdopen(cmd[0], "r");
  ra->out = fdopen(ev[1], "w");
  ra->rc = -99;
  *cmd_w = cmd[1];
  *ev_r = ev[0];
  CHECK(pthread_create(th, NULL, runner, ra) == 0);
}

/* What the JNI side does once a run has returned (engine_jni.c). */
static void end_run(run_arg *ra) {
  engine_output_off();
  fclose(ra->out);
  fclose(ra->in);
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  int port = free_port();
  char ps[16];
  snprintf(ps, sizeof(ps), "%d", port);
  char auth[] = "/tmp/shroudly_test_embedded_auth";
  FILE *af = fopen(auth, "w");
  fputs("user1:pass1\n", af);
  fclose(af);
  char *argv[] = { "shroudly-core", "--listen", "127.0.0.1", "--port", ps, "--auto",
                   "--fake-net", "198.18.0.0/15", "--auth-file", auth, NULL };
  int argc = 10;
  char line[512], want[128];

  /* 1. A run: the ready line on its own stream, STATS answered, STOP returns. */
  void (*before_term)(int) = signal(SIGTERM, SIG_DFL);
  pthread_t th;
  run_arg ra;
  int cmd_w, ev_r;
  start_run(&th, &ra, argv, argc, &cmd_w, &ev_r);
  read_line(ev_r, line, sizeof(line));
  snprintf(want, sizeof(want), "{\"type\":\"ready\",\"port\":%d,", port);
  CHECK(strncmp(line, want, strlen(want)) == 0);
  CHECK(connect_ok(port));
  CHECK(write(cmd_w, "STATS\n", 6) == 6);
  read_line(ev_r, line, sizeof(line));
  CHECK(strncmp(line, "{\"type\":\"stats\",", 16) == 0);
  /* No signal handler of its own in another program's process. */
  void (*now_term)(int) = signal(SIGTERM, SIG_DFL);
  CHECK(now_term == SIG_DFL);
  CHECK(write(cmd_w, "STOP\n", 5) == 5);
  read_line(ev_r, line, sizeof(line));
  CHECK(strcmp(line, "{\"type\":\"stopped\"}") == 0);
  pthread_join(th, NULL);
  CHECK(ra.rc == 0);
  end_run(&ra);
  /* The port is free again once the run has returned. */
  sleep_ms(100);
  CHECK(!connect_ok(port));
  /* After the run, nothing reaches a stream (it is closed). */
  engine_printf("{\"type\":\"late\"}\n");
  close(cmd_w);
  char c;
  CHECK(read(ev_r, &c, 1) == 0);
  close(ev_r);
  remove(auth);
  printf("  a run: ready, STATS, STOP, no signal handlers, port freed: OK\n");

  /* 2. A second run in the same process, on the same port at once, without
   * the first one's password option: it takes no password (nothing of the
   * first run's options is left behind). It ends when its command pipe is
   * closed. */
  start_run(&th, &ra, argv, argc - 2, &cmd_w, &ev_r);
  read_line(ev_r, line, sizeof(line));
  CHECK(strncmp(line, want, strlen(want)) == 0);
  CHECK(connect_ok(port));
  {
    sock_t s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons((uint16_t)port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    unsigned char hello[3] = { 5, 1, 0 }, reply[2] = { 0, 0 };
    CHECK(connect(s, (struct sockaddr *)&a, sizeof(a)) == 0);
    CHECK(send(s, hello, 3, 0) == 3);
    sock_set_timeouts(s, 3000);
    CHECK(recv(s, reply, 2, MSG_WAITALL) == 2);
    CHECK(reply[0] == 5 && reply[1] == 0);
    sock_close(s);
  }
  close(cmd_w);
  read_line(ev_r, line, sizeof(line));
  CHECK(strcmp(line, "{\"type\":\"stopped\"}") == 0);
  pthread_join(th, NULL);
  CHECK(ra.rc == 0);
  end_run(&ra);
  close(ev_r);
  printf("  a second run on the same port, options anew, ended by the end of its commands: OK\n");

  /* 3. A run whose options are refused returns at once with the program's
   * exit code, and says why on its stream. */
  char *bad[] = { "shroudly-core", "--port", ps, "--fake-net", "nonsense", NULL };
  start_run(&th, &ra, bad, 5, &cmd_w, &ev_r);
  read_line(ev_r, line, sizeof(line));
  CHECK(strcmp(line, "{\"type\":\"error\",\"msg\":\"fake-net unusable\"}") == 0);
  pthread_join(th, NULL);
  CHECK(ra.rc == 2);
  end_run(&ra);
  close(cmd_w);
  close(ev_r);
  printf("  refused options: exit code 2, the reason on its stream: OK\n");

  signal(SIGTERM, before_term);
  if (fails == 0) { printf("EMBEDDED ENGINE TESTS PASSED\n"); return 0; }
  printf("%d FAILED\n", fails);
  return 1;
}
