#ifndef SHROUDLY_RAW_WINDOWS_H
#define SHROUDLY_RAW_WINDOWS_H

#include "raw_desync.h"

/* Advanced packet-layer backend (Windows, SHROUDLY_RAW only).
 * Defeats stateful DPI via low-TTL/bad-checksum fake packets using WinDivert,
 * drops forged inbound RSTs and measures the decoy TTL from the SYN-ACK.
 * Requires Administrator; WinDivert.dll + WinDivert64.sys must be present. */
int  raw_windows_start(const raw_config *cfg); /* blocks until stop */
void raw_windows_stop(void);
/* Standby: the hook closed and its driver unloaded, the process kept;
 * resume opens it again (raw_windows.c). From the watchdog thread. */
void raw_windows_pause(void);
void raw_windows_resume(void);

#endif
