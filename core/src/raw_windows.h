#ifndef SHROUDLY_RAW_WINDOWS_H
#define SHROUDLY_RAW_WINDOWS_H

/* Advanced packet-layer backend (Windows, SHROUDLY_RAW only).
 * Defeats stateful DPI via low-TTL/bad-checksum fake packets using WinDivert.
 * Requires Administrator; WinDivert.dll + WinDivert64.sys must be present. */
/* quic_block: drop QUIC Initial (UDP/443) so browsers fall back to TCP.
 * udp_fake:   inject decoys ahead of the first Discord voice datagrams.
 * fake_repeats: how many decoy datagrams per voice flow (defaults if <= 0). */
int  raw_windows_start(int fake_ttl, int quic_block, int udp_fake, int fake_repeats); /* blocks until stop */
void raw_windows_stop(void);

#endif
