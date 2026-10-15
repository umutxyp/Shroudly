#!/usr/bin/env python3
"""
Deterministic inline DPI (a real middlebox, not async RST).

It is a TCP proxy: client -> [DPI] -> server. It can run in three modes:
  stateless : inspects ONLY the first inbound segment for a whole SNI.
  stateful  : buffers/reassembles until it has the full TLS record, then inspects.
  silent    : like stateful, but a blocked connection is swallowed instead of
              closed: nothing is forwarded, nothing comes back, nothing is
              reset — how some ISPs (Turkcell Superonline among them) block.
If a blocked SNI is seen, it DROPS the connection (close both sides) = deterministic block.
Otherwise it relays transparently.

Client connects to DPI port; DPI connects onward to the real server port.
This models exactly how a censor middlebox sits in-path, and the block is
deterministic (no timing races), so test results are trustworthy.
"""
import sys, socket, threading
MODE=sys.argv[1]          # stateless | stateful | silent
LISTEN=int(sys.argv[2])
TARGET=int(sys.argv[3])
BLOCK=[b"dpi-test.local", b"blocked.example"]

def extract_sni(b):
    if len(b)<6 or b[0]!=0x16 or b[1]!=0x03: return (None,False)
    if len(b)<5: return (None,False)
    rl=(b[3]<<8)|b[4]
    full = len(b)>=5+rl
    if not full: return (None,False)   # record incomplete
    if b[5]!=0x01: return (None,True)
    try:
        p=5+4+2+32; p+=1+b[p]; p+=2+((b[p]<<8)|b[p+1]); p+=1+b[p]
        extlen=(b[p]<<8)|b[p+1]; p+=2; end=p+extlen
        while p+4<=end:
            et=(b[p]<<8)|b[p+1]; el=(b[p+2]<<8)|b[p+3]; p+=4
            if et==0:
                nlen=(b[p+3]<<8)|b[p+4]; return (b[p+5:p+5+nlen],True)
            p+=el
    except: return (None,True)
    return (None,True)

def blocked(sni):
    return sni is not None and any(x in sni for x in BLOCK)

def relay(a,b):
    try:
        while True:
            d=a.recv(65536)
            if not d: break
            b.sendall(d)
    except: pass
    try: b.shutdown(socket.SHUT_WR)
    except: pass

def handle(cli):
    try:
        srv=socket.socket(); srv.connect(('127.0.0.1',TARGET))
    except:
        cli.close(); return
    # inspect first bytes from client
    buf=b""
    cli.settimeout(5)
    try:
        while True:
            d=cli.recv(65536)
            if not d: break
            buf+=d
            if MODE=="stateless":
                # inspect ONLY what arrived in THIS first segment
                sni,_=extract_sni(d)   # per-segment: if split, sees nothing
                if blocked(sni):
                    cli.close(); srv.close(); 
                    print(f"[INLINE-DPI/stateless] BLOCKED {sni}",flush=True); return
                # forward and stop inspecting (only first segment matters)
                srv.sendall(buf)
                break
            else: # stateful / silent
                sni,full=extract_sni(buf)  # reassembled buffer
                if blocked(sni) and MODE=="silent":
                    srv.close()
                    print(f"[INLINE-DPI/silent] SWALLOWED {sni}",flush=True)
                    cli.settimeout(None)
                    try:
                        while cli.recv(65536): pass   # read and discard until the client gives up
                    except: pass
                    cli.close(); return
                if blocked(sni):
                    cli.close(); srv.close()
                    print(f"[INLINE-DPI/stateful] BLOCKED {sni}",flush=True); return
                if full:
                    srv.sendall(buf); break
                # keep buffering until full record
    except socket.timeout:
        try: srv.sendall(buf)
        except: pass
    cli.settimeout(None)
    threading.Thread(target=relay,args=(cli,srv),daemon=True).start()
    relay(srv,cli)
    try: cli.close()
    except: pass
    try: srv.close()
    except: pass

s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(('127.0.0.1',LISTEN)); s.listen(64)
print(f"[INLINE-DPI/{MODE}] listening :{LISTEN} -> :{TARGET}, block={[x.decode() for x in BLOCK]}",flush=True)
while True:
    c,_=s.accept(); threading.Thread(target=handle,args=(c,),daemon=True).start()
