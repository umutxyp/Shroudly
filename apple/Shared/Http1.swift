import Foundation

/* The little of HTTP/1.1 the app and the tunnel read themselves. */
enum Http1 {
    /* An HTTP/1.1 response's body once it is all there (a 200; by
     * Content-Length, chunks, or the connection's end), else nil. */
    static func body(_ b: [UInt8], ended: Bool) -> [UInt8]? {
        guard let end = (0..<max(0, b.count - 3)).first(where: { b[$0] == 13 && b[$0 + 1] == 10 && b[$0 + 2] == 13 && b[$0 + 3] == 10 }) else { return nil }
        let head = String(decoding: b[..<end], as: UTF8.self)
        let lines = head.components(separatedBy: "\r\n")
        guard let status = lines.first, status.hasPrefix("HTTP/1."), status.split(separator: " ").dropFirst().first == "200" else { return nil }
        var fields: [String: String] = [:]
        for l in lines.dropFirst() {
            guard let c = l.firstIndex(of: ":") else { continue }
            fields[l[..<c].lowercased()] = l[l.index(after: c)...].trimmingCharacters(in: .whitespaces)
        }
        let rest = Array(b[(end + 4)...])
        if let n = fields["content-length"].flatMap({ Int($0) }) { return rest.count >= n ? Array(rest.prefix(n)) : nil }
        if fields["transfer-encoding"]?.lowercased().contains("chunked") == true {
            var out = [UInt8](), i = 0
            while true {
                guard let e = (i..<max(i, rest.count - 1)).first(where: { rest[$0] == 13 && rest[$0 + 1] == 10 }),
                      let size = Int(String(decoding: rest[i..<e], as: UTF8.self).split(separator: ";").first ?? "", radix: 16) else { return nil }
                if size == 0 { return out }
                let start = e + 2
                guard rest.count >= start + size + 2 else { return nil }
                out += rest[start..<(start + size)]
                i = start + size + 2
            }
        }
        return ended ? rest : nil
    }
}
