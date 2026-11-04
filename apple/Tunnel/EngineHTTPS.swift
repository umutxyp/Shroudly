import Foundation
import Network

/*
 * An HTTPS stream to a site through the engine: the system's own SOCKS5
 * client (a proxy configuration, iOS 17, macOS 14, tvOS 17) to the engine's
 * port with this session's password, the site by name (the engine resolves
 * it over encrypted DNS and opens it with a technique where it is blocked),
 * then TLS with the site's name (SNI) and certificate check, as any app's.
 * The ad list and the live count use it: nothing of the tunnel's own goes to
 * our servers in the clear.
 *
 * Where the system has no proxy configurations (iOS 16, macOS 13), `open`
 * throws EngineHTTPS.Unsupported; the caller decides (the ad list then comes
 * straight, the live count is not sent).
 */
enum EngineHTTPS {
    struct Path: Equatable {
        let port: Int
        let user: String
        let pass: String
    }

    struct Unsupported: Error {}

    /* A stream to host:port, through the engine when `via` is given (else
     * straight out); TLS with the host's name. */
    static func open(_ host: String, port: Int = 443, via e: Path?, timeout t: TimeInterval) async throws -> Stream {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, host)
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = Int(t.rounded(.up))
        let params = NWParameters(tls: tls, tcp: tcp)
        if let e {
            guard #available(iOS 17.0, macOS 14.0, tvOS 17.0, *) else { throw Unsupported() }
            var proxy = ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(e.port))!))
            proxy.applyCredential(username: e.user, password: e.pass)
            let context = NWParameters.PrivacyContext(description: "Shroudly engine")
            context.proxyConfigurations = [proxy]
            params.setPrivacyContext(context)
        }
        let c = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: UInt16(port))!, using: params)
        let s = Stream(c)
        try await s.ready(timeout: t)
        return s
    }

    /* One connection, read and written with timeouts. */
    final class Stream: @unchecked Sendable {
        let connection: NWConnection
        private let queue = DispatchQueue(label: "me.codeshare.shroudly.https")

        init(_ c: NWConnection) { connection = c }

        func ready(timeout t: TimeInterval) async throws {
            try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
                let once = Once(k)
                connection.stateUpdateHandler = { state in
                    switch state {
                    case .ready: once.resume()
                    case .failed(let e), .waiting(let e): once.fail(e)
                    case .cancelled: once.fail(URLError(.cancelled))
                    default: break
                    }
                }
                connection.start(queue: queue)
                queue.asyncAfter(deadline: .now() + t) { once.fail(URLError(.timedOut)) }
            }
        }

        func write(_ d: Data, timeout t: TimeInterval) async throws {
            try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
                let once = Once(k)
                connection.send(content: d, completion: .contentProcessed { e in e.map(once.fail) ?? once.resume() })
                queue.asyncAfter(deadline: .now() + t) { once.fail(URLError(.timedOut)) }
            }
        }

        /* Up to max bytes, and whether the stream has ended. */
        func read(max: Int, timeout t: TimeInterval) async throws -> (Data?, Bool) {
            try await withCheckedThrowingContinuation { (k: CheckedContinuation<(Data?, Bool), Error>) in
                let once = OnceValue<(Data?, Bool)>(k)
                connection.receive(minimumIncompleteLength: 1, maximumLength: max) { data, _, done, error in
                    if let error, data == nil { once.fail(error) } else { once.resume((data, done)) }
                }
                queue.asyncAfter(deadline: .now() + t) { once.fail(URLError(.timedOut)) }
            }
        }

        /* Everything until the stream ends, up to max bytes. */
        func readAll(max: Int, timeout t: TimeInterval) async throws -> [UInt8] {
            var got = [UInt8]()
            while true {
                let (d, eof) = try await read(max: 65_536, timeout: t)
                if let d { got += d }
                guard got.count <= max else { throw URLError(.dataLengthExceedsMaximum) }
                if eof { return got }
            }
        }

        func close() { connection.cancel() }
    }

    /* A continuation resumed once, whoever comes first. */
    private final class Once: @unchecked Sendable {
        private var k: CheckedContinuation<Void, Error>?
        private let lock = NSLock()
        init(_ k: CheckedContinuation<Void, Error>) { self.k = k }
        func resume() { take()?.resume() }
        func fail(_ e: Error) { take()?.resume(throwing: e) }
        private func take() -> CheckedContinuation<Void, Error>? { lock.lock(); defer { lock.unlock() }; let c = k; k = nil; return c }
    }

    private final class OnceValue<T>: @unchecked Sendable {
        private var k: CheckedContinuation<T, Error>?
        private let lock = NSLock()
        init(_ k: CheckedContinuation<T, Error>) { self.k = k }
        func resume(_ v: T) { take()?.resume(returning: v) }
        func fail(_ e: Error) { take()?.resume(throwing: e) }
        private func take() -> CheckedContinuation<T, Error>? { lock.lock(); defer { lock.unlock() }; let c = k; k = nil; return c }
    }
}
