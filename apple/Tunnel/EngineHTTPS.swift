import Foundation

/*
 * An HTTPS stream to a site through the engine: SOCKS5 with this session's
 * password to the site by name (the engine resolves it over encrypted DNS
 * and opens it with a technique where it is blocked), then TLS on that
 * stream, checked against that name. The ad list and the live count use it;
 * nothing of the tunnel's own goes to our servers in the clear.
 */
enum EngineHTTPS {
    struct Path: Equatable {
        let port: Int
        let user: String
        let pass: String
    }

    private static let trust = EngineTrust()
    private static let session = URLSession(configuration: .ephemeral, delegate: trust, delegateQueue: nil)

    /* An open TLS stream to host:443; the caller cancels it when done. */
    static func open(_ host: String, via e: Path, timeout t: TimeInterval) async throws -> URLSessionStreamTask {
        let task = session.streamTask(withHostName: "127.0.0.1", port: e.port)
        trust.expect(task.taskIdentifier, ip: host, names: [])
        task.resume()
        do {
            let u = Array(e.user.utf8), p = Array(e.pass.utf8), h = Array(host.utf8)
            guard u.count < 256, p.count < 256, h.count < 256 else { throw URLError(.badURL) }
            try await task.write(Data([5, 1, 2]), timeout: t)
            guard try await DohForwarder.read(task, 2, t) == [5, 2] else { throw URLError(.cannotConnectToHost) }
            try await task.write(Data([1, UInt8(u.count)] + u + [UInt8(p.count)] + p), timeout: t)
            guard try await DohForwarder.read(task, 2, t) == [1, 0] else { throw URLError(.userAuthenticationRequired) }
            try await task.write(Data([5, 1, 0, 3, UInt8(h.count)] + h + [1, 187]), timeout: t)
            let head = try await DohForwarder.read(task, 5, t)
            guard head.count == 5, head[1] == 0 else { throw URLError(.cannotConnectToHost) }
            _ = try await DohForwarder.read(task, head[3] == 1 ? 5 : head[3] == 4 ? 17 : Int(head[4]) + 2, t)
            task.startSecureConnection()
            return task
        } catch {
            done(task)
            throw error
        }
    }

    static func done(_ task: URLSessionStreamTask) {
        trust.forget(task.taskIdentifier)
        task.cancel()
    }

    /* Everything the stream sends until it ends, up to max bytes. */
    static func readAll(_ task: URLSessionStreamTask, max: Int, timeout t: TimeInterval) async throws -> [UInt8] {
        var got = [UInt8]()
        while true {
            let (d, eof) = try await task.readData(ofMinLength: 1, maxLength: 65_536, timeout: t)
            if let d { got += d }
            guard got.count <= max else { throw URLError(.dataLengthExceedsMaximum) }
            if eof { return got }
        }
    }
}
