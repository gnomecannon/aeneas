import Foundation
import os
#if canImport(WatchConnectivity)
import WatchConnectivity

/// WatchConnectivity session owner.
/// iPhone: answers relayed hub requests from the Watch with the phone's own hub URL and token.
/// Watch: sends `RelayRequest` envelopes and awaits `RelayResponse`. Relayed requests are not queued on
/// the phone side; the Watch keeps its own outbox and retries. Answers too big for one message come back
/// compressed, in parts (see `RelayParts`). Hums are the exception: they go as file transfers and wait in
/// `WatchHumQueue` on each side (see `WatchHum`).
public final class WatchLink: NSObject, WCSessionDelegate, @unchecked Sendable {
    public static let shared = WatchLink()
    private static let log = Logger(subsystem: SharedConfig.logSubsystem, category: "watchlink")

    /// Called on the main thread when activation or reachability changes.
    public var onStateChanged: (() -> Void)?

    #if os(watchOS)
    /// Watch side, on the main thread: the iPhone has the hum with this id.
    public var onHumDelivered: ((String) -> Void)?
    /// Watch side, on the main thread: how the iPhone and the hub got on with a hum.
    public var onHumResult: ((WatchHumResult) -> Void)?
    #endif

    #if os(iOS)
    /// Phone side, on the main thread: a hum from the Watch is in `WatchHumQueue.local`, ready to send to the hub.
    public var onHumReceived: (() -> Void)?
    /// iPhone, main thread: the hub answered a question the Watch asked from its screen after the Watch app left it
    /// (the wrist went down while the assistant worked), so the reply may never be shown there. The app posts it as a
    /// notification, which the Watch shows while the iPhone is locked.
    public var onUnheardAnswer: ((_ question: String, _ answer: String, _ session: String) -> Void)?
    /// Phone side: the hub transport for a Watch request carrying `key` (the Watch's own, see `WatchKeys`).
    public var transportProvider: (_ key: String) -> HubTransport? = { key in
        HTTPTransport.make(urlString: SharedConfig.shared.hubURL, token: key, pin: SharedConfig.shared.hubPin)
    }
    /// Phone side: whether a Watch is paired and has the app (the iPhone then keeps a key for it).
    public var hasPairedWatch: Bool { (session?.isPaired ?? false) && (session?.isWatchAppInstalled ?? false) }
    /// Phone side: the name the Watch registers with.
    public var watchDeviceName: () -> String = { SharedConfig.shared.deviceName + " Watch" }
    /// Phone side: answers too big for one message, until the Watch has fetched their parts.
    private let partStore = RelayPartStore()
    #endif

    // Diagnostics, readable on both sides and shown on the Watch. Relays run at once on several threads (and on
    // WatchConnectivity's queue), so they are kept under a lock: two failing at once could free the same string twice.
    private struct Diag { var error: String?; var errorAt: Date?; var status: Int?; var at: Date?; var count = 0 }
    private var diag = Diag()
    private let diagLock = NSLock()
    public var lastRelayError: String? { diagLock.withLock { diag.error } }
    public var lastRelayErrorAt: Date? { diagLock.withLock { diag.errorAt } }
    public var lastRelayStatus: Int? { diagLock.withLock { diag.status } }
    public var lastRelayAt: Date? { diagLock.withLock { diag.at } }
    public var relayCount: Int { diagLock.withLock { diag.count } }
    private func countRelay() { diagLock.withLock { diag.count += 1 } }
    private func noteReply(_ status: Int) { diagLock.withLock { diag.at = Date(); diag.status = status } }

    public var isSupported: Bool { WCSession.isSupported() }
    private var session: WCSession? { WCSession.isSupported() ? WCSession.default : nil }
    public var isReachable: Bool { session?.isReachable ?? false }
    public var isActivated: Bool { session?.activationState == .activated }

    public var activationStateLabel: String {
        switch session?.activationState {
        case .activated: return "activated"
        case .inactive: return "inactive"
        case .notActivated: return "not activated"
        default: return "unsupported"
        }
    }

    /// Everything the Watch diagnostics sheet shows; also what gets sent to the hub later.
    public var diagnostics: [String: String] {
        var d: [String: String] = [
            "activation": activationStateLabel,
            "isReachable": isReachable ? "true" : "false",
            "relayCount": String(relayCount),
            "lastRelayStatus": lastRelayStatus.map(String.init) ?? "",
            "lastRelayAt": lastRelayAt.map { ISO.string($0) } ?? "",
            "lastRelayError": lastRelayError ?? "",
            "lastRelayErrorAt": lastRelayErrorAt.map { ISO.string($0) } ?? ""
        ]
        #if os(watchOS)
        d["isCompanionAppInstalled"] = (session?.isCompanionAppInstalled ?? false) ? "true" : "false"
        #else
        d["isPaired"] = (session?.isPaired ?? false) ? "true" : "false"
        d["isWatchAppInstalled"] = (session?.isWatchAppInstalled ?? false) ? "true" : "false"
        #endif
        return d
    }

    /// Safe to call from the app's init path, including background launches by WatchConnectivity.
    public func activate() {
        guard let s = session else { Self.log.error("WCSession not supported on this device"); return }
        s.delegate = self
        if s.activationState != .activated {
            Self.log.notice("activate requested, state=\(self.activationStateLabel, privacy: .public)")
            s.activate()
        }
    }

    private func recordError(_ message: String) {
        diagLock.withLock { diag.error = message; diag.errorAt = Date() }
        Self.log.error("relay error: \(message, privacy: .public)")
    }

    /// Wait for activation (up to `timeout`) when the session is not active yet.
    private func waitForActivation(timeout: TimeInterval = 3) async {
        guard let s = session, s.activationState != .activated else { return }
        activate()
        let deadline = Date().addingTimeInterval(timeout)
        while s.activationState != .activated, Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    // MARK: Watch side

    #if os(watchOS)

    /// When activation last completed: the iPhone counts as reachable a moment after it, not with it.
    private var activatedAt: Date?

    /// Send one envelope to the phone and wait for the answer. Reachability is not required:
    /// sending from an active Watch app wakes the phone app, and `isReachable` can lag or read false.
    public func relay(_ req: RelayRequest) async throws -> RelayResponse {
        guard let s = session else { recordError("WCSession not supported"); throw HubError.phoneUnreachable }
        await waitForActivation()
        guard s.activationState == .activated else {
            recordError("Session not activated (\(activationStateLabel))")
            throw HubError.phoneUnreachable
        }
        // The first sync starts about 0.1 s after activation and the iPhone becomes reachable about 0.2 s after it;
        // a message sent in between fails at once as not reachable. Within 5 s of activation, wait for it; after a
        // return to the screen (or a Siri run in a suspended app) reachability can lag too, so wait a moment always.
        let deadline = max((activatedAt ?? .distantPast).addingTimeInterval(5), Date().addingTimeInterval(1.5))
        while !s.isReachable, Date() < deadline { try? await Task.sleep(nanoseconds: 100_000_000) }
        let payload = try req.encoded()
        guard payload.count <= RelayHandler.maxWireSize else {
            let m = "Request too large for the Watch relay (\(payload.count / 1024) KB)"
            recordError(m)
            throw HubError.transport(m)
        }
        countRelay()
        Self.log.notice("relay send \(req.method, privacy: .public) \(req.path, privacy: .public) reachable=\(s.isReachable)")
        let data = try await exchange(s, payload)
        var resp: RelayResponse
        do { resp = try RelayResponse.decode(data) } catch {
            recordError("Bad relay reply (\(data.count) bytes)")
            throw HubError.decoding("relay reply")
        }
        if let n = resp.parts {
            // Too big for one message: the iPhone holds the body, compressed, in parts fetched one by one.
            var parts: [Data] = []
            for i in 0..<n { parts.append(try await exchange(s, try RelayRequest.part(of: resp.id, index: i).encoded())) }
            do { resp = try RelayParts.join(resp, parts) } catch {
                let m = (error as? HubError)?.errorDescription ?? "Could not join the parts of the answer"
                recordError("\(req.path): \(m)")
                throw HubError.transport(m)
            }
            Self.log.notice("relay joined \(n) parts \(parts.reduce(0) { $0 + $1.count }) bytes for \(req.path, privacy: .public)")
        }
        noteReply(resp.status)
        if resp.status == 0 {
            recordError(resp.error ?? "Phone could not perform the request")
        } else {
            Self.log.notice("relay reply \(req.path, privacy: .public) status=\(resp.status)")
        }
        return resp
    }

    /// One message to the phone and its reply. A reply that could not come back (too big for WatchConnectivity
    /// before answers went in parts) means the phone was reached, so it is not reported as out of reach.
    private func exchange(_ s: WCSession, _ payload: Data) async throws -> Data {
        do {
            return try await withCheckedThrowingContinuation { (c: CheckedContinuation<Data, Error>) in
                s.sendMessageData(payload, replyHandler: { c.resume(returning: $0) }, errorHandler: { c.resume(throwing: $0) })
            }
        } catch {
            let code = (error as? WCError)?.code
            let message = "\(error.localizedDescription) (code \((error as NSError).code))"
            recordError(message)
            switch code {
            case .notReachable, .sessionNotActivated, .companionAppNotInstalled, .sessionInactive:
                throw HubError.phoneUnreachable
            case .messageReplyTimedOut, .deliveryFailed:
                // The iPhone got the message (or was asked) but its answer did not come back: most often iOS suspended
                // a locked iPhone while the hub worked. Not "out of reach".
                throw HubError.transport("Your iPhone did not answer in time (it may have been locked). Try again.")
            default:
                if (error as NSError).domain == NSURLErrorDomain { throw HubError.phoneUnreachable }
                throw HubError.transport(message)
            }
        }
    }

    /// Keeps the recording in the Watch's queue and hands it to WatchConnectivity, which delivers it when the
    /// iPhone is in reach, even after this app has closed. Call on the main thread.
    public func queueHum(_ hum: WatchHum, file: URL) throws {
        try WatchHumQueue.local.add(hum, moving: file)
        sendQueuedHums()
    }

    /// Hands every kept recording that WatchConnectivity is not carrying already to it again: after a failed
    /// transfer, a relaunch, or activation finishing after the recording. Call on the main thread.
    public func sendQueuedHums() {
        guard let s = session else { return }
        guard s.activationState == .activated else { activate(); return }
        let queue = WatchHumQueue.local
        let carrying = Set(s.outstandingFileTransfers.compactMap { WatchHum(metadata: $0.file.metadata)?.id })
        for e in queue.all() where !carrying.contains(e.hum.id) {
            guard queue.hasAudio(e.hum.id) else { queue.remove(e.hum.id); continue }
            Self.log.notice("hum transfer queued \(e.hum.id, privacy: .public) reachable=\(s.isReachable)")
            s.transferFile(queue.audioURL(e.hum.id), metadata: e.hum.metadata)
        }
    }

    public func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        guard let hum = WatchHum(metadata: fileTransfer.file.metadata) else { return }
        if let error {
            // Kept, and sent again at the next launch or when the iPhone comes back in reach rather than at once,
            // so an error that lasts (no iPhone app) does not spin.
            recordError("hum transfer: \(error.localizedDescription)")
            return
        }
        WatchHumQueue.local.remove(hum.id)
        DispatchQueue.main.async { self.onHumDelivered?(hum.id) }
    }

    public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) { receivedHumResult(userInfo) }
    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) { receivedHumResult(message) }

    private func receivedHumResult(_ m: [String: Any]) {
        guard let r = WatchHumResult(message: m) else { return }
        Self.log.notice("hum result \(r.id, privacy: .public) \(r.state.rawValue, privacy: .public)")
        DispatchQueue.main.async { self.onHumResult?(r) }
    }
    #endif

    // MARK: Phone side

    #if os(iOS)
    public func session(_ session: WCSession, didReceiveMessageData messageData: Data, replyHandler: @escaping (Data) -> Void) {
        guard let req = try? RelayRequest.decode(messageData) else {
            recordError("Bad relay envelope from Watch (\(messageData.count) bytes)")
            replyHandler((try? RelayResponse(id: "", status: 0, data: Data(), error: "Bad relay envelope").encoded()) ?? Data())
            return
        }
        if let p = req.partOf {
            // Empty when the part is gone; the Watch then fails this request and its next sync asks again.
            replyHandler(partStore.take(p.id, p.index) ?? Data())
            return
        }
        Self.log.notice("relay received \(req.method, privacy: .public) \(req.path, privacy: .public)")
        let name = watchDeviceName()
        // Whether the Watch app was on screen when it asked: Siri asks with the app in the background and speaks the
        // answer itself, so only an app that was on screen and has left it needs the answer as a notification.
        let askedOnScreen = session.isReachable
        countRelay()
        // A Watch message wakes a locked iPhone only briefly, and an assistant answer can take longer than that:
        // without holding background time the reply was lost even though the hub had answered.
        Task {
            await KeepAwake.during("Relay a Watch request to the hub") {
                // The Watch's own key, never the iPhone's: with a device key the hub acts as that device.
                let key: String
                switch await WatchKeys.shared.credential(watchDeviceId: req.query["device_id"]) {
                case .key(let k): key = k
                case .removed:
                    replyHandler(RelayHandler.reply(RelayResponse(id: req.id, status: 401, data: WatchKeys.removedBody), store: self.partStore))
                    return
                case .unavailable(let why):
                    self.recordError(why)
                    replyHandler((try? RelayResponse(id: req.id, status: 0, data: Data(), error: why).encoded()) ?? Data())
                    return
                }
                guard let transport = self.transportProvider(key) else {
                    self.recordError("iPhone has no hub configured")
                    replyHandler((try? RelayResponse(id: req.id, status: 0, data: Data(), error: "iPhone has no hub configured").encoded()) ?? Data())
                    return
                }
                let resp = await RelayHandler.perform(req, transport: transport, watchDeviceName: name)
                if resp.status == 401, HubClient.error(status: 401, data: resp.bodyData).isDeviceRemoved, key == SharedConfig.shared.watchKey {
                    await WatchKeys.shared.noteRemoved()
                }
                self.noteReply(resp.status)
                if resp.status == 0 { self.recordError("\(req.path): \(resp.error ?? "failed")") }
                else { Self.log.notice("relay reply \(req.path, privacy: .public) status=\(resp.status)") }
                if askedOnScreen, let chat = RelayHandler.answeredChat(req, resp), !(self.session?.isReachable ?? false) {
                    Self.log.notice("relay answer came after the Watch app left the screen: posted as a notification")
                    DispatchQueue.main.async { self.onUnheardAnswer?(chat.question, chat.answer, chat.session) }
                }
                replyHandler(RelayHandler.reply(resp, store: self.partStore))
            }
        }
    }

    public func session(_ session: WCSession, didReceive file: WCSessionFile) {
        guard let hum = WatchHum(metadata: file.metadata) else { return }
        // WatchConnectivity deletes the file when this returns, so it moves into the queue first.
        do {
            let added = try WatchHumQueue.local.add(hum, moving: file.fileURL)
            Self.log.notice("hum received \(hum.id, privacy: .public) new=\(added)")
        } catch {
            recordError("hum from Watch: \(error.localizedDescription)")
            return
        }
        DispatchQueue.main.async { self.onHumReceived?() }
    }

    /// Tells the Watch how a hum went: at once when it is in reach, else queued by WatchConnectivity for when it is.
    public func sendHumResult(_ r: WatchHumResult) async {
        await waitForActivation()
        guard let s = session, s.activationState == .activated, s.isPaired, s.isWatchAppInstalled else {
            Self.log.error("hum result \(r.id, privacy: .public) not sent: no Watch session")
            return
        }
        let m = r.message
        Self.log.notice("hum result \(r.id, privacy: .public) \(r.state.rawValue, privacy: .public) reachable=\(s.isReachable)")
        if s.isReachable {
            s.sendMessage(m, replyHandler: nil) { _ in s.transferUserInfo(m) }
        } else {
            s.transferUserInfo(m)
        }
    }

    public func sessionDidBecomeInactive(_ session: WCSession) { Self.log.notice("session inactive") }
    public func sessionDidDeactivate(_ session: WCSession) { Self.log.notice("session deactivated, reactivating"); session.activate() }
    public func sessionWatchStateDidChange(_ session: WCSession) {
        Self.log.notice("watch state changed paired=\(session.isPaired) watchAppInstalled=\(session.isWatchAppInstalled)")
        DispatchQueue.main.async { self.onStateChanged?() }
    }
    #endif

    // MARK: shared delegate

    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        #if os(iOS)
        Self.log.notice("activation complete state=\(self.activationStateLabel, privacy: .public) paired=\(session.isPaired) watchAppInstalled=\(session.isWatchAppInstalled) reachable=\(session.isReachable)")
        #else
        Self.log.notice("activation complete state=\(self.activationStateLabel, privacy: .public) companionInstalled=\(session.isCompanionAppInstalled) reachable=\(session.isReachable)")
        #endif
        if let e = error { recordError("activation: \(e.localizedDescription)") }
        #if os(watchOS)
        if activationState == .activated { activatedAt = Date() }
        #endif
        DispatchQueue.main.async {
            #if os(watchOS)
            if activationState == .activated { self.sendQueuedHums() }
            #endif
            self.onStateChanged?()
        }
    }

    public func sessionReachabilityDidChange(_ session: WCSession) {
        Self.log.notice("reachability changed reachable=\(session.isReachable)")
        DispatchQueue.main.async {
            #if os(watchOS)
            if session.isReachable { self.sendQueuedHums() }
            #endif
            self.onStateChanged?()
        }
    }
}

#if os(watchOS)
/// Watch transport: every hub call goes through the iPhone.
public struct WatchRelayTransport: HubTransport {
    public init() {}
    public func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        let resp = try await WatchLink.shared.relay(RelayRequest(method: method, path: path, query: query, body: body))
        if resp.status == 0 { throw HubError.transport(resp.error ?? "Relay failed") }
        return (resp.status, resp.bodyData)
    }
}
#endif
#endif
