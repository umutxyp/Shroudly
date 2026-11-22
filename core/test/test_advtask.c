/* The request the app leaves for the Advanced engine started by its task
 * (advtask.h): an engine with administrator rights reads it from a folder
 * of the user's, so only exactly what the app writes is taken, and anything
 * else is refused whole. Pure: runs on any system; the task itself runs in
 * the Windows lab (tests/lab/advanced-windows.js). */
#include "../src/advtask.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fails = 0;
#define CHECK(c) do { if (!(c)) { printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #c); fails++; } } while (0)

#define ID "0123456789abcdef0123456789abcdef"
#define HEAD "shroudly-advanced 1\nid " ID "\n"

static char buf[ADVTASK_REQ_MAX + 64];
static char *argv[ADVTASK_MAX_ARGS];
static char id[ADVTASK_ID_LEN + 1];
static int un;

static int parse(const char *text) {
  size_t n = strlen(text);
  memset(buf, 'x', sizeof(buf));
  memcpy(buf, text, n);
  memset(argv, 0, sizeof(argv));
  return advtask_parse(buf, n, id, argv, ADVTASK_MAX_ARGS, &un);
}

static int parse_n(const char *text, size_t n) {
  memset(buf, 'x', sizeof(buf));
  memcpy(buf, text, n);
  return advtask_parse(buf, n, id, argv, ADVTASK_MAX_ARGS, &un);
}

static void test_accepts(void) {
  /* What electron/advanced-mode.js writes: every option of buildArgs. */
  int n = parse(HEAD "--advanced\n--fake-ttl\n4\n--parent-pid\n4242\n--drop-rst\n1\n--autottl\n1\n--seqovl\n0\n"
                "--split\non\n--desync-mode\nfake\n--tlsrec\n1\n--keep-driver\n1\n--no-quic-block\n--no-udp-fake\n"
                "--fake-repeats\n6\n--dns-gate\n56148\n--decoy-name\nwww.turkiye.gov.tr\n--decoy-name\ne-devlet.example\n");
  CHECK(n == 29);
  CHECK(!un && !strcmp(id, ID));
  CHECK(n == 29 && !strcmp(argv[0], "--advanced") && !strcmp(argv[1], "--fake-ttl") && !strcmp(argv[2], "4"));
  CHECK(n == 29 && !strcmp(argv[3], "--parent-pid") && !strcmp(argv[4], "4242"));
  CHECK(n == 29 && !strcmp(argv[27], "--decoy-name") && !strcmp(argv[28], "e-devlet.example"));
  /* Windows line ends, and no line end after the last one. */
  n = parse("shroudly-advanced 1\r\nid " ID "\r\n--parent-pid\r\n77\r\n--split\r\ndisorder");
  CHECK(n == 4 && !strcmp(argv[1], "77") && !strcmp(argv[3], "disorder"));
  /* The least there is: who to end with. */
  CHECK(parse(HEAD "--parent-pid\n1\n") == 2);
}

static void test_uninstall(void) {
  CHECK(parse("shroudly-advanced 1\nuninstall\n") == 0 && un == 1);
  CHECK(parse("shroudly-advanced 1\r\nuninstall") == 0 && un == 1);
  /* Nothing may follow it. */
  CHECK(parse("shroudly-advanced 1\nuninstall\n--parent-pid\n1\n") == -1);
}

static void test_refuses(void) {
  /* Not a request at all. */
  CHECK(parse("") == -1);
  CHECK(parse("\n") == -1);
  CHECK(parse("shroudly-advanced 1\n") == -1);
  CHECK(parse("shroudly-advanced 2\nid " ID "\n--parent-pid\n1\n") == -1);
  CHECK(parse("id " ID "\n--parent-pid\n1\n") == -1);
  /* The id: 32 lower-case hex digits, nothing else (it names files). */
  CHECK(parse("shroudly-advanced 1\nid 0123456789abcdef0123456789abcde\n--parent-pid\n1\n") == -1);
  CHECK(parse("shroudly-advanced 1\nid 0123456789abcdef0123456789abcdef0\n--parent-pid\n1\n") == -1);
  CHECK(parse("shroudly-advanced 1\nid 0123456789ABCDEF0123456789abcdef\n--parent-pid\n1\n") == -1);
  CHECK(parse("shroudly-advanced 1\nid ..\\..\\..\\Windows\\System32\\x.dll\n--parent-pid\n1\n") == -1);
  CHECK(parse("shroudly-advanced 1\nid 0123456789abcdef/123456789abcdef0\n--parent-pid\n1\n") == -1);
  /* No parent: an engine that would never end. */
  CHECK(parse(HEAD "--fake-ttl\n4\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n0\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n000\n") == -1);
  /* Nothing that names a file, and nothing the engine has besides. */
  CHECK(parse(HEAD "--parent-pid\n1\n--status-file\nC:\\Windows\\win.ini\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1\n--control-base\nC:\\x\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1\n--from-task\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1\n--auth-file\nx\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1\n--adblock\nx\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1\n--task-install\nsomeone\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1\n--listen\n0.0.0.0\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1\nanything\n") == -1);
  /* Values: numbers are digits, words lower-case letters, names host names. */
  CHECK(parse(HEAD "--parent-pid\n-1\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1 2\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n12345678901\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1\n--fake-ttl\n0x4\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1\n--split\n../x\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1\n--split\nON\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1\n--decoy-name\nC:\\x\\y\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1\n--decoy-name\n-x.example\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1\n--decoy-name\nab\n") == -1);
  /* A value that is missing, and an option where a value belongs. */
  CHECK(parse(HEAD "--parent-pid\n1\n--fake-ttl\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n--fake-ttl\n4\n") == -1);
  /* An empty line in the middle, a tab, a NUL, a byte that is not ASCII. */
  CHECK(parse(HEAD "--parent-pid\n1\n\n--tlsrec\n1\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1\n--tlsrec\t1\n") == -1);
  CHECK(parse(HEAD "--parent-pid\n1\n--decoy-name\nb\xc3\xbcy\xc3\xbck.example\n") == -1);
  CHECK(parse(HEAD "--parent-pid\r1\n") == -1);
  {
    const char t[] = HEAD "--parent-pid\n1\n--tlsrec\n1\0--status-file\nx\n";
    CHECK(parse_n(t, sizeof(t) - 1) == -1);
  }
  /* Too many arguments, and too long a text. */
  {
    static char big[ADVTASK_REQ_MAX + 64];
    strcpy(big, HEAD "--parent-pid\n1\n");
    for (int i = 0; i < ADVTASK_MAX_ARGS; i++) strcat(big, "--advanced\n");
    CHECK(parse(big) == -1);
    strcpy(big, HEAD "--parent-pid\n1\n");
    for (int i = 0; i < ADVTASK_MAX_ARGS - 2; i++) strcat(big, "--advanced\n");
    CHECK(parse(big) == ADVTASK_MAX_ARGS);
    memset(big, 0, sizeof(big));
    strcpy(big, HEAD "--parent-pid\n1\n");
    size_t at = strlen(big);
    while (at + 40 < ADVTASK_REQ_MAX + 20) { memcpy(big + at, "--decoy-name\nwww.example.com\n", 29); at += 29; }
    CHECK(advtask_parse(big, at, id, argv, ADVTASK_MAX_ARGS, &un) == -1);
  }
  /* Nothing to write into. */
  CHECK(advtask_parse(NULL, 4, id, argv, ADVTASK_MAX_ARGS, &un) == -1);
}

int main(void) {
  test_accepts();
  test_uninstall();
  test_refuses();
  if (fails) { printf("advtask: %d FAILED\n", fails); return 1; }
  printf("advtask: the request an elevated engine reads is taken only when it is exactly the app's: OK\n");
  return 0;
}
