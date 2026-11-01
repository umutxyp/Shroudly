/*
 * The packet tunnel's utun descriptor.
 *
 * NEPacketTunnelProvider hands packets over through packetFlow, one Swift
 * call per batch; hev-socks5-tunnel reads and writes the utun descriptor
 * behind it directly, which is far cheaper in a process iOS holds to about
 * 50 MB. The system does not say which descriptor that is, so it is looked
 * for: the one socket of this process connected to the utun kernel control.
 * The same search WireGuard's app makes (on the App Store for iOS and macOS).
 *
 * The iOS SDK lacks <sys/kern_control.h> and <sys/sys_domain.h>; their two
 * structures, the one request and AF_SYSTEM are stable kernel ABI, declared
 * here as macOS declares them.
 */
#include "shroudly_native.h"

#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/types.h>

#if __has_include(<sys/sys_domain.h>)
#include <sys/sys_domain.h>
#endif
#ifndef AF_SYSTEM
#define AF_SYSTEM 32
#endif

#if __has_include(<sys/kern_control.h>)
#include <sys/kern_control.h>
#else
#define MAX_KCTL_NAME 96
struct ctl_info {
  u_int32_t ctl_id;
  char ctl_name[MAX_KCTL_NAME];
};
struct sockaddr_ctl {
  u_char sc_len;
  u_char sc_family;
  u_int16_t ss_sysaddr;
  u_int32_t sc_id;
  u_int32_t sc_unit;
  u_int32_t sc_reserved[5];
};
#define CTLIOCGINFO _IOWR('N', 3, struct ctl_info)
#endif

#define UTUN_CONTROL_NAME "com.apple.net.utun_control"

int shroudly_tun_fd(void) {
  struct ctl_info info;
  memset(&info, 0, sizeof(info));
  strncpy(info.ctl_name, UTUN_CONTROL_NAME, sizeof(info.ctl_name) - 1);
  for (int fd = 0; fd <= 1024; fd++) {
    struct sockaddr_ctl addr;
    socklen_t len = sizeof(addr);
    memset(&addr, 0, sizeof(addr));
    if (getpeername(fd, (struct sockaddr *)&addr, &len) != 0 || addr.sc_family != AF_SYSTEM) continue;
    if (info.ctl_id == 0 && ioctl(fd, CTLIOCGINFO, &info) != 0) continue;
    if (addr.sc_id == info.ctl_id) return fd;
  }
  return -1;
}
