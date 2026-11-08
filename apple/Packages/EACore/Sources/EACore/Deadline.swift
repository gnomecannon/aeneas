import Foundation

/// The first of a piece of work and a deadline: the work's answer when it comes in time, else `otherwise`.
/// The work is not cancelled when the deadline wins, so an assistant answer that Siri could not wait for still
/// arrives and is kept.
public enum Deadline {
    public static func answer<T>(within seconds: TimeInterval, otherwise: T, _ work: @escaping @Sendable () async -> T) async -> T {
        await withCheckedContinuation { (cont: CheckedContinuation<T, Never>) in
            let once = Once()
            Task {
                let v = await work()
                if once.claim() { cont.resume(returning: v) }
            }
            Task {
                try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
                if once.claim() { cont.resume(returning: otherwise) }
            }
        }
    }
}

private final class Once: @unchecked Sendable {
    private var done = false
    private let lock = NSLock()

    func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}
