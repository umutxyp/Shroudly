import Foundation

/*
 * The ad and tracker list, fetched through the engine (AdBlock.fetch on
 * Android): SOCKS5 with this session's password to raw.githubusercontent.com
 * by name, so the engine resolves it over encrypted DNS and opens it with a
 * technique where GitHub is blocked; TLS on that stream, checked against
 * that name; HTTP/1.1. Written to AdBlock.newFile for the engine to check.
 */
enum AdBlockFetch {
    static let timeout: TimeInterval = 60

    private static let trust = EngineTrust()
    private static let session = URLSession(configuration: .ephemeral, delegate: trust, delegateQueue: nil)

    static func fetch(port: Int, user: String, pass: String) async throws {
        let t = timeout
        let task = session.streamTask(withHostName: "127.0.0.1", port: port)
        trust.expect(task.taskIdentifier, ip: AdBlock.host, names: [])
        task.resume()
        defer { trust.forget(task.taskIdentifier); task.cancel() }
        let u = Array(user.utf8), p = Array(pass.utf8), h = Array(AdBlock.host.utf8)
        try await task.write(Data([5, 1, 2]), timeout: t)
        guard try await DohForwarder.read(task, 2, t) == [5, 2] else { throw URLError(.cannotConnectToHost) }
        try await task.write(Data([1, UInt8(u.count)] + u + [UInt8(p.count)] + p), timeout: t)
        guard try await DohForwarder.read(task, 2, t) == [1, 0] else { throw URLError(.userAuthenticationRequired) }
        try await task.write(Data([5, 1, 0, 3, UInt8(h.count)] + h + [1, 187]), timeout: t)
        let head = try await DohForwarder.read(task, 5, t)
        guard head.count == 5, head[1] == 0 else { throw URLError(.cannotConnectToHost) }
        _ = try await DohForwarder.read(task, head[3] == 1 ? 5 : head[3] == 4 ? 17 : Int(head[4]) + 2, t)
        task.startSecureConnection()
        let req = "GET \(AdBlock.path) HTTP/1.1\r\nHost: \(AdBlock.host)\r\nUser-Agent: Shroudly\r\n" +
            "Accept-Encoding: identity\r\nConnection: close\r\n\r\n"
        try await task.write(Data(req.utf8), timeout: t)
        var got = [UInt8]()
        got.reserveCapacity(4 << 20)
        // "Connection: close": the server ends the stream after the body, so
        // the response is read whole and taken apart once.
        while true {
            let (d, eof) = try await task.readData(ofMinLength: 1, maxLength: 65_536, timeout: t)
            if let d { got += d }
            guard got.count <= AdBlock.maxBytes + 16_384 else { throw URLError(.dataLengthExceedsMaximum) }
            if eof { break }
        }
        try body(of: got).write(to: AdBlock.newFile, options: .atomic)
    }

    /* The body of a whole 200 response, copied once (a list is megabytes, and
     * the tunnel's memory is short); a chunked one through http1Body. */
    static func body(of got: [UInt8]) throws -> Data {
        guard let end = (0..<max(0, got.count - 3)).first(where: { got[$0] == 13 && got[$0 + 1] == 10 && got[$0 + 2] == 13 && got[$0 + 3] == 10 }) else {
            throw URLError(.badServerResponse)
        }
        let head = String(decoding: got[..<end], as: UTF8.self).lowercased()
        guard head.hasPrefix("http/1."), head.split(separator: " ").dropFirst().first == "200" else { throw URLError(.badServerResponse) }
        if head.contains("transfer-encoding:") && head.contains("chunked") {
            guard let b = DohForwarder.http1Body(got, ended: true), !b.isEmpty else { throw URLError(.badServerResponse) }
            return Data(b)
        }
        let body = Data(got[(end + 4)...])
        if let line = head.components(separatedBy: "\r\n").first(where: { $0.hasPrefix("content-length:") }),
           let n = Int(line.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)), n != body.count {
            throw URLError(.networkConnectionLost)
        }
        guard !body.isEmpty else { throw URLError(.zeroByteResource) }
        return body
    }
}
