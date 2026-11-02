import CryptoKit
import Foundation
import Network

/*
 * Shadowsocks (AEAD, SIP004), the client end, for "Your own server": the
 * Apple side of electron/shadowsocks.js and Shadowsocks.kt, the same bytes on
 * the wire (all three are checked against tests/net/fixtures/ss-vectors.json;
 * the desktop's also against shadowsocks-libev).
 *
 * A random salt as long as the key, then chunks of [length (2 bytes, at most
 * 0x3FFF) + tag][payload + tag], sealed with the subkey HKDF-SHA1(master key,
 * salt, "ss-subkey") and a nonce counting up from zero (12 bytes,
 * little-endian). The master key comes from the password as OpenSSL's
 * EVP_BytesToKey (MD5). The client's first bytes are the target, as in SOCKS5.
 */
enum Shadowsocks {
    static let tagLen = 16
    static let maxChunk = 0x3fff

    static func masterKey(_ password: String, _ len: Int) -> [UInt8] {
        var out: [UInt8] = []
        var prev: [UInt8] = []
        let pw = Array(password.utf8)
        while out.count < len {
            prev = Array(Insecure.MD5.hash(data: prev + pw))
            out += prev
        }
        return Array(out.prefix(len))
    }

    static func subkey(_ key: [UInt8], _ salt: [UInt8], _ len: Int) -> SymmetricKey {
        HKDF<Insecure.SHA1>.deriveKey(inputKeyMaterial: SymmetricKey(data: key), salt: salt,
                                       info: Array("ss-subkey".utf8), outputByteCount: len)
    }

    /* One direction's sealing: its subkey and its nonce, counting up. */
    final class Sealer {
        private let chacha: Bool
        private let key: SymmetricKey
        private var nonce = [UInt8](repeating: 0, count: 12)

        init(method: String, key: [UInt8], salt: [UInt8]) {
            chacha = method == "chacha20-ietf-poly1305"
            self.key = Shadowsocks.subkey(key, salt, OwnServer.methods[method] ?? 32)
        }

        private func bump() {
            for i in nonce.indices {
                nonce[i] &+= 1
                if nonce[i] != 0 { break }
            }
        }

        func seal(_ plain: ArraySlice<UInt8>) -> [UInt8] {
            defer { bump() }
            if chacha {
                // swiftlint:disable:next force_try
                let box = try! ChaChaPoly.seal(plain, using: key, nonce: try! ChaChaPoly.Nonce(data: nonce))
                return Array(box.ciphertext) + Array(box.tag)
            }
            // swiftlint:disable:next force_try
            let box = try! AES.GCM.seal(plain, using: key, nonce: try! AES.GCM.Nonce(data: nonce))
            return Array(box.ciphertext) + Array(box.tag)
        }

        /* nil when it does not authenticate. */
        func open(_ sealed: ArraySlice<UInt8>) -> [UInt8]? {
            guard sealed.count >= Shadowsocks.tagLen else { return nil }
            let ct = sealed.prefix(sealed.count - Shadowsocks.tagLen)
            let tag = sealed.suffix(Shadowsocks.tagLen)
            do {
                let out: Data
                if chacha {
                    out = try ChaChaPoly.open(ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: nonce), ciphertext: ct, tag: tag), using: key)
                } else {
                    out = try AES.GCM.open(AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ct, tag: tag), using: key)
                }
                bump()
                return Array(out)
            } catch {
                return nil
            }
        }
    }

    /* What one side sends: its salt first, then sealed chunks. `salt` only
     * for the tests' fixed vectors. */
    final class Encoder {
        private let salt: [UInt8]
        private let sealer: Sealer
        private var started = false

        init(method: String, key: [UInt8], salt: [UInt8]? = nil) {
            let len = OwnServer.methods[method] ?? 32
            var s = salt ?? [UInt8](repeating: 0, count: len)
            if salt == nil, SecRandomCopyBytes(kSecRandomDefault, len, &s) != errSecSuccess {
                for i in 0..<len { s[i] = UInt8.random(in: 0...255) }
            }
            self.salt = s
            sealer = Sealer(method: method, key: key, salt: s)
        }

        func encode(_ data: [UInt8]) -> [UInt8] {
            var out: [UInt8] = []
            out.reserveCapacity(data.count + 64)
            if !started { out += salt; started = true }
            var i = 0
            while i < data.count {
                let n = min(Shadowsocks.maxChunk, data.count - i)
                out += sealer.seal([UInt8(n >> 8), UInt8(n & 0xff)][...])
                out += sealer.seal(data[i..<(i + n)])
                i += n
            }
            return out
        }
    }

    /* What the other side reads back; `bad` once something did not
     * authenticate (the rest of the stream then means nothing). */
    final class Decoder {
        private let method: String
        private let key: [UInt8]
        private var buf: [UInt8] = []
        private var sealer: Sealer?
        private var want = 0
        private(set) var bad = false

        init(method: String, key: [UInt8]) {
            self.method = method
            self.key = key
        }

        func push(_ data: [UInt8]) -> [UInt8] {
            if bad { return [] }
            buf += data
            var out: [UInt8] = []
            var at = 0
            if sealer == nil {
                let saltLen = OwnServer.methods[method] ?? 32
                if buf.count < saltLen { return [] }
                sealer = Sealer(method: method, key: key, salt: Array(buf.prefix(saltLen)))
                at = saltLen
            }
            guard let s = sealer else { return [] }
            while true {
                if want == 0 {
                    if buf.count - at < 2 + Shadowsocks.tagLen { break }
                    guard let l = s.open(buf[at..<(at + 2 + Shadowsocks.tagLen)]) else { bad = true; break }
                    want = ((Int(l[0]) << 8) | Int(l[1])) & Shadowsocks.maxChunk
                    at += 2 + Shadowsocks.tagLen
                    if want == 0 { bad = true; break }
                }
                if buf.count - at < want + Shadowsocks.tagLen { break }
                guard let plain = s.open(buf[at..<(at + want + Shadowsocks.tagLen)]) else { bad = true; break }
                out += plain
                at += want + Shadowsocks.tagLen
                want = 0
            }
            buf.removeFirst(min(at, buf.count))
            return out
        }
    }

    /* The target in SOCKS5 form: type, address, port. */
    static func encodeTarget(host: String, port: Int) -> [UInt8]? {
        let p: [UInt8] = [UInt8((port >> 8) & 0xff), UInt8(port & 0xff)]
        if let v4 = IPv4Address(host), host.split(separator: ".").count == 4 { return [1] + Array(v4.rawValue) + p }
        if host.contains(":"), let v6 = IPv6Address(host) { return [4] + Array(v6.rawValue) + p }
        let name = Array(host.utf8)
        guard (1...255).contains(name.count) else { return nil }
        return [3, UInt8(name.count)] + name + p
    }
}

/*
 * The client: a SOCKS5 server on 127.0.0.1 that sends every connection
 * through the Shadowsocks server. The engine is pointed at it as its own
 * server (--upstream-file) with `auth`, made fresh for each session: on a Mac
 * any program can reach 127.0.0.1, and none other may use the user's server
 * through it. The packet tunnel's own connections do not go through the
 * tunnel, so the ones to the server go straight out.
 */
final class ShadowsocksClient {
    private let link: OwnServerLink
    private let auth: SocksAuth
    private let key: [UInt8]
    private let queue = DispatchQueue(label: "shroudly.shadowsocks")
    private var listener: NWListener?
    private let log: (String) -> Void

    init(link: OwnServerLink, auth: SocksAuth, log: @escaping (String) -> Void = { _ in }) {
        self.link = link
        self.auth = auth
        self.log = log
        key = Shadowsocks.masterKey(link.password, OwnServer.methods[link.method] ?? 32)
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
    private func read(_ c: NWConnection, _ have: [UInt8], _ need: @escaping ([UInt8]) -> Int, _ done: @escaping ([UInt8], [UInt8]) -> Void) {
        let n = need(have)
        if n > 0 { done(Array(have.prefix(n)), Array(have.dropFirst(n))); return }
        if n < 0 || have.count > 1024 { c.cancel(); return }
        c.receive(minimumIncompleteLength: 1, maximumLength: 1024) { [weak self] data, _, complete, error in
            guard let self, error == nil, let data, !data.isEmpty else { c.cancel(); return }
            _ = complete
            self.read(c, have + Array(data), need, done)
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
                self.read(c, rest2, Self.requestLength) { req, rest3 in self.connect(c, req, rest3) }
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

    /* A CONNECT request's length, as SOCKS5 lays it out. */
    static func requestLength(_ b: [UInt8]) -> Int {
        guard b.count >= 5 else { return 0 }
        if b[0] != 5 || b[1] != 1 { return -1 }
        let len: Int
        switch b[3] {
        case 1: len = 10
        case 3: len = 7 + Int(b[4])
        case 4: len = 22
        default: return -1
        }
        return b.count >= len ? len : 0
    }

    private func connect(_ c: NWConnection, _ req: [UInt8], _ early: [UInt8]) {
        // The target exactly as the request names it: SOCKS5's own form.
        let target = Array(req[3...])
        let up = NWConnection(host: NWEndpoint.Host(link.host), port: NWEndpoint.Port(rawValue: UInt16(link.port)) ?? 1, using: .tcp)
        let enc = Shadowsocks.Encoder(method: link.method, key: key)
        let dec = Shadowsocks.Decoder(method: link.method, key: key)
        var started = false
        up.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                guard !started else { return }
                started = true
                c.send(content: Data([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]), completion: .idempotent)
                up.send(content: Data(enc.encode(target + early)), completion: .idempotent)
                self?.pump(from: c, to: up) { enc.encode($0) }
                self?.pump(from: up, to: c) { bytes in
                    let out = dec.push(bytes)
                    if dec.bad { up.cancel(); c.cancel() }
                    return out
                }
            case .failed, .cancelled:
                if !started { c.send(content: Data([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]), completion: .contentProcessed { _ in c.cancel() }) } else { c.cancel() }
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

    /* Everything from `a` to `b`, changed by `transform`, until either ends. */
    private func pump(from a: NWConnection, to b: NWConnection, _ transform: @escaping ([UInt8]) -> [UInt8]) {
        a.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            if let data, !data.isEmpty {
                let out = transform(Array(data))
                if !out.isEmpty { b.send(content: Data(out), completion: .idempotent) }
            }
            if complete || error != nil {
                b.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .idempotent)
                if error != nil { a.cancel(); b.cancel() }
                return
            }
            self?.pump(from: a, to: b, transform)
        }
    }
}
