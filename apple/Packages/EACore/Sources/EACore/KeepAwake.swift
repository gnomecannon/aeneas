import Foundation

/// Keeps the app running while a piece of work finishes after the system would otherwise suspend it: an answer Siri
/// stopped waiting for, or a Watch request the iPhone relays while it is locked. On the iPhone and the Watch this
/// holds an expiring background assertion, which the system still ends after its own limit (about 30 s); the Mac
/// does not suspend apps this way, so there the work just runs.
public enum KeepAwake {
    public static func during<T>(_ reason: String, _ work: @escaping @Sendable () async -> T) async -> T {
        #if os(iOS) || os(watchOS)
        let hold = Hold()
        // The block keeps the assertion for as long as it has not returned; it is called again with expired = true
        // when time is up, which lets the first call return.
        ProcessInfo.processInfo.performExpiringActivity(withReason: reason) { expired in
            if expired { hold.release() } else { hold.wait() }
        }
        let value = await work()
        hold.release()
        return value
        #else
        return await work()
        #endif
    }
}

private final class Hold: @unchecked Sendable {
    private let done = DispatchSemaphore(value: 0)
    func wait() { done.wait() }
    func release() { done.signal() }
}

/// One question and its answer in an assistant chat, as the Watch shows them.
public struct ChatTurn: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var q: String
    public var a: String
    public init(id: String = UUID().uuidString, q: String, a: String) { self.id = id; self.q = q; self.a = a }

    /// The turns of a chat stored on the hub: each question with the answer that followed it. A question still
    /// waiting for its answer is left out, and a change waiting for approval is pointed at `approveOn`.
    public static func turns(of s: AISession, approveOn: String = "your iPhone") -> [ChatTurn] {
        var out: [ChatTurn] = []
        var question: String?
        for (i, m) in s.messages.enumerated() {
            switch m.role {
            case .user: question = m.content
            case .assistant:
                guard let q = question, !m.content.isEmpty else { continue }
                out.append(ChatTurn(id: "\(s.session_id):\(i)", q: q, a: m.content))
                question = nil
            case .system: continue
            }
        }
        if s.pending_action != nil, var last = out.popLast() {
            last.a += "\n\nApprove or decline this on \(approveOn)."
            out.append(last)
        }
        return out
    }
}

public extension HubClient {
    /// The answer to `question` once the hub has finished it, for when the reply to the chat request itself was lost
    /// while the hub went on answering: the iPhone's request reached its limit, or WatchConnectivity stopped waiting
    /// for the relayed reply. The hub stores a question as it starts on it and marks the chat `working` until the
    /// answer is in, so this reads the chat every `every` seconds until it is done. Nil when the question is not the
    /// chat's latest (it never reached the hub), the hub cannot be asked, the hub failed, or `wait` ran out.
    func lateAnswer(to question: String, session: String, askedAt: Date, approveOn: String = "your iPhone",
                    wait: TimeInterval = 600, every: TimeInterval = 4) async -> ChatTurn? {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        let until = Date().addingTimeInterval(wait)
        while true {
            guard let s = try? await aiSession(session) else { return nil }
            // The hub's latest question must be this one, asked now: the same words asked earlier in the day already
            // have their answer, and this one may never have arrived. Two minutes allow for clocks that differ.
            guard let u = s.messages.lastIndex(where: { $0.role == .user }),
                  s.messages[u].content.trimmingCharacters(in: .whitespacesAndNewlines) == q,
                  (ISO.date(s.messages[u].at) ?? askedAt) >= askedAt.addingTimeInterval(-120) else { return nil }
            if s.working == nil {
                guard let i = s.messages.indices.first(where: { $0 > u && s.messages[$0].role == .assistant && !s.messages[$0].content.isEmpty })
                else { return nil }
                var answer = s.messages[i].content
                if s.pending_action != nil { answer += "\n\nApprove or decline this on \(approveOn)." }
                return ChatTurn(id: "\(s.session_id):\(i)", q: q, a: answer)
            }
            guard Date() < until, !Task.isCancelled else { return nil }
            try? await Task.sleep(nanoseconds: UInt64(every * 1_000_000_000))
            // Cancelled while waiting (the reply itself came first): no further read.
            if Task.isCancelled { return nil }
        }
    }
}

/// A chat's answer: the reply to the request itself, or the answer read from the chat on the hub.
public enum ChatAnswer: Sendable {
    case reply(ChatResponse)
    case late(ChatTurn)
}

public extension HubClient {
    /// The chat's answer, whichever way comes first: the reply to the request, or, once `pollAfter` has passed, the
    /// answer read from the chat on the hub when the hub has it. On the Watch the request goes through the iPhone,
    /// which iOS suspends about 30 s after a locked iPhone is woken for it, so a slower reply can sit there for
    /// minutes while the hub has long finished. A request that fails still gets the read before its error is thrown.
    func chatOrLate(_ req: ChatRequest, askedAt: Date = Date(), approveOn: String = "your iPhone",
                    pollAfter: TimeInterval = 45, every: TimeInterval = 5, wait: TimeInterval = 600) async throws -> ChatAnswer {
        let q = req.message ?? ""
        let first = FirstOf<Result<ChatAnswer, Error>>()
        Task {
            do { first.offer(.success(.reply(try await self.chat(req)))) }
            catch {
                if let t = await self.lateAnswer(to: q, session: req.session_id, askedAt: askedAt, approveOn: approveOn, wait: wait, every: every) {
                    first.offer(.success(.late(t)))
                } else { first.offer(.failure(error)) }
            }
        }
        let poll = Task {
            try? await Task.sleep(nanoseconds: UInt64(pollAfter * 1_000_000_000))
            guard !Task.isCancelled else { return }
            // Nil (the hub failed, or cannot be asked): the request's own result decides.
            if let t = await self.lateAnswer(to: q, session: req.session_id, askedAt: askedAt, approveOn: approveOn, wait: wait, every: every) {
                first.offer(.success(.late(t)))
            }
        }
        let result = await first.value
        poll.cancel()
        return try result.get()
    }
}

/// The first value offered wins; later offers are dropped. Waits until there is one.
final class FirstOf<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var held: T?
    private var waiter: CheckedContinuation<T, Never>?

    func offer(_ v: T) {
        lock.lock()
        guard held == nil else { lock.unlock(); return }
        held = v
        let w = waiter
        waiter = nil
        lock.unlock()
        w?.resume(returning: v)
    }

    var value: T {
        get async {
            await withCheckedContinuation { (c: CheckedContinuation<T, Never>) in
                lock.lock()
                if let v = held { lock.unlock(); c.resume(returning: v) } else { waiter = c; lock.unlock() }
            }
        }
    }
}
