import Foundation
import Security

/*
 * The packet tunnel's addresses, the engine's arguments and
 * hev-socks5-tunnel's settings: the Android app's (TunnelConfig.kt,
 * Engine.args), with the limits an iOS packet tunnel needs.
 *
 * Every app's packets arrive on the tunnel; hev turns their TCP and UDP back
 * into connections and hands them to the engine's SOCKS5 port. DNS is
 * answered inside hev ("mapdns"): an app asking for example.com gets a
 * stand-in address, and when it connects there, hev asks the engine for
 * example.com by name. So the engine sees every site's name, resolves it
 * over its own encrypted DNS, and can choose a technique per site, exactly
 * as with the desktop's system proxy.
 *
 * Every address here is in 198.18.0.0/15, the benchmarking range (RFC 2544),
 * which no real host uses: the tunnel and its DNS server in 198.18.0.0/16,
 * the stand-in addresses in 198.19.0.0/16. Each hev started gets the next
 * quarter of that range, so an address an app kept from an earlier one is in
 * none of the new one's names; the engine refuses it at once (--fake-net)
 * and the app looks the name up again, never reaching another site.
 *
 * Memory: iOS ends a packet tunnel that holds more than about 50 MB. A
 * busy connection through the engine holds up to about 140 KB (its four
 * 32 KB buffers and its thread's stack; Tests/MemoryTests.swift measures
 * it), and every hev session its stack and buffer. So hev takes at most
 * maxSessions at once, about 22 MB in the engine when every one of them is
 * busy, with hev's own small-memory settings (its README, "Low memory
 * usage"); the engine is built to take at most 192 connections, the rest
 * left for its own lookups (Config/Shroudly.xcconfig). An app past the cap
 * has its connection refused and tries again.
 */
enum TunnelConfig {
    static let addressV4 = "198.18.0.1"
    static let addressV6 = "fc00::1"
    /* The DNS server the tunnel hands to the system; hev answers it itself. */
    static let dnsV4 = "198.18.0.2"
    /* 198.19.0.0/16 in four: 16384 addresses each, more than cacheSize. */
    static let mappedRanges = ["198.19.0.0", "198.19.64.0", "198.19.128.0", "198.19.192.0"]
    static let mappedNetmask = "255.255.192.0"
    /* How many names hev keeps a stand-in address for at once. */
    static let cacheSize = 4096
    /* hev's own recommendation for a tunnel (fewer, larger packets). TCP from
     * apps ends inside hev and goes on over the engine's own sockets, which
     * use the real path's MTU. */
    static let mtu = 8500
    static let maxSessions = 160
    /* hev's small-memory settings: a 20 KB stack plus the TCP buffer. */
    static let taskStackSize = 24576
    static let tcpBufferSize = 4096
    /* An hour for a quiet TCP connection: chat apps and push notifications
     * keep one open to hear of a new message (TunnelConfig.kt). UDP: the
     * engine's own two minutes. */
    static let tcpIdleMs = 3_600_000
    static let udpIdleMs = 120_000

    /* Addresses the engine refuses at once instead of trying to reach. */
    static let fakeNet = "198.18.0.0/15"

    /* The range for the hev started `generation`-th (any number; it wraps). */
    static func mappedNetwork(generation: Int) -> String {
        let n = mappedRanges.count
        return mappedRanges[((generation % n) + n) % n]
    }

    /* hev's settings. user and pass: the engine's SOCKS5 credentials for this
     * session, or nil when it takes none. */
    static func yaml(socksPort: Int, user: String? = nil, pass: String? = nil,
                     mapped: String = mappedRanges[0], maxSessions: Int = maxSessions) -> String {
        precondition((1...65535).contains(socksPort), "bad port \(socksPort)")
        precondition(mappedRanges.contains(mapped), "bad stand-in range \(mapped)")
        precondition((1...TunnelConfig.maxSessions).contains(maxSessions), "bad session cap \(maxSessions)")
        precondition((user == nil) == (pass == nil), "both or neither of user and password")
        for s in [user, pass].compactMap({ $0 }) { precondition(SocksAuth.isToken(s), "bad credential") }
        var auth = ""
        if let user, let pass { auth = "  username: '\(user)'\n  password: '\(pass)'\n" }
        // mapdns answers A queries with a stand-in address for any name, real
        // or not, and every other type with an empty answer: by design.
        return """
        tunnel:
          mtu: \(mtu)
        socks5:
          port: \(socksPort)
          address: 127.0.0.1
          udp: 'udp'
        \(auth)mapdns:
          address: \(dnsV4)
          port: 53
          network: \(mapped)
          netmask: \(mappedNetmask)
          cache-size: \(cacheSize)
        misc:
          task-stack-size: \(taskStackSize)
          tcp-buffer-size: \(tcpBufferSize)
          connect-timeout: 10000
          tcp-read-write-timeout: \(tcpIdleMs)
          udp-read-write-timeout: \(udpIdleMs)
          max-session-count: \(maxSessions)
          log-level: warn

        """
    }
}

enum EngineArgs {
    /* The desktop's and Android's arguments (Engine.args): auto mode or the
     * chosen technique, encrypted DNS through the tunnel's forwarder, every
     * known block page, this session's SOCKS5 password file and the stand-in
     * range. Ad blocking is told to the running engine (AdBlock.commands),
     * so a change needs no restart. */
    static func make(port: Int, dohPort: Int, settings: AppSettings, authFile: String?,
                     blockIps: [String], fakeNet: String? = TunnelConfig.fakeNet, upstreamFile: String? = nil,
                     fallbackFile: String? = nil, httpOpen: Bool = false) -> [String] {
        let strategy = settings.strategy
        var a = ["--listen", "127.0.0.1", "--port", String(port), "--strategy", strategy.spec]
        if strategy.auto { a.append("--auto") }
        a.append("--doh")
        if dohPort > 0 { a += ["--doh-port", String(dohPort)] }
        if let authFile { a += [SocksAuth.option, authFile] }
        // The Mac as its own proxy (AppSettings.proxyOnly): the apps' HTTP
        // proxy requests without the password; SOCKS keeps it.
        if httpOpen { a.append("--http-open") }
        if let fakeNet { a += ["--fake-net", fakeNet] }
        for ip in blockIps { a += ["--block-ip", ip] }
        if settings.quicOff { a.append("--drop-quic") }
        if settings.ipv6Off { a.append("--ipv4-only") }
        // "Your own server": every connection to a name goes through it.
        if let upstreamFile { a += ["--upstream-file", upstreamFile] }
        // The last way out (TorRoute): Tor, for a connection nothing else got
        // through; never with the user's own server, which carries everything.
        else if let fallbackFile { a += ["--fallback-file", fallbackFile] }
        return a
    }

    /* The known block pages, one per line ('#' starts a comment): the
     * Android app's list (android/app/src/main/assets/block-ips.txt). */
    static func blockIps(from text: String) -> [String] {
        text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") }
    }

    /* The arguments as a log line: the block pages counted, not listed. */
    static func shown(_ args: [String]) -> String {
        var out: [String] = []
        var blocked = 0
        var i = 0
        while i < args.count {
            if args[i] == "--block-ip" { blocked += 1; i += 2; continue }
            out.append(args[i])
            i += 1
        }
        return out.joined(separator: " ") + (blocked > 0 ? " (+\(blocked) known block pages)" : "")
    }
}

/*
 * The engine's port is on 127.0.0.1, where other apps on a Mac could reach
 * it. A user name and password made fresh for each session keep them from
 * using it as a relay (SocksAuth.kt). The engine reads them from a file
 * (--auth-file, one line "user:pass") that is deleted once it has.
 */
struct SocksAuth: Equatable {
    static let option = "--auth-file"

    let user: String
    let pass: String

    static func isToken(_ s: String) -> Bool {
        (8...64).contains(s.count) && s.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    static func random() -> SocksAuth {
        func hex(_ n: Int) -> String {
            var bytes = [UInt8](repeating: 0, count: n)
            if SecRandomCopyBytes(kSecRandomDefault, n, &bytes) != errSecSuccess {
                for i in 0..<n { bytes[i] = UInt8.random(in: 0...255) }
            }
            return bytes.map { String(format: "%02x", $0) }.joined()
        }
        return SocksAuth(user: hex(8), pass: hex(16))
    }

    var line: String { "\(user):\(pass)\n" }

    /* Writes the file readable by this process alone (0600 from the start). */
    func write(to path: String) throws {
        unlink(path)
        let fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0o600)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { close(fd) }
        let data = Array(line.utf8)
        guard Darwin.write(fd, data, data.count) == data.count else { throw POSIXError(.EIO) }
    }
}
