#!/usr/bin/env python3
"""
DPI censorship simulator — behaves like a real stateless SNI-blocking middlebox.

It sniffs loopback TCP traffic to a target port, reassembles nothing (like a
cheap stateless DPI), and if it sees a TLS ClientHello whose SNI matches a
blocklist *within a single packet*, it injects a RST to kill the connection.

This is exactly the class of DPI that split/disorder is designed to defeat:
  - if the SNI appears whole in one segment -> blocked
  - if it is split across segments -> the stateless DPI never matches -> passes

Run as root. Uses scapy on the loopback interface.
"""
import sys, threading
from scapy.all import sniff, IP, TCP, send, Raw, conf

BLOCK = [b"blocked.example", b"www.github.com", b"github.com", b"dpi-test.local"]
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
conf.verb = 0

def find_sni(payload):
    # minimal TLS ClientHello SNI parse; returns hostname bytes or None
    b = payload
    if len(b) < 6 or b[0] != 0x16 or b[1] != 0x03: return None
    if b[5] != 0x01: return None
    try:
        p = 5+4+2+32
        p += 1 + b[p]              # session id
        p += 2 + ((b[p]<<8)|b[p+1])  # cipher suites
        p += 1 + b[p]              # compression
        extlen = (b[p]<<8)|b[p+1]; p += 2
        end = p + extlen
        while p + 4 <= end and p+4 <= len(b):
            et = (b[p]<<8)|b[p+1]; el = (b[p+2]<<8)|b[p+3]; p += 4
            if et == 0x00:
                # server_name
                nlen = (b[p+3]<<8)|b[p+4]
                return b[p+5:p+5+nlen]
            p += el
    except Exception:
        return None
    return None

blocked_count = [0]
passed_count = [0]

def handle(pkt):
    if not (pkt.haslayer(TCP) and pkt.haslayer(Raw)): return
    tcp = pkt[TCP]
    if tcp.dport != PORT: return
    payload = bytes(pkt[Raw].load)
    sni = find_sni(payload)
    if sni is None:
        return
    for blk in BLOCK:
        if blk in sni:
            # Inject RST to both ends — stateless DPI censorship
            ip = pkt[IP]
            rst = IP(src=ip.dst, dst=ip.src)/TCP(sport=tcp.dport, dport=tcp.sport,
                     flags="R", seq=tcp.ack)
            send(rst)
            rst2 = IP(src=ip.src, dst=ip.dst)/TCP(sport=tcp.sport, dport=tcp.dport,
                      flags="R", seq=tcp.seq+len(payload))
            send(rst2)
            blocked_count[0]+=1
            print(f"[DPI] BLOCKED whole-SNI connection to {sni.decode(errors='replace')} (RST injected) total={blocked_count[0]}", flush=True)
            return
    passed_count[0]+=1
    print(f"[DPI] saw SNI {sni.decode(errors='replace')} (not in blocklist, passed)", flush=True)

print(f"[DPI] stateless SNI censor active on loopback :{PORT}, blocklist={[x.decode() for x in BLOCK]}", flush=True)
sniff(iface="lo", filter=f"tcp port {PORT}", prn=handle, store=0)
