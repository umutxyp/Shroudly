/*
 * Shroudly Core — platform abstraction
 * Only OS-provided APIs are used: BSD sockets / Winsock, pthreads / Win32 threads.
 */
#ifndef SHROUDLY_PLATFORM_H
#define SHROUDLY_PLATFORM_H

/* Expose getaddrinfo/addrinfo and friends on glibc/musl/macOS. */
#if !defined(_WIN32)
  #ifndef _GNU_SOURCE
  #define _GNU_SOURCE
  #endif
  #ifndef _DEFAULT_SOURCE
  #define _DEFAULT_SOURCE
  #endif
  #ifndef _DARWIN_C_SOURCE
  #define _DARWIN_C_SOURCE
  #endif
#endif

#include <stddef.h>
#include <stdint.h>
#include <stdatomic.h>

#ifdef _WIN32
  #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
  #endif
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #include <windows.h>
  typedef SOCKET sock_t;
  #define SOCK_INVALID INVALID_SOCKET
  #define sock_errno() WSAGetLastError()
  #define SE_CONNRESET WSAECONNRESET
  #define SE_TIMEDOUT  WSAETIMEDOUT
  #define SE_INTR      WSAEINTR
  #define SE_WOULDBLOCK WSAEWOULDBLOCK
  #define SE_INPROGRESS WSAEWOULDBLOCK
  typedef int socklen_t_compat;
  #define SHUT_WR_C SD_SEND
  #define SHUT_RDWR_C SD_BOTH
#else
  #include <sys/types.h>
  #include <sys/socket.h>
  #include <netinet/in.h>
  #include <netinet/tcp.h>
  #include <arpa/inet.h>
  #include <netdb.h>
  #include <poll.h>
  #include <unistd.h>
  #include <errno.h>
  #include <pthread.h>
  typedef int sock_t;
  #define SOCK_INVALID (-1)
  #define sock_errno() errno
  #define SE_CONNRESET ECONNRESET
  #define SE_TIMEDOUT  ETIMEDOUT
  #define SE_INTR      EINTR
  #define SE_WOULDBLOCK EWOULDBLOCK
  #define SE_INPROGRESS EINPROGRESS
  #define SHUT_WR_C SHUT_WR
  #define SHUT_RDWR_C SHUT_RDWR
#endif

/* ── lifecycle ─────────────────────────────────────────────────────────── */
int  plat_init(void);
void plat_cleanup(void);

/* ── sockets ───────────────────────────────────────────────────────────── */
void sock_close(sock_t s);
void sock_close_graceful(sock_t s);
int  sock_set_nodelay(sock_t s, int on);
int  sock_set_keepalive(sock_t s);
int  sock_set_nonblock(sock_t s, int on);
int  sock_set_timeouts(sock_t s, int ms);
int  sock_get_ttl(sock_t s, int family);
int  sock_set_ttl(sock_t s, int family, int ttl);
/* Wait until the kernel has transmitted everything queued on s (best effort, max_ms). */
void sock_wait_sent(sock_t s, int max_ms);
/* Connect with timeout. Returns 0 on success, -2 when timeout_ms ran out with
 * no answer, -1 on any other failure (refused, unreachable, ...). */
int  sock_connect_timeout(sock_t s, const struct sockaddr *sa, int salen, int timeout_ms);
/* Send all bytes; flags passed to send(). Returns 0 on success, -1 on error. */
int  sock_send_all(sock_t s, const uint8_t *buf, size_t len, int flags);
/* 1 when a socket error (sock_errno()) means the other end reset or closed
 * the connection — or something on the path did, posing as it. */
int  sock_err_peer_gone(int err);
/* Poll a single socket for readability. 1 readable, 0 timeout, -1 error. */
int  sock_wait_readable(sock_t s, int timeout_ms);
/* Poll two sockets for readability. Returns bitmask (1 = a, 2 = b), 0 timeout, -1 error. */
int  sock_wait_either(sock_t a, sock_t b, int timeout_ms);
/* Poll up to SOCK_POLL_MAX sockets for readability. ready[i] is set to 1 for
 * each one that is readable, closed or in error (a read then says which), else
 * 0. Returns how many are ready, 0 on timeout, -1 on error. */
#define SOCK_POLL_MAX 16
int  sock_wait_any(const sock_t *s, int n, int timeout_ms, int *ready);
/* Connecting to several addresses side by side. sock_connect_start begins a
 * connect without waiting for it: 0 connected at once, 1 under way (the socket
 * is non-blocking meanwhile), -1 failed. sock_connect_wait waits up to
 * timeout_ms for any of n connects under way (n at most SOCK_POLL_MAX) and sets
 * done[i] to 1 (connected, and back in blocking mode), -1 (failed) or 0 (still
 * going). Returns how many finished, 0 on timeout, -1 on error. */
int  sock_connect_start(sock_t s, const struct sockaddr *sa, int salen);
int  sock_connect_wait(const sock_t *s, int n, int timeout_ms, int *done);

/* ── threads & sync ────────────────────────────────────────────────────── */
typedef void *(*thread_fn)(void *);
int  thread_spawn(thread_fn fn, void *arg, size_t stack_size);

typedef struct {
#ifdef _WIN32
  CRITICAL_SECTION cs;
#else
  pthread_mutex_t m;
#endif
} mutex_t;
void mutex_init(mutex_t *m);
void mutex_lock(mutex_t *m);
void mutex_unlock(mutex_t *m);

/* ── time ──────────────────────────────────────────────────────────────── */
uint64_t now_ms(void);
void     sleep_ms(int ms);

#endif
