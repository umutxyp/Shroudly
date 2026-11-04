import Foundation
import ShroudlyNative

/*
 * Runs shroudly-core, the engine the desktop and Android run (core/), inside
 * the packet tunnel's process: shroudly_engine_run() (Native/engine_glue.c)
 * on a thread of its own, for as long as the engine runs.
 *
 * It is driven as the desktop drives the program: commands go in on one pipe
 * (STATS, STOP), JSON lines come out on another. The run returns once the
 * engine has stopped, on STOP or when the command pipe is closed. A run that
 * hangs cannot be ended from outside; stop() says whether it ended.
 *
 * One Engine object is one run (Engine.kt): start() it once, and make a new
 * one for a restart.
 */
final class Engine {
    static let startTimeout: TimeInterval = 6
    /* How long a run told to stop may take to return. */
    static let stopWait: TimeInterval = 5

    private enum State { case starting, up, over }

    private let log: (String) -> Void
    /* Lines that can name sites: kept out of the log file. */
    private let logSite: (String) -> Void
    /* The engine ended on its own after a successful start(), with its exit
     * code. Not called for a start that failed, nor after stop(). */
    private let onExit: (Int32) -> Void

    private let lock = NSLock()
    private var state = State.starting
    private var commands: FileHandle?
    private let ready = DispatchSemaphore(value: 0)
    private let finished = DispatchSemaphore(value: 0)
    private var started = false
    /* The user's own server failed (the engine says so now and then). */
    var onUpstreamDown: ((String?) -> Void)?
    /* The last way out (--fallback-file, TorRoute): a name it carried (true,
     * the name), or nothing listening there (false, the engine's why). */
    var onFallback: ((Bool, String) -> Void)?
    /* The engine's verdict on a fetched ad list (ADBLOCK-CHECK): ok, error. */
    var onAdblockCheck: ((Bool, String?) -> Void)?
    private(set) var lastError: String?
    /* What the run returned; nil while it runs. */
    private(set) var exitCode: Int32?
    /* The last STATS line, as it came. */
    private(set) var lastStats: [String: Any]?
    /* When it last wrote anything. */
    private(set) var lastOutputAt = Date()

    init(log: @escaping (String) -> Void, logSite: @escaping (String) -> Void, onExit: @escaping (Int32) -> Void) {
        self.log = log
        self.logSite = logSite
        self.onExit = onExit
    }

    /* The run has not returned. */
    var running: Bool {
        lock.lock(); defer { lock.unlock() }
        return started && exitCode == nil
    }

    /* Starts the engine and waits for its ready line. false (with lastError)
     * if it did not come up; it was then told to stop. */
    func start(args: [String]) -> Bool {
        precondition(!started, "one start per Engine")
        started = true
        log("Starting engine: \(EngineArgs.shown(args))")

        var cmd: [Int32] = [-1, -1]
        var ev: [Int32] = [-1, -1]
        guard pipe(&cmd) == 0 else { return fail("no pipe for the engine") }
        guard pipe(&ev) == 0 else {
            close(cmd[0]); close(cmd[1])
            return fail("no pipe for the engine")
        }
        // The engine's ends belong to the native side from here on.
        let cmdRead = cmd[0], evWrite = ev[1]
        commands = FileHandle(fileDescriptor: cmd[1], closeOnDealloc: true)
        let events = FileHandle(fileDescriptor: ev[0], closeOnDealloc: true)

        let run = Thread { [self] in
            let code = Engine.run(args, cmdRead, evWrite)
            lock.lock()
            exitCode = code
            if code == SHROUDLY_ENGINE_BUSY { lastError = "another engine run has not returned" }
            lock.unlock()
            finished.signal()
        }
        run.name = "engine"
        run.stackSize = 512 * 1024
        run.start()

        let reader = Thread { [self] in
            readEvents(events)
            // The event pipe closes when the run returns, a moment before
            // the thread itself ends.
            _ = finished.wait(timeout: .now() + Engine.stopWait)
            finished.signal()
            ready.signal()
            closeCommands()
            lock.lock()
            let wasUp = state == .up
            state = .over
            let code = exitCode ?? -1
            lock.unlock()
            // Only an engine that had come up and was not stopped on
            // purpose is reported; a start that failed is start()'s to report.
            if wasUp { onExit(code) }
        }
        reader.name = "engine-out"
        reader.start()

        let came = ready.wait(timeout: .now() + Engine.startTimeout) == .success && running
        lock.lock()
        let up = came && state == .starting
        if up { state = .up }
        lock.unlock()
        if up { return true }
        if lastError == nil { lastError = running ? "engine start timeout" : "engine exited (code \(exitCode ?? -1))" }
        if !stop() { lastError = (lastError ?? "") + "; the engine did not stop either" }
        return false
    }

    func send(_ command: String) {
        lock.lock(); defer { lock.unlock() }
        guard let h = commands else { return }
        // A closed pipe raises nothing here: SIGPIPE is ignored in this process (plat_init).
        _ = try? h.write(contentsOf: Data((command + "\n").utf8))
    }

    /* Asks it to stop (STOP, then the end of the command pipe, which stops it
     * even if it cannot read STOP) and waits for the run to return. false if
     * it did not within wait seconds. */
    @discardableResult
    func stop(wait: TimeInterval = Engine.stopWait) -> Bool {
        lock.lock(); state = .over; lock.unlock()
        send("STOP")
        closeCommands()
        guard started else { return true }
        if exitCode != nil { return true }
        if finished.wait(timeout: .now() + wait) == .success {
            finished.signal()
            return true
        }
        return !running
    }

    private func fail(_ why: String) -> Bool {
        lastError = why
        lock.lock(); state = .over; exitCode = -1; lock.unlock()
        return false
    }

    private func closeCommands() {
        lock.lock(); defer { lock.unlock() }
        guard let h = commands else { return }
        commands = nil
        try? h.close()
    }

    private func readEvents(_ events: FileHandle) {
        var pending = Data()
        while true {
            let chunk = events.availableData
            if chunk.isEmpty { break }
            lastOutputAt = Date()
            pending.append(chunk)
            while let nl = pending.firstIndex(of: 0x0a) {
                let line = String(decoding: pending[pending.startIndex..<nl], as: UTF8.self)
                pending.removeSubrange(pending.startIndex...nl)
                handle(line.trimmingCharacters(in: .whitespaces))
            }
        }
        try? events.close()
    }

    private func handle(_ line: String) {
        guard !line.isEmpty else { return }
        guard let obj = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
              let type = obj["type"] as? String else {
            // Free text can name sites.
            logSite("engine: \(line)")
            return
        }
        switch type {
        case "ready":
            ready.signal()
        case "error":
            lastError = obj["msg"] as? String ?? line
            log("engine: \(line)")
        case "stats":
            lock.lock(); lastStats = obj; lock.unlock()
        case "stopped":
            log("engine: stopped")
        case "adblock_check":
            onAdblockCheck?(obj["ok"] as? Bool == true, obj["error"] as? String)
        case "adblock":
            // Counts and an error word, never a name.
            log("engine: \(line)")
        case "upstream":
            // The user's own server could not be used ("why": the engine's words).
            let why = obj["why"] as? String
            log("engine: own server: \(why ?? "?")")
            onUpstreamDown?(why)
        case "fallback":
            let ok = (obj["ok"] as? NSNumber)?.intValue == 1
            if ok { logSite("engine: \(line)") } else { log("engine: last way out: \(obj["why"] as? String ?? "?")") }
            onFallback?(ok, ok ? (obj["host"] as? String ?? "") : (obj["why"] as? String ?? ""))
        default:
            // Events about one site (bypass, blocked, seen...) name it.
            logSite("engine: \(line)")
        }
    }

    /* The C call, with the arguments as C strings for its duration. */
    private static func run(_ args: [String], _ cmdFd: Int32, _ evFd: Int32) -> Int32 {
        var cArgs: [UnsafePointer<CChar>?] = args.map { UnsafePointer(strdup($0)) }
        defer { for p in cArgs { free(UnsafeMutablePointer(mutating: p)) } }
        return cArgs.withUnsafeMutableBufferPointer { buf in
            shroudly_engine_run(buf.baseAddress, Int32(args.count), cmdFd, evFd)
        }
    }

    /* A port free on 127.0.0.1 right now. The engine may still lose it to
     * someone else before it binds; the caller then tries another. */
    static func freePort() -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return 0 }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let ok = withUnsafeMutablePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, len) == 0 && getsockname(fd, $0, &len) == 0
            }
        }
        return ok ? Int(UInt16(bigEndian: addr.sin_port)) : 0
    }
}
