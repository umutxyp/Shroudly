#ifndef SHROUDLY_RAW_WINDOWS_H
#define SHROUDLY_RAW_WINDOWS_H

/* Advanced packet-layer backend (Windows, SHROUDLY_RAW only).
 * Defeats stateful DPI via low-TTL/bad-checksum fake packets using WinDivert.
 * Requires Administrator; WinDivert.dll + WinDivert64.sys must be present. */
int  raw_windows_start(int fake_ttl); /* blocks until stop */
void raw_windows_stop(void);

#endif
