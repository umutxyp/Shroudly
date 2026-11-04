import Foundation

/*
 * The ad and tracker list, fetched through the engine (AdBlock.fetch on
 * Android): through the engine by name (EngineHTTPS), so the engine resolves
 * it over encrypted DNS and opens it with a technique where GitHub is
 * blocked; TLS with that name; HTTP/1.1. Written to AdBlock.newFile for the engine to check.
 */
enum AdBlockFetch {
    static let timeout: TimeInterval = 60

    static func fetch(via e: EngineHTTPS.Path) async throws {
        let stream: EngineHTTPS.Stream
        do {
            stream = try await EngineHTTPS.open(AdBlock.host, via: e, timeout: timeout)
        } catch is EngineHTTPS.Unsupported {
            // iOS 16 / macOS 13: no proxy configurations; the list straight.
            stream = try await EngineHTTPS.open(AdBlock.host, via: nil, timeout: timeout)
        }
        defer { stream.close() }
        let req = "GET \(AdBlock.path) HTTP/1.1\r\nHost: \(AdBlock.host)\r\nUser-Agent: Shroudly\r\n" +
            "Accept-Encoding: identity\r\nConnection: close\r\n\r\n"
        try await stream.write(Data(req.utf8), timeout: timeout)
        // "Connection: close": the server ends the stream after the body, so
        // the response is read whole and taken apart once.
        let got = try await stream.readAll(max: AdBlock.maxBytes + 16_384, timeout: timeout)
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
