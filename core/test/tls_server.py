import ssl, socket, threading, sys
PORT=int(sys.argv[1]) if len(sys.argv)>1 else 8443
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain('/tmp/cert.pem','/tmp/key.pem')
srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', PORT)); srv.listen(16)
print(f"[server] TLS server on :{PORT}", flush=True)
def handle(c):
    try:
        s = ctx.wrap_socket(c, server_side=True)
        data = s.recv(1024)
        s.send(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
        s.close()
    except Exception as e:
        pass
while True:
    try:
        c,_ = srv.accept(); threading.Thread(target=handle,args=(c,),daemon=True).start()
    except: break
