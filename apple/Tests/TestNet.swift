import Foundation
import XCTest

/* Plain sockets for the engine and tunnel tests. */
enum TestNet {
    static func sockaddrV4(_ ip: String, _ port: Int) -> sockaddr_in {
        var a = sockaddr_in()
        a.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        a.sin_family = sa_family_t(AF_INET)
        a.sin_port = UInt16(port).bigEndian
        a.sin_addr.s_addr = inet_addr(ip)
        return a
    }

    /* A TCP connection to 127.0.0.1:port, or -1. Reads time out after `timeout`. */
    static func connect(_ port: Int, timeout: TimeInterval = 5) -> Int32 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return -1 }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        var tv = timeval(tv_sec: Int(timeout), tv_usec: Int32((timeout - floor(timeout)) * 1e6))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var a = sockaddrV4("127.0.0.1", port)
        let r = withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        if r != 0 { close(fd); return -1 }
        return fd
    }

    static func send(_ fd: Int32, _ bytes: [UInt8]) {
        var off = 0
        while off < bytes.count {
            let n = bytes[off...].withUnsafeBufferPointer { Darwin.send(fd, $0.baseAddress, $0.count, 0) }
            if n <= 0 { return }
            off += n
        }
    }

    /* Exactly n bytes, or fewer when the peer closed or the read timed out. */
    static func recv(_ fd: Int32, _ n: Int) -> [UInt8] {
        var out: [UInt8] = []
        var buf = [UInt8](repeating: 0, count: max(n, 1))
        while out.count < n {
            let k = Darwin.recv(fd, &buf, n - out.count, 0)
            if k <= 0 { break }
            out += buf[0..<k]
        }
        return out
    }

    enum Target {
        case ipv4(String)
        case name(String)
    }

    /* A SOCKS5 CONNECT through the engine (RFC 1928, with RFC 1929's user
     * name and password). The connection and the reply code (0: connected),
     * or the auth status negated when the login was refused. */
    static func socks(_ port: Int, user: String, pass: String, to target: Target, _ dport: Int) -> (fd: Int32, code: Int) {
        let fd = connect(port)
        guard fd >= 0 else { return (-1, -1000) }
        send(fd, [5, 1, 2])
        guard recv(fd, 2) == [5, 2] else { return (fd, -1001) }
        send(fd, [1, UInt8(user.utf8.count)] + Array(user.utf8) + [UInt8(pass.utf8.count)] + Array(pass.utf8))
        let auth = recv(fd, 2)
        guard auth.count == 2, auth[1] == 0 else { return (fd, -Int(auth.last ?? 255) - 1) }
        var req: [UInt8] = [5, 1, 0]
        switch target {
        case .ipv4(let ip): req += [1] + ip.split(separator: ".").map { UInt8($0)! }
        case .name(let n): req += [3, UInt8(n.utf8.count)] + Array(n.utf8)
        }
        req += [UInt8(dport >> 8), UInt8(dport & 0xff)]
        send(fd, req)
        let head = recv(fd, 4)
        guard head.count == 4 else { return (fd, -1002) }
        let rest = head[3] == 4 ? 18 : (head[3] == 3 ? Int(recv(fd, 1).first ?? 0) + 2 : 6)
        _ = recv(fd, rest)
        return (fd, Int(head[1]))
    }
}

/* A TCP server on loopback (IPv4, and IPv6 on the same port when it can)
 * that sends back what it gets. */
final class EchoServer {
    private(set) var port = 0
    private var fds: [Int32] = []

    init() throws {
        let v4 = socket(AF_INET, SOCK_STREAM, 0)
        var a = TestNet.sockaddrV4("127.0.0.1", 0)
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let ok = withUnsafeMutablePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(v4, $0, len) == 0 && getsockname(v4, $0, &len) == 0 } }
        guard ok, listen(v4, 16) == 0 else { throw POSIXError(.EADDRINUSE) }
        port = Int(UInt16(bigEndian: a.sin_port))
        fds.append(v4)
        let v6 = socket(AF_INET6, SOCK_STREAM, 0)
        var b = sockaddr_in6()
        b.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
        b.sin6_family = sa_family_t(AF_INET6)
        b.sin6_port = UInt16(port).bigEndian
        b.sin6_addr = in6addr_loopback
        let ok6 = withUnsafePointer(to: &b) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(v6, $0, socklen_t(MemoryLayout<sockaddr_in6>.size)) == 0 } }
        if ok6, listen(v6, 16) == 0 { fds.append(v6) } else { Darwin.close(v6) }
        for fd in fds {
            Thread { EchoServer.serve(fd) }.start()
        }
    }

    private static func serve(_ l: Int32) {
        while true {
            let c = accept(l, nil, nil)
            if c < 0 { return }
            Thread {
                var buf = [UInt8](repeating: 0, count: 4096)
                while true {
                    let n = recv(c, &buf, buf.count, 0)
                    if n <= 0 { break }
                    TestNet.send(c, Array(buf[0..<n]))
                }
                Darwin.close(c)
            }.start()
        }
    }

    func stop() {
        for fd in fds { shutdown(fd, SHUT_RDWR); Darwin.close(fd) }
        fds = []
    }
}

/* The engine as the tunnel runs it, on a free port with a fresh password. */
final class TestEngine {
    let engine: Engine
    let port: Int
    let auth = SocksAuth.random()
    /* What the engine said (its log), as it comes, from any thread. */
    private let said: Said
    var lines: [String] { said.all }

    init(settings: AppSettings = AppSettings(strategyId: "none")) throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("auth-\(UUID().uuidString)").path
        try auth.write(to: path)
        defer { unlink(path) }
        port = Engine.freePort()
        let said = Said()
        self.said = said
        engine = Engine(log: { said.add($0) }, logSite: { _ in }, onExit: { _ in })
        let args = EngineArgs.make(port: port, dohPort: 0, settings: settings, authFile: path, blockIps: [])
        guard engine.start(args: args) else {
            throw NSError(domain: "TestEngine", code: 1, userInfo: [NSLocalizedDescriptionKey: engine.lastError ?? "no start"])
        }
    }

    /* Waits up to `timeout` for a line of the engine's log that contains `text`. */
    func waitFor(_ text: String, timeout: TimeInterval) -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let l = lines.last(where: { $0.contains(text) }) { return l }
            usleep(50_000)
        } while Date() < deadline
        return nil
    }
}

private final class Said: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    func add(_ l: String) { lock.lock(); lines.append(l); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return lines }
}
