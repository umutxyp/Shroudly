import Foundation
import HevSocks5Tunnel

/*
 * hev-socks5-tunnel in the packet tunnel's process: it reads the tunnel's
 * packets straight from its utun descriptor, turns apps' TCP and UDP back
 * into connections and hands them to the engine's SOCKS5 port, and answers
 * DNS with stand-in addresses (TunnelConfig). hev_socks5_tunnel_main_from_str
 * runs on a thread of its own until hev_socks5_tunnel_quit(); hev keeps its
 * state in globals, so one at a time.
 */
final class Hev {
    static let stopWait: TimeInterval = 5

    private let finished = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var thread: Thread?
    private var result: Int32?

    var running: Bool {
        lock.lock(); defer { lock.unlock() }
        return thread != nil && result == nil
    }

    /* Starts hev with these settings on the descriptor. false when it ended
     * at once (a bad setting, a bad descriptor). */
    func start(config: String, tunFd: Int32) -> Bool {
        precondition(thread == nil, "one start per Hev")
        let bytes = Array(config.utf8)
        let t = Thread { [self] in
            let rc = bytes.withUnsafeBufferPointer {
                hev_socks5_tunnel_main_from_str($0.baseAddress, UInt32($0.count), tunFd)
            }
            lock.lock(); result = rc; lock.unlock()
            finished.signal()
        }
        t.name = "hev"
        t.stackSize = 512 * 1024
        lock.lock(); thread = t; lock.unlock()
        t.start()
        // A bad setting ends its thread at once; better to know now than to
        // say "Protected" over a dead tunnel.
        if finished.wait(timeout: .now() + 0.2) == .success {
            finished.signal()
            return false
        }
        return true
    }

    /* Tells it to quit and waits for its thread. The descriptor stays open. */
    @discardableResult
    func stop() -> Bool {
        guard thread != nil else { return true }
        if !running { return true }
        hev_socks5_tunnel_quit()
        if finished.wait(timeout: .now() + Hev.stopWait) == .success {
            finished.signal()
            return true
        }
        return false
    }

    /* Packets and bytes out of and into the tunnel. */
    func stats() -> (txPackets: Int, txBytes: Int, rxPackets: Int, rxBytes: Int) {
        var a = 0, b = 0, c = 0, d = 0
        hev_socks5_tunnel_stats(&a, &b, &c, &d)
        return (a, b, c, d)
    }
}
