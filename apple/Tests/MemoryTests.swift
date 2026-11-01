import XCTest

/* The engine's memory with the tunnel's full load of busy connections: iOS
 * ends a packet tunnel past about 50 MB (Shared/TunnelConfig.swift). */
final class MemoryTests: XCTestCase {
    private func footprint() -> Int {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return kr == KERN_SUCCESS ? Int(info.phys_footprint) : 0
    }

    func testFullLoadOfConnections() throws {
        let echo = try EchoServer()
        defer { echo.stop() }
        let e = try TestEngine()
        defer { e.engine.stop() }
        let before = footprint()
        var fds: [Int32] = []
        defer { fds.forEach { close($0) } }
        let chunk = [UInt8](repeating: 0x41, count: 32 * 1024)
        for _ in 0..<TunnelConfig.maxSessions {
            let (fd, code) = TestNet.socks(e.port, user: e.auth.user, pass: e.auth.pass, to: .ipv4("127.0.0.1"), echo.port)
            XCTAssertEqual(code, 0)
            fds.append(fd)
            TestNet.send(fd, chunk)
            XCTAssertEqual(TestNet.recv(fd, chunk.count).count, chunk.count)
        }
        let grew = footprint() - before
        print("[memory] \(fds.count) connections through the engine: +\(grew / 1024) KB")
        // About 140 KB a connection, every buffer in use (this process's echo
        // server's threads included): well under the tunnel's limit.
        XCTAssertLessThan(grew, 32 * 1024 * 1024)
    }
}
