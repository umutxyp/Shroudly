import Foundation

/* The little of the DNS wire format the encrypted DNS forwarder needs (the
 * Android app's Dns.kt). */
enum Dns {
    /* The option that makes a refusal the forwarder's "no route" (core/src/doh.h). */
    static let noRouteOpt = 65001

    private static func u16(_ m: [UInt8], _ p: Int) -> Int { Int(m[p]) << 8 | Int(m[p + 1]) }

    /* Where the single question of a message ends (after QTYPE and QCLASS),
     * or -1 if there is not exactly one well-formed question. */
    static func questionEnd(_ m: [UInt8]) -> Int {
        guard m.count >= 17, u16(m, 4) == 1 else { return -1 }
        var p = 12
        while true {
            if p >= m.count { return -1 }
            let l = Int(m[p])
            if l == 0 { p += 1; break }
            if l & 0xc0 != 0 { return -1 }          // no compression in a question
            p += 1 + l
        }
        return p + 4 <= m.count ? p + 4 : -1
    }

    /* A standard query (QR clear, opcode 0) with one question. */
    static func isQuery(_ m: [UInt8]) -> Bool {
        guard m.count >= 17, m.count <= 4096 else { return false }
        let flags = Int(m[2])
        if flags & 0x80 != 0 { return false }        // a response, not a query
        if (flags >> 3) & 0x0f != 0 { return false } // opcode QUERY only
        return questionEnd(m) > 0
    }

    /* The answer, if it is the response to this query: QR set and the same
     * question (names compared without case). Its ID is set to the query's,
     * whatever the resolver put there. nil otherwise. */
    static func matchAnswer(query: [UInt8], answer: [UInt8]) -> [UInt8]? {
        let qEnd = questionEnd(query)
        guard qEnd > 0, answer.count >= qEnd, answer[2] & 0x80 != 0, questionEnd(answer) == qEnd else { return nil }
        for i in 12..<qEnd where query[i] != answer[i] && lower(query[i]) != lower(answer[i]) { return nil }
        var out = answer
        out[0] = query[0]
        out[1] = query[1]
        return out
    }

    private static func lower(_ c: UInt8) -> UInt8 { (65...90).contains(c) ? c + 32 : c }

    /* "No route" for this query, as the desktop's and Android's forwarders
     * send it: encrypted DNS has no answer for now, so the engine asks plain
     * DNS at once instead of waiting seconds for one. REFUSED with an OPT
     * record carrying noRouteOpt. nil if the question cannot be read. */
    static func noRouteReply(_ query: [UInt8]) -> [UInt8]? {
        let end = questionEnd(query)
        guard end > 0 else { return nil }
        var out = Array(query[0..<end])
        out[2] = 0x80 | (query[2] & 0x79)   // a response; opcode, RD kept
        out[3] = 0x85                       // RA, REFUSED
        for i in 6..<12 { out[i] = 0 }
        out[11] = 1                         // one additional record: the OPT
        // Its name (the root), OPT, a 1232-byte payload size, no extended
        // code or flags, and one option with no data.
        out += [0, 0, 41, 0x04, 0xd0, 0, 0, 0, 0, 0, 4, UInt8(noRouteOpt >> 8), UInt8(noRouteOpt & 0xff), 0, 0]
        return out
    }

    /* Name and type of the question, for tests. */
    static func question(_ m: [UInt8]) -> (name: String, type: Int)? {
        let end = questionEnd(m)
        guard end > 0 else { return nil }
        var parts: [String] = []
        var p = 12
        while m[p] != 0 {
            let l = Int(m[p])
            parts.append(String(decoding: m[(p + 1)...(p + l)], as: UTF8.self).lowercased())
            p += 1 + l
        }
        return (parts.joined(separator: "."), u16(m, end - 4))
    }

    /* A query for name (type A unless given), with this ID. */
    static func query(_ name: String, type: Int = 1, id: UInt16 = 0x1234) -> [UInt8] {
        var m: [UInt8] = [UInt8(id >> 8), UInt8(id & 0xff), 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]
        for label in name.split(separator: ".") {
            let b = Array(label.utf8)
            m.append(UInt8(b.count))
            m += b
        }
        m += [0, UInt8(type >> 8), UInt8(type & 0xff), 0, 1]
        return m
    }

    /* The IPv4 addresses among the answers. */
    static func addressesV4(_ m: [UInt8]) -> [String] {
        var p = questionEnd(m)
        guard p > 0, m.count >= 12 else { return [] }
        var out: [String] = []
        for _ in 0..<u16(m, 6) {
            // The name: a pointer, or labels up to the root.
            while p < m.count {
                let l = Int(m[p])
                if l & 0xc0 == 0xc0 { p += 2; break }
                p += 1 + l
                if l == 0 { break }
            }
            guard p + 10 <= m.count else { return out }
            let type = u16(m, p), len = u16(m, p + 8)
            p += 10
            guard p + len <= m.count else { return out }
            if type == 1 && len == 4 { out.append(m[p..<(p + 4)].map(String.init).joined(separator: ".")) }
            p += len
        }
        return out
    }
}
