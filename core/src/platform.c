#include "platform.h"
#include <string.h>
#include <stdlib.h>

#ifndef _WIN32
  #include <fcntl.h>
  #include <signal.h>
  #include <time.h>
  #include <sys/ioctl.h>
  #ifdef __linux__
    #include <linux/sockios.h>
  #endif
#endif

int plat_init(void) {
#ifdef _WIN32
  WSADATA wsa;
  return WSAStartup(MAKEWORD(2, 2), &wsa) == 0 ? 0 : -1;
#else
  signal(SIGPIPE, SIG_IGN);
  return 0;
#endif
}

void plat_cleanup(void) {
#ifdef _WIN32
  WSACleanup();
#endif
}

void sock_close(sock_t s) {
  if (s == SOCK_INVALID) return;
#ifdef _WIN32
  closesocket(s);
#else
  close(s);
#endif
}

int sock_set_nodelay(sock_t s, int on) {
  int v = on ? 1 : 0;
  return setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char *)&v, sizeof(v));
}

int sock_set_keepalive(sock_t s) {
  int v = 1;
  return setsockopt(s, SOL_SOCKET, SO_KEEPALIVE, (const char *)&v, sizeof(v));
}

int sock_set_nonblock(sock_t s, int on) {
#ifdef _WIN32
  u_long m = on ? 1 : 0;
  return ioctlsocket(s, FIONBIO, &m);
#else
  int fl = fcntl(s, F_GETFL, 0);
  if (fl < 0) return -1;
  fl = on ? (fl | O_NONBLOCK) : (fl & ~O_NONBLOCK);
  return fcntl(s, F_SETFL, fl);
#endif
}

int sock_set_timeouts(sock_t s, int ms) {
#ifdef _WIN32
  DWORD t = (DWORD)ms;
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char *)&t, sizeof(t));
  return setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char *)&t, sizeof(t));
#else
  struct timeval tv;
  tv.tv_sec = ms / 1000;
  tv.tv_usec = (ms % 1000) * 1000;
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  return setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#endif
}

int sock_get_ttl(sock_t s, int family) {
  int v = 0;
#ifdef _WIN32
  int len = sizeof(v);
#else
  socklen_t len = sizeof(v);
#endif
  int r;
  if (family == AF_INET6)
    r = getsockopt(s, IPPROTO_IPV6, IPV6_UNICAST_HOPS, (char *)&v, &len);
  else
    r = getsockopt(s, IPPROTO_IP, IP_TTL, (char *)&v, &len);
  if (r != 0 || v <= 0 || v > 255) return 64;
  return v;
}

int sock_set_ttl(sock_t s, int family, int ttl) {
  int v = ttl;
  if (family == AF_INET6)
    return setsockopt(s, IPPROTO_IPV6, IPV6_UNICAST_HOPS, (const char *)&v, sizeof(v));
  return setsockopt(s, IPPROTO_IP, IP_TTL, (const char *)&v, sizeof(v));
}

void sock_wait_sent(sock_t s, int max_ms) {
#if defined(__linux__) && defined(SIOCOUTQNSD)
  /* Linux: wait until the not-yet-sent queue is empty so that each send()
   * leaves as its own segment (defeats autocorking/coalescing). TCP_NODELAY is
   * already set on the socket; draining SIOCOUTQNSD guarantees the bytes are on
   * the wire before the next chunk is written, so they cannot be coalesced. */
  uint64_t deadline = now_ms() + (uint64_t)max_ms;
  for (;;) {
    int pending = 0;
    if (ioctl(s, SIOCOUTQNSD, &pending) != 0) break;
    if (pending <= 0) break;
    if (now_ms() >= deadline) break;
    struct timespec ts = {0, 150000}; /* 0.15 ms */
    nanosleep(&ts, NULL);
  }
  /* A final tiny yield so the next send() starts a fresh segment even if the
   * NIC/driver briefly held the queue. */
  { struct timespec ts = {0, 300000}; nanosleep(&ts, NULL); }
#elif defined(__APPLE__)
  /* macOS has no SIOCOUTQNSD. With TCP_NODELAY set, a short sleep lets the
   * pending small segment leave before the next write, which is enough to keep
   * the SNI split across segments in practice. */
  (void)max_ms;
  struct timespec ts = {0, 1500000}; /* 1.5 ms */
  nanosleep(&ts, NULL);
#else
  /* Windows: TCP_NODELAY prevents Nagle coalescing of small writes; a brief
   * sleep ensures the previous segment is handed to the stack first. */
  (void)s;
  (void)max_ms;
  sleep_ms(2);
#endif
}

int sock_connect_timeout(sock_t s, const struct sockaddr *sa, int salen, int timeout_ms) {
  if (sock_set_nonblock(s, 1) != 0) return -1;
  int r = connect(s, sa, salen);
  if (r != 0) {
    int e = sock_errno();
#ifdef _WIN32
    if (e != WSAEWOULDBLOCK && e != WSAEINPROGRESS) { sock_set_nonblock(s, 0); return -1; }
#else
    if (e != EINPROGRESS) { sock_set_nonblock(s, 0); return -1; }
#endif
#ifdef _WIN32
    WSAPOLLFD p;
    p.fd = s; p.events = POLLWRNORM; p.revents = 0;
    r = WSAPoll(&p, 1, timeout_ms);
#else
    struct pollfd p;
    p.fd = s; p.events = POLLOUT; p.revents = 0;
    do { r = poll(&p, 1, timeout_ms); } while (r < 0 && errno == EINTR);
#endif
    if (r <= 0) { sock_set_nonblock(s, 0); return -1; }
    int err = 0;
#ifdef _WIN32
    int len = sizeof(err);
#else
    socklen_t len = sizeof(err);
#endif
    if (getsockopt(s, SOL_SOCKET, SO_ERROR, (char *)&err, &len) != 0 || err != 0) {
      sock_set_nonblock(s, 0);
      return -1;
    }
  }
  sock_set_nonblock(s, 0);
  return 0;
}

int sock_send_all(sock_t s, const uint8_t *buf, size_t len, int flags) {
  size_t off = 0;
  while (off < len) {
    size_t chunk = len - off;
    if (chunk > 0x40000000) chunk = 0x40000000;
#ifdef _WIN32
    int n = send(s, (const char *)buf + off, (int)chunk, flags);
#else
  #ifdef MSG_NOSIGNAL
    int n = (int)send(s, buf + off, chunk, flags | MSG_NOSIGNAL);
  #else
    int n = (int)send(s, buf + off, chunk, flags);
  #endif
#endif
    if (n < 0) {
      if (sock_errno() == SE_INTR) continue;
      return -1;
    }
    if (n == 0) return -1;
    off += (size_t)n;
  }
  return 0;
}

int sock_wait_readable(sock_t s, int timeout_ms) {
#ifdef _WIN32
  WSAPOLLFD p;
  p.fd = s; p.events = POLLRDNORM; p.revents = 0;
  int r = WSAPoll(&p, 1, timeout_ms);
  if (r < 0) return -1;
  if (r == 0) return 0;
  return 1;
#else
  struct pollfd p;
  p.fd = s; p.events = POLLIN; p.revents = 0;
  int r;
  do { r = poll(&p, 1, timeout_ms); } while (r < 0 && errno == EINTR);
  if (r < 0) return -1;
  if (r == 0) return 0;
  return 1;
#endif
}

int sock_wait_either(sock_t a, sock_t b, int timeout_ms) {
#ifdef _WIN32
  WSAPOLLFD p[2];
  p[0].fd = a; p[0].events = POLLRDNORM; p[0].revents = 0;
  p[1].fd = b; p[1].events = POLLRDNORM; p[1].revents = 0;
  int r = WSAPoll(p, 2, timeout_ms);
#else
  struct pollfd p[2];
  p[0].fd = a; p[0].events = POLLIN; p[0].revents = 0;
  p[1].fd = b; p[1].events = POLLIN; p[1].revents = 0;
  int r;
  do { r = poll(p, 2, timeout_ms); } while (r < 0 && errno == EINTR);
#endif
  if (r < 0) return -1;
  if (r == 0) return 0;
  int mask = 0;
  if (p[0].revents) mask |= 1;
  if (p[1].revents) mask |= 2;
  return mask;
}

/* ── threads ───────────────────────────────────────────────────────────── */

#ifdef _WIN32
typedef struct { thread_fn fn; void *arg; } win_tramp_t;
static DWORD WINAPI win_tramp(LPVOID p) {
  win_tramp_t t = *(win_tramp_t *)p;
  free(p);
  t.fn(t.arg);
  return 0;
}
#endif

int thread_spawn(thread_fn fn, void *arg, size_t stack_size) {
#ifdef _WIN32
  win_tramp_t *t = (win_tramp_t *)malloc(sizeof(*t));
  if (!t) return -1;
  t->fn = fn; t->arg = arg;
  HANDLE h = CreateThread(NULL, stack_size, win_tramp, t, STACK_SIZE_PARAM_IS_A_RESERVATION, NULL);
  if (!h) { free(t); return -1; }
  CloseHandle(h);
  return 0;
#else
  pthread_attr_t attr;
  pthread_t th;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  if (stack_size) pthread_attr_setstacksize(&attr, stack_size);
  int r = pthread_create(&th, &attr, fn, arg);
  pthread_attr_destroy(&attr);
  return r == 0 ? 0 : -1;
#endif
}

void mutex_init(mutex_t *m) {
#ifdef _WIN32
  InitializeCriticalSection(&m->cs);
#else
  pthread_mutex_init(&m->m, NULL);
#endif
}
void mutex_lock(mutex_t *m) {
#ifdef _WIN32
  EnterCriticalSection(&m->cs);
#else
  pthread_mutex_lock(&m->m);
#endif
}
void mutex_unlock(mutex_t *m) {
#ifdef _WIN32
  LeaveCriticalSection(&m->cs);
#else
  pthread_mutex_unlock(&m->m);
#endif
}

uint64_t now_ms(void) {
#ifdef _WIN32
  return (uint64_t)GetTickCount64();
#else
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000ull + (uint64_t)ts.tv_nsec / 1000000ull;
#endif
}

void sleep_ms(int ms) {
#ifdef _WIN32
  Sleep((DWORD)ms);
#else
  struct timespec ts;
  ts.tv_sec = ms / 1000;
  ts.tv_nsec = (long)(ms % 1000) * 1000000L;
  nanosleep(&ts, NULL);
#endif
}
