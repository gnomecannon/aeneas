import Foundation
import EACore
import IrohLib

/// Set up on a Mac or iPad (CONTRACT.md, Devices, Joining with a phone's yes): an iroh endpoint of this device's own,
/// separate from the one that reaches a hub, waiting for the hub of a phone that scanned this device's QR code. That hub
/// proves with the secret in the code that the phone sent it, and hands this device a pairing link. n0's default relays
/// and no lookup service: the hub finds this device through the relay the code names.
public actor JoinListener {
    public enum Event: Sendable, Equatable {
        /// What the QR code holds now: this device's key, its home relay and the secret (a new one every 5 minutes).
        case ready(node: String, relay: String, secret: String)
        /// A hub proved it came from the phone that scanned the code, and this device answered yes: pair with this link.
        case joined(SetupLink)
        /// The endpoint could not start or reach a relay, in plain words.
        case failed(String)
    }

    static let alpn = Data("aeneas/join/1".utf8)
    static let rotateEvery: TimeInterval = 300
    /// After a new secret the one before it still counts this long, so a scan just before the change works while the
    /// person reads the phone's question (CONTRACT.md).
    static let grace: TimeInterval = 120
    /// Hubs answered at once; more wait for the next try. Only a hub that proves the secret gets anything.
    static let maxAtOnce = 4

    private var endpoint: Endpoint?
    private var node = ""
    private var relay = ""
    private var secret = JoinSecret.make()
    private var previous: (secret: Data, replaced: Date)?
    private var taken = false
    private var stopped = false
    private var handling = 0
    private var rotation: Task<Void, Never>?
    private var continuation: AsyncStream<Event>.Continuation?

    public init() {}

    /// Starts the endpoint. Events arrive until `stop()`, or until whoever reads them stops (Set up went away).
    public nonisolated func events() -> AsyncStream<Event> {
        AsyncStream { cont in
            cont.onTermination = { _ in Task { await self.stop() } }
            Task { await self.run(cont) }
        }
    }

    /// Closes the endpoint; no join is taken after it.
    public func stop() async {
        guard !stopped else { return }
        stopped = true
        rotation?.cancel()
        continuation?.finish()
        continuation = nil
        if let ep = endpoint {
            endpoint = nil
            _ = try? await IrohDeadline.run(5) { try await ep.close() }
        }
    }

    private func emit(_ e: Event) { continuation?.yield(e) }

    private func run(_ cont: AsyncStream<Event>.Continuation) async {
        continuation = cont
        guard !stopped else { cont.finish(); return }
        do {
            let ep = try await IrohDeadline.run(20) { () async throws -> Endpoint in
                let b = EndpointBuilder()
                // Minimal, then n0's relays: applyN0 would also turn on a lookup service, which publishes this device.
                b.applyMinimal()
                b.relayMode(mode: RelayMode.defaultMode())
                b.alpns(alpns: [JoinListener.alpn])
                return try await b.bind()
            }
            guard !stopped else { _ = try? await IrohDeadline.run(5) { try await ep.close() }; return }
            endpoint = ep
            // The hub reaches this device only through its home relay, so the code waits for one.
            try await IrohDeadline.run(20) { await ep.online() }
            guard let r = await Self.homeRelay(ep) else { throw IrohDeadline.TimedOut() }
            node = Self.hex(ep.id().toBytes())
            relay = r
            guard DirectHub.validKey(node) else { throw IrohDeadline.TimedOut() }
        } catch {
            if !stopped {
                emit(.failed("This device could not reach the Direct link relay to show a code. Check that it is online, then try again."))
                await stop()
            }
            return
        }
        emit(.ready(node: node, relay: relay, secret: JoinSecret.encode(secret)))
        rotation = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(JoinListener.rotateEvery * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await self?.rotate()
            }
        }
        guard let ep = endpoint else { return }
        // acceptNext ends with nil once the endpoint is closed (stop()).
        Task.detached { [weak self] in
            while let incoming = await ep.acceptNext() {
                guard let self else { try? await incoming.refuse(); return }
                Task { await self.handle(incoming) }
            }
        }
    }

    /// A new secret (and QR code); the one before it still counts for 2 minutes.
    private func rotate() async {
        guard !stopped, !taken, let ep = endpoint else { return }
        previous = (secret, Date())
        secret = JoinSecret.make()
        // The home relay can move to a closer one while Set up stays open.
        if let r = ep.addr().relayUrl(), DirectHub.validRelay(r) { relay = r }
        emit(.ready(node: node, relay: relay, secret: JoinSecret.encode(secret)))
    }

    private var secrets: [Data] { Self.secrets(current: secret, previous: previous, now: Date()) }

    /// The secrets a proof may be made with: the one on screen, and the one before it until `grace` after it was replaced.
    static func secrets(current: Data, previous: (secret: Data, replaced: Date)?, now: Date) -> [Data] {
        guard let p = previous, now.timeIntervalSince(p.replaced) < grace else { return [current] }
        return [current, p.secret]
    }

    private func handle(_ incoming: Incoming) async {
        // After a yes a hub still gets a sentence (already joined), which the phone shows, rather than a refusal.
        guard !stopped, handling < Self.maxAtOnce else { try? await incoming.refuse(); return }
        handling += 1
        defer { handling -= 1 }
        let conn: Connection
        let bi: BiStream
        let data: Data
        do {
            conn = try await IrohDeadline.run(20) { try await incoming.accept().connect() }
            bi = try await IrohDeadline.run(20) { try await conn.acceptBi() }
            data = try await IrohDeadline.run(20) { try await bi.recv().readToEnd(sizeLimit: 16 * 1024) }
        } catch {
            // Someone who connected and sent nothing, or went away: keep waiting for the phone's hub.
            return
        }
        let remote = Self.hex(conn.remoteId().toBytes())
        // Checked and taken with no wait in between, so two hubs at once cannot both be answered yes.
        let outcome: JoinCheck.Outcome = stopped || taken
            ? .refused(JoinCheck.alreadyJoined)
            : JoinCheck.check(data, remoteKey: remote, node: node, secrets: secrets)
        if case .accepted = outcome { taken = true; rotation?.cancel() }
        switch outcome {
        case .accepted(let link):
            await Self.answer(bi.send(), JoinCheck.answer(ok: true))
            emit(.joined(link))
        case .refused(let why):
            await Self.answer(bi.send(), JoinCheck.answer(ok: false, error: why))
            try? conn.close(errorCode: 0, reason: Data())
        }
    }

    /// Writes the answer and waits (a few seconds at most) until the hub has it, so closing the endpoint after a yes
    /// cannot cut it off.
    private static func answer(_ send: SendStream, _ body: Data) async {
        _ = try? await IrohDeadline.run(10) { try await send.writeAll(buf: body); try await send.finish() }
        _ = try? await IrohDeadline.run(5) { try await send.stopped() }
    }

    /// The home relay once the endpoint has one: asked a few times, since it is set just after `online()`.
    private static func homeRelay(_ ep: Endpoint) async -> String? {
        for _ in 0..<10 {
            if let r = ep.addr().relayUrl(), DirectHub.validRelay(r) { return r }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        return nil
    }

    /// A Direct link key as the hub and links write it: 64 lowercase hex characters.
    static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
}

/// iroh's calls cannot be cancelled from Swift (the binding has no cancellation), so a timer in a task group would still
/// wait for them to end. This answers with whichever comes first and leaves the call to end when its endpoint closes.
enum IrohDeadline {
    struct TimedOut: Error {}

    static func run<T>(_ seconds: Double, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<T, Error>) in
            let once = Once()
            let timer = Task {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                if !Task.isCancelled, once.claim() { cont.resume(throwing: TimedOut()) }
            }
            Task {
                do {
                    let v = try await work()
                    if once.claim() { timer.cancel(); cont.resume(returning: v) }
                } catch {
                    if once.claim() { timer.cancel(); cont.resume(throwing: error) }
                }
            }
        }
    }

    /// True for the first caller only.
    final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false
        func claim() -> Bool {
            lock.lock(); defer { lock.unlock() }
            if done { return false }
            done = true
            return true
        }
    }
}
