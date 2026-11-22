import Foundation
import Network
import Security

/*
 * The local client for a VLESS or Trojan server (Shared/Vless.swift): a
 * SOCKS5 server on 127.0.0.1 that sends every connection through the
 * server, as ShadowsocksClient does for Shadowsocks. The engine is pointed
 * at it (--upstream-file) with this session's user and password, so no
 * other program can use the user's server through it. The packet tunnel's
 * own connections do not go through the tunnel, so the ones to the server
 * go straight out.
 *
 * The connection to the server is the system's own: TCP, with TLS where the
 * link says so (the certificate checked here for the link's sni, or its
 * Host, or its address: see parameters()), then for a WebSocket or HTTPUpgrade the opening request and
 * its answer, read here. onError(why): the server could not be used, with
 * "noAnswer" (not reached), "tls" (reached, its TLS or its certificate
 * refused) or "protocol" (its answer is not this protocol's).
 */
final class VlessClient {
    private let link: VlessLink
    private let auth: SocksAuth
    private let queue = DispatchQueue(label: "shroudly.vless")
    private var listener: NWListener?
    private let onError: (String) -> Void
    /* Tests: a certificate to take as the server's own root. */
    private let anchor: SecCertificate?
    private static let lingerSeconds = 10.0
    private static let connectSeconds = 15.0

    init(link: VlessLink, auth: SocksAuth, anchor: SecCertificate? = nil, onError: @escaping (String) -> Void = { _ in }) {
        self.link = link
        self.auth = auth
        self.anchor = anchor
        self.onError = onError
    }

    /* Listens on 127.0.0.1 and returns its port. */
    func start() throws -> Int {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        params.allowLocalEndpointReuse = true
        let l = try NWListener(using: params)
        let ready = DispatchSemaphore(value: 0)
        var failed: Error?
        l.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.signal()
            case .failed(let e): failed = e; ready.signal()
            default: break
            }
        }
        l.newConnectionHandler = { [weak self] c in self?.accept(c) }
        l.start(queue: queue)
        _ = ready.wait(timeout: .now() + 5)
        if let failed { l.cancel(); throw failed }
        guard let port = l.port?.rawValue, port > 0 else { l.cancel(); throw POSIXError(.EADDRNOTAVAIL) }
        listener = l
        return Int(port)
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    /* Bytes from `c` until `need` says it has what it wants: need returns the
     * count it took, or 0 for more, or -1 to give up. */
    private func read(_ c: NWConnection, _ have: [UInt8], limit: Int = 1024, _ need: @escaping ([UInt8]) -> Int, _ done: @escaping ([UInt8], [UInt8]) -> Void, _ gone: @escaping () -> Void = {}) {
        let n = need(have)
        if n > 0 { done(Array(have.prefix(n)), Array(have.dropFirst(n))); return }
        if n < 0 || have.count > limit { c.cancel(); gone(); return }
        c.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, _, error in
            guard let self, error == nil, let data, !data.isEmpty else { c.cancel(); gone(); return }
            self.read(c, have + Array(data), limit: limit, need, done, gone)
        }
    }

    private func accept(_ c: NWConnection) {
        c.start(queue: queue)
        // Greeting: only the user and password method.
        read(c, [], { b in b.count < 2 ? 0 : (b[0] != 5 ? -1 : (b.count < 2 + Int(b[1]) ? 0 : 2 + Int(b[1]))) }) { [weak self] g, rest in
            guard let self else { return }
            guard g[2...].contains(2) else { c.send(content: Data([5, 0xff]), completion: .contentProcessed { _ in c.cancel() }); return }
            c.send(content: Data([5, 2]), completion: .idempotent)
            self.read(c, rest, { b in
                guard b.count >= 2 else { return 0 }
                if b[0] != 1 { return -1 }
                let ul = Int(b[1])
                guard b.count >= 3 + ul else { return 0 }
                let pl = Int(b[2 + ul])
                return b.count >= 3 + ul + pl ? 3 + ul + pl : 0
            }) { a, rest2 in
                let ul = Int(a[1])
                let user = Array(a[2..<(2 + ul)])
                let pass = Array(a[(3 + ul)...])
                guard Self.same(user, Array(self.auth.user.utf8)) && Self.same(pass, Array(self.auth.pass.utf8)) else {
                    c.send(content: Data([1, 1]), completion: .contentProcessed { _ in c.cancel() })
                    return
                }
                c.send(content: Data([1, 0]), completion: .idempotent)
                self.read(c, rest2, ShadowsocksClient.requestLength) { req, rest3 in self.connect(c, req, rest3) }
            }
        }
    }

    /* Equal, without stopping at the first byte that differs. */
    private static func same(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count else { return false }
        var d: UInt8 = 0
        for i in a.indices { d |= a[i] ^ b[i] }
        return d == 0
    }

    /* The destination of a SOCKS5 CONNECT request, as a name or an address
     * written out, and its port. */
    static func target(_ req: [UInt8]) -> (host: String, port: Int)? {
        guard req.count >= 7 else { return nil }
        let port = (Int(req[req.count - 2]) << 8) | Int(req[req.count - 1])
        switch req[3] {
        case 1 where req.count == 10: return (req[4..<8].map { String($0) }.joined(separator: "."), port)
        case 3 where req.count == 7 + Int(req[4]): return (String(decoding: req[5..<(5 + Int(req[4]))], as: UTF8.self), port)
        case 4 where req.count == 22:
            let g = stride(from: 4, to: 20, by: 2).map { String((Int(req[$0]) << 8) | Int(req[$0 + 1]), radix: 16) }
            return (g.joined(separator: ":"), port)
        default: return nil
        }
    }

    /* How the server is reached: TCP, with TLS where the link says so. */
    private func parameters() -> NWParameters {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.connectionTimeout = Int(Self.connectSeconds)
        guard link.tls else { return NWParameters(tls: nil, tcp: tcp) }
        let tls = NWProtocolTLS.Options()
        let name = link.sni.isEmpty ? (link.wsHost.isEmpty ? link.host : link.wsHost) : link.sni
        sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, name)
        for p in (link.net == "tcp" ? link.alpn : ["http/1.1"]) { sec_protocol_options_add_tls_application_protocol(tls.securityProtocolOptions, p) }
        // The certificate is checked for the name the link gives (its sni, or
        // its Host, or its address), not for the address connected to: a
        // link's address is often an IP or a CDN's name, and the system by
        // itself checks for that one. The chain is the system's to judge;
        // in tests one certificate stands in as the only root.
        let anchor = self.anchor
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trustRef, done in
            let trust = sec_trust_copy_ref(trustRef).takeRetainedValue()
            if let anchor {
                SecTrustSetAnchorCertificates(trust, [anchor] as CFArray)
                SecTrustSetAnchorCertificatesOnly(trust, true)
            }
            SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, name as CFString))
            // Off this queue: the check may ask the network about the certificate.
            DispatchQueue.global(qos: .userInitiated).async { done(SecTrustEvaluateWithError(trust, nil)) }
        }, queue)
        return NWParameters(tls: tls, tcp: tcp)
    }

    private func connect(_ c: NWConnection, _ req: [UInt8], _ early: [UInt8]) {
        guard let t = Self.target(req),
              let header = link.kind == "vless" ? Vless.vlessHeader(idHex: link.id, host: t.host, port: t.port) : Vless.trojanHeader(password: link.password, host: t.host, port: t.port) else {
            c.send(content: Data([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]), completion: .contentProcessed { _ in c.cancel() })
            return
        }
        let up = NWConnection(host: NWEndpoint.Host(link.host), port: NWEndpoint.Port(rawValue: UInt16(link.port)) ?? 1, using: parameters())
        var started = false
        var over = false
        let refuse: (String) -> Void = { [weak self] why in
            guard !started, !over else { return }
            over = true
            self?.onError(why)
            up.cancel()
            c.send(content: Data([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]), completion: .contentProcessed { _ in c.cancel() })
        }
        up.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                guard !started, !over else { return }
                if self.link.net == "tcp" { started = true; self.relay(c, up, header, early, []); return }
                self.upgrade(up) { rest in
                    guard !over else { return }
                    if let rest { started = true; self.relay(c, up, header, early, rest) } else { refuse("protocol") }
                }
            case .waiting(let e):
                // Not reached (refused, no route): not waited for, the app is told.
                refuse(Self.isTls(e) ? "tls" : "noAnswer")
            case .failed(let e):
                if started { c.cancel() } else { refuse(Self.isTls(e) ? "tls" : "noAnswer") }
            case .cancelled:
                if started { c.cancel() }
            default:
                break
            }
        }
        c.stateUpdateHandler = { state in
            if case .cancelled = state { up.cancel() }
            if case .failed = state { up.cancel() }
        }
        up.start(queue: queue)
    }

    private static func isTls(_ e: NWError) -> Bool {
        if case .tls = e { return true }
        return false
    }

    /* The opening request of a WebSocket (ws) or of a plain upgrade
     * (httpupgrade), and its answer: what came right behind the answer, or
     * nil when the answer is not this protocol's. */
    private func upgrade(_ up: NWConnection, _ done: @escaping ([UInt8]?) -> Void) {
        var keyBytes = [UInt8](repeating: 0, count: 16)
        if SecRandomCopyBytes(kSecRandomDefault, 16, &keyBytes) != errSecSuccess { for i in 0..<16 { keyBytes[i] = UInt8.random(in: 0...255) } }
        let key = Data(keyBytes).base64EncodedString()
        let hostHeader = link.wsHost.isEmpty ? (link.sni.isEmpty ? (link.host.contains(":") ? "[\(link.host)]" : link.host) : link.sni) : link.wsHost
        var req = "GET \(link.path) HTTP/1.1\r\nHost: \(hostHeader)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        if link.net == "ws" { req += "Sec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n" }
        req += "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1\r\n\r\n"
        up.send(content: Data(req.utf8), completion: .idempotent)
        let ws = link.net == "ws"
        func headEnd(_ b: [UInt8]) -> Int {
            guard b.count >= 4 else { return 0 }
            for i in 0...(b.count - 4) where b[i] == 13 && b[i + 1] == 10 && b[i + 2] == 13 && b[i + 3] == 10 { return i + 4 }
            return 0
        }
        read(up, [], limit: 65536, headEnd, { head, rest in
            let text = String(decoding: head, as: UTF8.self)
            guard text.hasPrefix("HTTP/1.1 101") else { done(nil); return }
            if ws {
                let accept = text.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("sec-websocket-accept:") }
                    .map { $0.dropFirst("sec-websocket-accept:".count).trimmingCharacters(in: .whitespaces) }
                guard accept == Vless.wsAccept(key) else { done(nil); return }
            }
            done(rest)
        }, { done(nil) })
    }

    /* Both directions, once the server is reached. The header goes out with
     * the app's first bytes; an app that waits for the server to speak
     * first never sends, and the header then goes by itself. */
    private func relay(_ c: NWConnection, _ up: NWConnection, _ header: [UInt8], _ early: [UInt8], _ rest: [UInt8]) {
        let ws = link.net == "ws"
        var pending: [UInt8]? = header
        var done = false
        let finish = { if !done { done = true; up.cancel(); c.cancel() } }
        func sendUp(_ bytes: [UInt8]) {
            // With nothing to send, the header alone (once).
            var out = bytes
            if let h = pending { out = h + bytes; pending = nil }
            if out.isEmpty { return }
            up.send(content: Data(ws ? Vless.wsFrame(out) : out), completion: .idempotent)
        }
        c.send(content: Data([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]), completion: .idempotent)
        if !early.isEmpty { sendUp(early) } else {
            queue.asyncAfter(deadline: .now() + 0.3) { if !done { sendUp([]) } }
        }

        // The app's bytes, to the server.
        func pumpUp() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
                if let data, !data.isEmpty { sendUp(Array(data)) }
                if complete || error != nil {
                    if error != nil { finish(); return }
                    // The app is done sending: said to the server where the
                    // transport can say it, and its last bytes waited for.
                    sendUp([])
                    if !ws { up.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .idempotent) }
                    self?.queue.asyncAfter(deadline: .now() + Self.lingerSeconds) { finish() }
                    return
                }
                pumpUp()
            }
        }

        // The server's bytes, to the app: out of their frames (a WebSocket)
        // and without the answer's own first bytes (VLESS).
        let reader = ws ? Vless.WsReader(onPing: { d in up.send(content: Data(Vless.wsFrame(d, opcode: 10)), completion: .idempotent) }) : nil
        var skip = link.kind == "vless" ? -1 : 0
        var pre: [UInt8] = []
        func hand(_ bytes: [UInt8]) -> Bool {
            var data: [UInt8]
            if let reader {
                guard let d = try? reader.push(bytes) else { return false }
                data = d
            } else { data = bytes }
            if data.isEmpty { return true }
            if skip != 0 {
                pre += data
                if skip < 0 {
                    if pre.count < 2 { return true }
                    if pre[0] != 0 { onError("protocol"); return false }
                    skip = 2 + Int(pre[1])
                }
                if pre.count < skip { return true }
                data = Array(pre[skip...])
                pre = []
                skip = 0
                if data.isEmpty { return true }
            }
            c.send(content: Data(data), completion: .idempotent)
            return true
        }
        func pumpDown() {
            up.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
                var ok = true
                if let data, !data.isEmpty { ok = hand(Array(data)) }
                if !ok || complete || error != nil || reader?.closed == true {
                    // What the server sent last still reaches the app.
                    c.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in finish() })
                    return
                }
                pumpDown()
            }
        }
        if !rest.isEmpty, !hand(rest) { finish(); return }
        pumpUp()
        pumpDown()
    }
}
