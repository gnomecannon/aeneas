import Foundation
import os
#if canImport(WatchConnectivity)
import WatchConnectivity
#if canImport(WidgetKit)
import WidgetKit
#endif

/// WatchConnectivity session owner.
/// iPhone: answers relayed hub requests from the Watch with the phone's own hub URL and token.
/// Watch: sends `RelayRequest` envelopes and awaits `RelayResponse`. Relayed requests are not queued on
/// the phone side; the Watch keeps its own outbox and retries. Answers too big for one message come back
/// compressed, in parts (see `RelayParts`). Hums and spoken captures are the exception: they go as file transfers
/// and wait in `WatchHumQueue` and `WatchCaptureQueue` on each side (see `WatchHum` and `WatchVoiceCapture`).
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
    /// Watch side, on the main thread: the iPhone has the spoken capture with this id.
    public var onCaptureDelivered: ((String) -> Void)?
    /// Watch side, on the main thread: what the iPhone heard in a spoken capture and how it was saved.
    public var onCaptureResult: ((WatchCaptureResult) -> Void)?
    /// Watch side, on the main thread: the words the iPhone says to expect in captures (`SpeechHints`).
    public var onSpeechHints: (([String]) -> Void)?
    /// Watch side, on a WatchConnectivity queue: a speech model file has been checked and put in place (or refused).
    public var onSpeechModelFile: (() -> Void)?
    /// Watch side, main thread only: captures the Watch is writing down itself. Their recordings wait here until it
    /// is done (or gives up), so what it heard goes with them; after a relaunch nothing is held and they all go.
    private var heldCaptures: Set<String> = []
    #endif

    #if os(iOS)
    /// Phone side, on the main thread: a hum from the Watch is in `WatchHumQueue.local`, ready to send to the hub.
    public var onHumReceived: (() -> Void)?
    /// Phone side, on the main thread: a spoken capture from the Watch is in `WatchCaptureQueue.local`, ready to hear.
    public var onCaptureReceived: (() -> Void)?
    /// Phone side, on the main thread: the Watch said which speech model it wants and which files it lacks.
    public var onWatchSpeechState: ((WatchSpeechState) -> Void)?
    /// Phone side, on the main thread: a speech model file did not reach the Watch (it is sent again).
    public var onSpeechModelTransferFailed: (() -> Void)?
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
        sendQueuedFiles()
    }

    /// The same for a spoken capture: kept in the Watch's queue until WatchConnectivity has delivered it. `hold`: the
    /// Watch is writing it down itself, so the recording waits (safely in the queue) until `release` adds what it
    /// heard, or until the next launch if the app is stopped first.
    public func queueCapture(_ capture: WatchVoiceCapture, file: URL, hold: Bool = false) throws {
        try WatchCaptureQueue.local.add(capture, moving: file)
        if hold { heldCaptures.insert(capture.id) }
        sendQueuedFiles()
    }

    /// The Watch is done writing a held capture down: what it heard (nil when it could not) goes with the recording.
    /// Call on the main thread.
    public func release(capture id: String, heard: String?) {
        guard heldCaptures.remove(id) != nil else { return }
        if heard != nil { WatchCaptureQueue.local.setHeard(id, heard) }
        sendQueuedFiles()
    }

    /// Hands every kept recording (hums and spoken captures) that WatchConnectivity is not carrying already to it
    /// again: after a failed transfer, a relaunch, or activation finishing after the recording. Call on the main thread.
    public func sendQueuedFiles() {
        guard let s = session else { return }
        guard s.activationState == .activated else { activate(); return }
        let carrying = Set(s.outstandingFileTransfers.compactMap {
            WatchHum(metadata: $0.file.metadata)?.id ?? WatchVoiceCapture(metadata: $0.file.metadata)?.id
        })
        let hums = WatchHumQueue.local
        for e in hums.all() where !carrying.contains(e.hum.id) {
            guard hums.hasAudio(e.hum.id) else { hums.remove(e.hum.id); continue }
            Self.log.notice("hum transfer queued \(e.hum.id, privacy: .public) reachable=\(s.isReachable)")
            s.transferFile(hums.audioURL(e.hum.id), metadata: e.hum.metadata)
        }
        let captures = WatchCaptureQueue.local
        for e in captures.all() where !carrying.contains(e.capture.id) && !heldCaptures.contains(e.capture.id) {
            guard captures.hasAudio(e.capture) else { captures.remove(e.capture.id); continue }
            Self.log.notice("capture transfer queued \(e.capture.id, privacy: .public) reachable=\(s.isReachable)")
            s.transferFile(captures.audioURL(e.capture), metadata: e.capture.metadata)
        }
    }

    /// Speech model files from the iPhone: checked against the pinned size and SHA-256, then put in place. Runs on a
    /// WatchConnectivity queue, which deletes the file when this returns, so the check happens here. A file that does
    /// not match is dropped; the Watch still lists it as missing, so the iPhone sends it again.
    public func session(_ session: WCSession, didReceive file: WCSessionFile) {
        guard let t = SpeechModelTransfer(metadata: file.metadata), let model = SpeechModel.named(t.model) else { return }
        let store = SpeechModelStore.local
        do {
            // Into the store's own folder first: the check reads the file, and the move then stays on one volume.
            let staging = store.folder.appendingPathComponent("incoming-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: store.folder, withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: file.fileURL, to: staging)
            try store.accept(staging, as: t.path, for: model)
            Self.log.notice("speech model file \(t.path, privacy: .public) in place, complete=\(store.isComplete(model))")
        } catch {
            recordError("speech model file \(t.path): \(error)")
        }
        onSpeechModelFile?()
    }

    /// Tells the iPhone which speech model this Watch wants and which files it still lacks. The newest state wins and
    /// waits for the iPhone if it is away.
    public func updateSpeechState(_ state: WatchSpeechState) {
        guard let s = session, s.activationState == .activated else { activate(); return }
        if let had = WatchSpeechState(context: s.applicationContext), had == state { return }
        do { try s.updateApplicationContext(state.context) } catch { recordError("speech state: \(error.localizedDescription)") }
    }

    /// The words to expect, as the iPhone last sent them.
    public var speechHints: [String]? {
        guard let s = session, s.activationState == .activated else { return nil }
        return SpeechHints.words(context: s.receivedApplicationContext)
    }

    public func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        if let words = SpeechHints.words(context: applicationContext) {
            DispatchQueue.main.async { self.onSpeechHints?(words) }
        }
    }

    public func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        let metadata = fileTransfer.file.metadata
        if let error {
            // Kept, and sent again at the next launch or when the iPhone comes back in reach rather than at once,
            // so an error that lasts (no iPhone app) does not spin.
            if WatchHum(metadata: metadata) != nil || WatchVoiceCapture(metadata: metadata) != nil {
                recordError("recording transfer: \(error.localizedDescription)")
            }
            return
        }
        if let hum = WatchHum(metadata: metadata) {
            WatchHumQueue.local.remove(hum.id)
            DispatchQueue.main.async { self.onHumDelivered?(hum.id) }
        } else if let capture = WatchVoiceCapture(metadata: metadata) {
            WatchCaptureQueue.local.remove(capture.id)
            DispatchQueue.main.async { self.onCaptureDelivered?(capture.id) }
        }
    }

    public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        if let s = ComplicationSnapshot(message: userInfo) { receivedComplications(s); return }
        receivedResult(userInfo)
    }
    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) { receivedResult(message) }

    /// The iPhone's view of what the complications show: kept where they read it, and they are drawn again. They
    /// used to change only when this app synced.
    private func receivedComplications(_ s: ComplicationSnapshot) {
        s.apply(to: .shared)
        Self.log.notice("complications from the iPhone")
        #if canImport(WidgetKit)
        DispatchQueue.main.async { WidgetCenter.shared.reloadAllTimelines() }
        #endif
    }

    /// A background wake for WatchConnectivity (the iPhone's complication snapshot, a hum's result): the session is
    /// made ready, and this returns once nothing more is waiting to come in (20 s at most).
    public func receivePending() async {
        activate()
        await waitForActivation()
        guard let s = session else { return }
        let deadline = Date().addingTimeInterval(20)
        while s.hasContentPending, Date() < deadline, !Task.isCancelled { try? await Task.sleep(nanoseconds: 200_000_000) }
    }

    /// How a hum or a spoken capture went, from the iPhone.
    private func receivedResult(_ m: [String: Any]) {
        if let r = WatchHumResult(message: m) {
            Self.log.notice("hum result \(r.id, privacy: .public) \(r.state.rawValue, privacy: .public)")
            DispatchQueue.main.async { self.onHumResult?(r) }
        } else if let r = WatchCaptureResult(message: m) {
            Self.log.notice("capture result \(r.id, privacy: .public) \(r.state.rawValue, privacy: .public)")
            DispatchQueue.main.async { self.onCaptureResult?(r) }
        }
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
                    self.recordError(HubError.phoneHasNoHub)
                    replyHandler((try? RelayResponse(id: req.id, status: 0, data: Data(), error: HubError.phoneHasNoHub).encoded()) ?? Data())
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
        if let capture = WatchVoiceCapture(metadata: file.metadata) {
            // WatchConnectivity deletes the file when this returns, so it moves into the queue first.
            do {
                let added = try WatchCaptureQueue.local.add(capture, moving: file.fileURL)
                Self.log.notice("capture received \(capture.id, privacy: .public) new=\(added)")
            } catch {
                recordError("capture from Watch: \(error.localizedDescription)")
                return
            }
            DispatchQueue.main.async { self.onCaptureReceived?() }
            return
        }
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
        await sendToWatch(r.message, what: "hum result \(r.id) \(r.state.rawValue)")
    }

    /// Tells the Watch what was heard in a spoken capture and how it was saved, the same way.
    public func sendCaptureResult(_ r: WatchCaptureResult) async {
        await sendToWatch(r.message, what: "capture result \(r.id) \(r.state.rawValue)")
    }

    // MARK: Speech on the Watch

    /// What the Watch last said about writing speech down itself: the model it wants and the files it lacks.
    public var watchSpeechState: WatchSpeechState? {
        guard let s = session, s.activationState == .activated, s.isPaired, s.isWatchAppInstalled else { return nil }
        return WatchSpeechState(context: s.receivedApplicationContext)
    }

    public func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let state = WatchSpeechState(context: applicationContext) else { return }
        Self.log.notice("watch speech state model=\(state.model ?? "none", privacy: .public) missing=\(state.missing.count) device=\(state.device, privacy: .public) timings: \(SpeechTimings.line(state.timings), privacy: .public)")
        DispatchQueue.main.async { self.onWatchSpeechState?(state) }
    }

    /// Sends the words to expect in captures; the Watch keeps the newest list. Nothing is sent when it has not changed.
    public func sendSpeechHints(_ words: [String]) {
        guard let s = session, s.activationState == .activated, s.isPaired, s.isWatchAppInstalled else { return }
        if SpeechHints.words(context: s.applicationContext) == words { return }
        var context = s.applicationContext
        for (k, v) in SpeechHints.context(words) { context[k] = v }
        do { try s.updateApplicationContext(context) } catch { recordError("speech hints: \(error.localizedDescription)") }
    }

    /// Hands speech model files to WatchConnectivity, which carries them to the Watch in the background, over Wi-Fi
    /// when it can. A file already on its way is not sent twice. Returns how many went.
    @discardableResult
    public func sendSpeechModelFiles(_ model: SpeechModel, paths: [String], store: SpeechModelStore) -> Int {
        guard let s = session, s.activationState == .activated, s.isPaired, s.isWatchAppInstalled else { return 0 }
        let carrying = Set(s.outstandingFileTransfers.compactMap { SpeechModelTransfer(metadata: $0.file.metadata) }.map { "\($0.model)/\($0.path)" })
        var sent = 0
        for p in paths {
            guard let f = model.file(p), store.has(model, f), !carrying.contains("\(model.name)/\(p)") else { continue }
            s.transferFile(store.url(model, f), metadata: SpeechModelTransfer(model: model.name, path: p).metadata)
            sent += 1
        }
        if sent > 0 { Self.log.notice("speech model \(model.name, privacy: .public): \(sent) files handed to WatchConnectivity") }
        return sent
    }

    /// Speech model files still on their way to the Watch.
    public var speechModelFilesInFlight: Int {
        session?.outstandingFileTransfers.filter { SpeechModelTransfer(metadata: $0.file.metadata) != nil }.count ?? 0
    }

    public func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        guard SpeechModelTransfer(metadata: fileTransfer.file.metadata) != nil, let error else { return }
        recordError("speech model file to the Watch: \(error.localizedDescription)")
        DispatchQueue.main.async { self.onSpeechModelTransferFailed?() }
    }

    private func sendToWatch(_ m: [String: Any], what: String) async {
        await waitForActivation()
        guard let s = session, s.activationState == .activated, s.isPaired, s.isWatchAppInstalled else {
            Self.log.error("\(what, privacy: .public) not sent: no Watch session")
            return
        }
        Self.log.notice("\(what, privacy: .public) reachable=\(s.isReachable)")
        if s.isReachable {
            s.sendMessage(m, replyHandler: nil) { _ in s.transferUserInfo(m) }
        } else {
            s.transferUserInfo(m)
        }
    }

    /// A complication snapshot made before the session was active, sent once it is.
    private var waitingComplications: ComplicationSnapshot?

    /// What the Watch complications show, sent whenever it changes on this iPhone. While a complication of the app is
    /// on the watch face, the transfer wakes the Watch app to draw it (Apple allows a number of these a day, then they
    /// come with the next transfers); otherwise it is there when the Watch app next runs. Only the newest one waits.
    public func sendComplications(_ snapshot: ComplicationSnapshot) {
        guard let s = session else { return }
        guard s.activationState == .activated else {
            diagLock.withLock { waitingComplications = snapshot }
            activate()
            return
        }
        guard s.isPaired, s.isWatchAppInstalled else { return }
        for t in s.outstandingUserInfoTransfers where (t.userInfo["kind"] as? String) == ComplicationSnapshot.kind { t.cancel() }
        if s.isComplicationEnabled { s.transferCurrentComplicationUserInfo(snapshot.message) } else { s.transferUserInfo(snapshot.message) }
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
        #elseif os(iOS)
        if activationState == .activated, let waiting = diagLock.withLock({ () -> ComplicationSnapshot? in
            defer { waitingComplications = nil }
            return waitingComplications
        }) { sendComplications(waiting) }
        #endif
        DispatchQueue.main.async {
            #if os(watchOS)
            if activationState == .activated { self.sendQueuedFiles() }
            #endif
            self.onStateChanged?()
        }
    }

    public func sessionReachabilityDidChange(_ session: WCSession) {
        Self.log.notice("reachability changed reachable=\(session.isReachable)")
        DispatchQueue.main.async {
            #if os(watchOS)
            if session.isReachable { self.sendQueuedFiles() }
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
