import Foundation
import Speech
import AVFoundation
import EACore

/// Dictation that transcribes between `startAsking()` and `stop()`, and with `pauseToStop` also stops by itself when the
/// speaker pauses (the assistant then sends it). It never submits by itself. After `stop()` the transcript stays in
/// `transcript` for review; `finished()` waits for its last words.
///
/// iOS 26 and macOS 26 or later: Apple's SpeechAnalyzer, entirely on the device. It needs only the microphone; Siri and
/// keyboard dictation can stay off. The older recognizer below needs one of them on, and a Mac has both off until
/// someone turns them on: App Review's Mac did, and the mic button there never listened. The speech model is the
/// system's; a device that has none for the language yet downloads it once, on the first tap, with its progress shown.
///
/// Earlier systems: SFSpeechRecognizer, on the device when it can. If it ends on its own (a pause, a server limit), it
/// restarts and keeps what was already said.
@MainActor
final class DictationController: ObservableObject {
    @Published var transcript: String = ""
    @Published var listening = false
    @Published var error: String?
    @Published var authorized = false
    /// What dictation needs that was turned down: the screens show the way to the system's settings under the mic
    /// (which stays tappable and says it again), since the system never asks twice.
    @Published var refused: DevicePermission?
    /// Said before listening: the speech model downloading, or (earlier systems) that Apple's speech service does the
    /// work on a device that cannot do it by itself.
    @Published var notice: String?
    static let serverNoticeKey = "ea.dictation.serverNoticeShown"
    static let serverNotice = "This device cannot turn speech into text by itself, so Apple's speech service does it: what you say goes to Apple while the mic is on. Tap the mic again to dictate, or type instead."
    static let micOff = "The microphone is off for Aeneas. Turn it on in the system's Privacy settings."
    static let modelReady = "Speech recognition is ready. Tap the mic to talk."

    /// Stop by itself once something was said and then nothing new for this long (Send when I stop talking); nil
    /// waits for the tap.
    var pauseToStop: TimeInterval?
    /// Listening ended on a pause, not a tap: the caller sends what was said.
    @Published private(set) var stoppedOnPause = false
    /// Nothing said this long after starting: listening stops, so a forgotten mic does not stay on.
    static let quietLimit: TimeInterval = 12
    private var lastHeard = Date()
    private var started = Date()
    private var pauseWatch: Task<Void, Never>?
    /// Getting ready to listen (the microphone question, the speech model): further taps wait for it.
    private var starting = false
    /// `stop()` came while getting ready: listening does not start.
    private var cancelled = false
    /// The last words of a stopped dictation, still on their way.
    private var finishing: Task<Void, Never>?
    /// Why the speech model's results ended before listening began.
    private var endedEarly: String?

    /// SpeechAnalyzer's run (iOS 26 and macOS 26 or later); `AnyObject` because the type needs those systems.
    private var analyzerRun: AnyObject?

    // SFSpeechRecognizer, on earlier systems.
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private lazy var recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer()
    /// Joins the recognizer's reports, keeping what was said before a pause or a restart.
    private var joiner = TranscriptJoiner()
    private var lastRestart = Date.distantPast
    private let holder = RequestHolder()
    /// Why the recognizer last stopped, said if it keeps stopping.
    private var lastFailure: String?

    #if DEBUG
    /// Debug builds: `-EADictationSay "<words>"` speaks those words with the system voice and dictation hears them
    /// instead of the microphone, at the pace they are spoken and then silence, so dictation can be checked on a Mac
    /// with no one talking. Each step is printed (run the binary from a shell); `-EADictationLog YES` prints them with
    /// the real microphone.
    nonisolated static var debugSpeech: String? { UserDefaults.standard.string(forKey: "EADictationSay") }
    nonisolated static func log(_ s: String) {
        if debugSpeech != nil || UserDefaults.standard.bool(forKey: "EADictationLog") { print("dictation: " + s); fflush(stdout) }
    }
    #endif
    /// The words come from the debug voice, so the microphone is not asked for.
    private static var fromFile: Bool {
        #if DEBUG
        return debugSpeech != nil
        #else
        return false
        #endif
    }
    private func trace(_ s: @autoclosure () -> String) {
        #if DEBUG
        Self.log(s())
        #endif
    }

    /// Whether dictation can start now, read without asking (a screen appearing never asks, release rule 2).
    func refreshAuthorization() {
        #if os(iOS)
        let mic = AVAudioApplication.shared.recordPermission
        let micOK = mic == .granted, micRefused = mic == .denied
        #else
        let mic = AVCaptureDevice.authorizationStatus(for: .audio)
        let micOK = mic == .authorized, micRefused = mic == .denied || mic == .restricted
        #endif
        if #available(iOS 26, macOS 26, *) {
            // SpeechAnalyzer asks for no speech recognition permission: the microphone is all.
            authorized = micOK
            refused = micRefused ? .microphone : nil
            if micRefused { error = Self.micOff } else if authorized, error != nil, !listening { error = nil }
            return
        }
        let speech = SFSpeechRecognizer.authorizationStatus()
        authorized = speech == .authorized && micOK
        let speechRefused = speech == .denied || speech == .restricted
        refused = speechRefused ? .speech : micRefused ? .microphone : nil
        if speechRefused { error = "Speech recognition is off for Aeneas. Turn it on in the system's Privacy settings." }
        else if micRefused { error = Self.micOff }
        else if authorized, error != nil, !listening { error = nil }
    }

    /// The mic button. The first tap asks for what dictation needs (the person asked for dictation), then listening
    /// starts.
    func startAsking() async {
        guard !listening, !starting else { return }
        starting = true
        cancelled = false
        defer { starting = false }
        if #available(iOS 26, macOS 26, *) {
            trace("start asked (SpeechAnalyzer), microphone \(authorized ? "allowed" : "not allowed yet")")
            if !authorized, !Self.fromFile {
                let mic = await DevicePermissions.requestMicrophone()
                refreshAuthorization()
                guard mic else { if error == nil { error = Self.micOff }; return }
            }
            await startAnalyzer()
            trace(listening ? "listening" : "not listening: \(error ?? notice ?? "no reason given")")
            return
        }
        if !authorized {
            let speech = await DevicePermissions.requestSpeech()
            let mic = await DevicePermissions.requestMicrophone()
            refreshAuthorization()
            guard speech, mic else {
                if error == nil { error = speech ? "The microphone is not allowed" : "Speech recognition is not allowed" }
                return
            }
        }
        // On-device recognition keeps the audio here. Where the device has none, the first tap says so instead of
        // listening; the next tap listens.
        if let r = recognizer, !r.supportsOnDeviceRecognition, !UserDefaults.standard.bool(forKey: Self.serverNoticeKey) {
            UserDefaults.standard.set(true, forKey: Self.serverNoticeKey)
            notice = Self.serverNotice
            return
        }
        notice = nil
        guard !cancelled else { return }
        await finishing?.value
        startRecognizer()
    }

    /// Stop listening. The transcript stays in `transcript` for the caller to place in the field; `finished()` waits for
    /// its last words.
    func stop() {
        if starting { cancelled = true }
        guard listening else { return }
        listening = false
        AudioFocus.recording = false
        pauseWatch?.cancel()
        pauseWatch = nil
        if #available(iOS 26, macOS 26, *), let run = analyzerRun as? AnalyzerRun {
            analyzerRun = nil
            trace("stopped (\(stoppedOnPause ? "a pause" : "a tap or the quiet limit")), heard so far: \(transcript)")
            finishing = Task { [weak self] in
                await run.finish()
                self?.trace("finished: \(self?.transcript ?? "")")
            }
            return
        }
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        request?.endAudio()
        // Give the recognizer a moment to deliver the final result, then cancel.
        let t = task
        finishing = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 700_000_000)
            t?.finish()
        }
        engine = nil
        request = nil
        holder.set(nil)
        task = nil
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    /// Returns once the last stopped dictation's final words are in `transcript`.
    func finished() async {
        await finishing?.value
    }

    // MARK: SpeechAnalyzer

    @available(iOS 26, macOS 26, *)
    private func startAnalyzer() async {
        await finishing?.value
        error = nil
        endedEarly = nil
        stoppedOnPause = false
        let run = AnalyzerRun()
        do {
            let downloaded = try await run.prepare(locale: Locale.current) { [weak self] done in
                self?.notice = "Getting Apple's speech model onto this device, once: \(Int((done * 100).rounded()))%"
            }
            if cancelled { await run.cancel(); notice = nil; return }
            // A download can take a while: listening waits for the next tap instead of starting unseen.
            if downloaded { notice = Self.modelReady; await run.cancel(); return }
            notice = nil
            transcript = ""
            try await run.begin(onText: { [weak self] text in self?.heard(text) },
                                onEnd: { [weak self] failure in self?.analyzerEnded(failure) })
        } catch {
            await run.cancel()
            notice = nil
            self.error = (error as? DictationError)?.message ?? "Dictation could not start: \(error.localizedDescription)"
            return
        }
        if cancelled { await run.cancel(); return }
        // The model gave up while the microphone was starting: said, instead of a mic that listens to nothing.
        if let failed = endedEarly {
            endedEarly = nil
            await run.cancel()
            error = "Dictation stopped: \(failed)"
            return
        }
        analyzerRun = run
        beganListening()
    }

    /// A report from the speech model: the whole transcript so far.
    private func heard(_ text: String) {
        if text != transcript { lastHeard = Date() }
        transcript = text
    }

    /// The speech model's results ended. After `stop()` that is expected; while listening it stopped by itself.
    private func analyzerEnded(_ failure: Error?) {
        guard listening else {
            if starting { endedEarly = failure?.localizedDescription ?? "the speech model ended at once" }
            return
        }
        if let failure { error = "Dictation stopped: \(failure.localizedDescription)" }
        stop()
    }

    // MARK: SFSpeechRecognizer (earlier systems)

    /// Where the older recognizer needs a setting the person may have off.
    private static var settingsHint: String {
        #if os(macOS)
        return "On a Mac it needs Siri or Dictation turned on: System Settings, Keyboard, Dictation."
        #else
        return "It needs Dictation turned on: Settings, General, Keyboard, Enable Dictation."
        #endif
    }

    private func startRecognizer() {
        guard !listening else { return }
        error = nil
        transcript = ""
        joiner = TranscriptJoiner()
        lastRestart = .distantPast
        lastFailure = nil
        stoppedOnPause = false
        guard let recognizer = recognizer, recognizer.isAvailable else { error = "Speech recognition is not available right now. " + Self.settingsHint; return }
        let engine = AVAudioEngine()
        let request = makeRequest(recognizer)
        do {
            #if os(iOS)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            #endif
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            holder.set(request)
            let holder = self.holder
            // The audio thread reads the current request each time: a restart swaps it.
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in holder.get()?.append(buffer) }
            engine.prepare()
            try engine.start()
        } catch {
            self.error = "Audio: \(error.localizedDescription)"
            return
        }
        self.engine = engine
        self.request = request
        beganListening()
        begin(recognizer, request)
    }

    private func beganListening() {
        listening = true
        AudioFocus.recording = true
        started = Date()
        lastHeard = Date()
        if pauseToStop != nil { pauseWatch = Task { [weak self] in await self?.watchForPause() } }
    }

    /// Four times a second while listening: a pause after words ends it (and says so), as does long silence.
    private func watchForPause() async {
        while listening, !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard listening, let pause = pauseToStop else { return }
            let said = !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if said, Date().timeIntervalSince(lastHeard) >= pause {
                stoppedOnPause = true
                stop()
            } else if !said, Date().timeIntervalSince(started) >= Self.quietLimit {
                stop()
            }
        }
    }

    private func makeRequest(_ recognizer: SFSpeechRecognizer) -> SFSpeechAudioBufferRecognitionRequest {
        let r = SFSpeechAudioBufferRecognitionRequest()
        r.shouldReportPartialResults = true
        r.addsPunctuation = true
        // On-device recognition has no one-minute cap and keeps audio on the device.
        if recognizer.supportsOnDeviceRecognition { r.requiresOnDeviceRecognition = true }
        return r
    }

    private func begin(_ recognizer: SFSpeechRecognizer, _ request: SFSpeechAudioBufferRecognitionRequest) {
        task = recognizer.recognitionTask(with: request) { [weak self] result, err in
            Task { @MainActor in
                guard let self = self else { return }
                if let r = result {
                    let next = self.joiner.update(r.bestTranscription.formattedString)
                    if next != self.transcript { self.lastHeard = Date() }
                    self.transcript = next
                    if r.isFinal { self.restartIfListening(recognizer) }
                } else if let err {
                    self.lastFailure = err.localizedDescription
                    self.restartIfListening(recognizer)
                }
            }
        }
    }

    /// The recognizer stopped while the owner is still talking: keep the text and listen again.
    private func restartIfListening(_ recognizer: SFSpeechRecognizer) {
        guard listening else { return }
        // A recognizer that fails at once would spin; stop and say why instead.
        if Date().timeIntervalSince(lastRestart) < 1 {
            error = "Speech recognition stopped" + (lastFailure.map { " (\($0))" } ?? "") + ". " + Self.settingsHint
            stop()
            return
        }
        lastRestart = Date()
        joiner.endRun()
        request?.endAudio()
        let next = makeRequest(recognizer)
        request = next
        holder.set(next)
        begin(recognizer, next)
    }
}

#if DEBUG
extension Notification.Name {
    /// Debug builds: the Assistant's or Capture's mic button action, run as if it was clicked (Mac self-test).
    static let debugPressMic = Notification.Name("EADebugPressMic")
    /// Debug builds: a module switch in Settings, Modules flipped on as if clicked; the object is the module id.
    static let debugFlipModule = Notification.Name("EADebugFlipModule")
}
#endif

/// Why SpeechAnalyzer dictation could not start, in the words shown under the mic.
private enum DictationError: Error {
    case language(Locale)
    case download(Error)
    case noMicrophone
    case notReady

    var message: String {
        switch self {
        case .language(let l):
            let name = Locale.current.localizedString(forIdentifier: l.identifier) ?? l.identifier
            return "Dictation does not understand \(name) on this device yet. Type instead."
        case .download(let e):
            return "Apple's speech model could not be downloaded (\(e.localizedDescription)). Check the connection and tap the mic again."
        case .noMicrophone:
            return "No microphone was found. Connect one, or type instead."
        case .notReady:
            return "Dictation could not start. Tap the mic to try again."
        }
    }
}

/// One dictation with SpeechAnalyzer: the microphone's audio goes to the on-device speech model until `finish()`.
@available(iOS 26, macOS 26, *)
@MainActor
private final class AnalyzerRun {
    private var module: (any SpeechModule)?
    private var analyzer: SpeechAnalyzer?
    private var format: AVAudioFormat?
    private let audio = AVAudioEngine()
    private var tapped = false
    /// iOS: this run made the audio session active, so it ends it.
    private var sessionActive = false
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var results: Task<Void, Never>?
    private var segments = SpeechSegments()
    /// Debug builds: feeds a file's audio in place of the microphone.
    private var feeder: Task<Void, Never>?

    /// The transcriber for this device and language: SpeechTranscriber where it has them, else DictationTranscriber
    /// (the model of system dictation, on more devices and languages). Nil when neither understands the language.
    static func module(for locale: Locale) async -> (any SpeechModule)? {
        if SpeechTranscriber.isAvailable, let l = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
            return SpeechTranscriber(locale: l, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
        }
        if let l = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
            return DictationTranscriber(locale: l, contentHints: [], transcriptionOptions: [.punctuation], reportingOptions: [.volatileResults], attributeOptions: [])
        }
        return nil
    }

    /// The speech model for `locale`, downloaded first if this device has none (with `progress` from 0 to 1), then
    /// loaded. True when it had to be downloaded.
    func prepare(locale: Locale, progress: @escaping (Double) -> Void) async throws -> Bool {
        guard let module = await Self.module(for: locale) else { throw DictationError.language(locale) }
        self.module = module
        var downloaded = false
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            progress(0)
            let watch = Task { @MainActor in
                while !Task.isCancelled {
                    progress(request.progress.fractionCompleted)
                    try? await Task.sleep(nanoseconds: 250_000_000)
                }
            }
            defer { watch.cancel() }
            do { try await request.downloadAndInstall() } catch { throw DictationError.download(error) }
            downloaded = true
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else { throw DictationError.notReady }
        self.format = format
        let analyzer = SpeechAnalyzer(modules: [module])
        try await analyzer.prepareToAnalyze(in: format)
        self.analyzer = analyzer
        return downloaded
    }

    /// Starts the analysis and the microphone. `onText` gets the whole transcript after each report; `onEnd` once the
    /// results end, with the failure if they ended on one.
    func begin(onText: @escaping (String) -> Void, onEnd: @escaping (Error?) -> Void) async throws {
        guard let module, let analyzer, let format else { throw DictationError.notReady }
        let (stream, input) = AsyncStream.makeStream(of: AnalyzerInput.self)
        self.input = input
        // Listening for results before any audio, so none is missed.
        results = Task { @MainActor [weak self] in
            do {
                for try await (text, isFinal) in Self.reports(module) {
                    guard let self else { return }
                    onText(self.segments.update(text, final: isFinal))
                }
                onEnd(nil)
            } catch {
                onEnd(error)
            }
        }
        try await analyzer.start(inputSequence: stream)
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        sessionActive = true
        #endif
        let converter = AudioConverter(to: format)
        #if DEBUG
        if let words = DictationController.debugSpeech {
            feeder = Task.detached { await Self.feed(words, converter: converter, into: input) }
            return
        }
        #endif
        let mic = audio.inputNode.outputFormat(forBus: 0)
        guard mic.sampleRate > 0, mic.channelCount > 0 else { throw DictationError.noMicrophone }
        #if DEBUG
        DictationController.log("microphone gives \(Int(mic.sampleRate)) Hz, \(mic.channelCount) channel(s); the model takes \(Int(format.sampleRate)) Hz")
        #endif
        #if DEBUG
        let meter = LevelMeter()
        #endif
        audio.inputNode.installTap(onBus: 0, bufferSize: 4096, format: mic) { buffer, _ in
            #if DEBUG
            meter.measure(buffer)
            #endif
            if let b = converter.convert(buffer) { input.yield(AnalyzerInput(buffer: b)) }
        }
        tapped = true
        audio.prepare()
        try audio.start()
    }

    /// Stops the microphone and waits for the last words, at most 3 s.
    func finish() async {
        stopAudio()
        input?.finish()
        guard let analyzer else { return }
        let limit = Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if !Task.isCancelled { await analyzer.cancelAndFinishNow() }
        }
        do { try await analyzer.finalizeAndFinishThroughEndOfInput() } catch { await analyzer.cancelAndFinishNow() }
        limit.cancel()
        await results?.value
    }

    /// Stops everything and drops what was not final.
    func cancel() async {
        stopAudio()
        input?.finish()
        results?.cancel()
        await analyzer?.cancelAndFinishNow()
    }

    private func stopAudio() {
        feeder?.cancel()
        feeder = nil
        if tapped {
            audio.inputNode.removeTap(onBus: 0)
            tapped = false
        }
        audio.stop()
        #if os(iOS)
        if sessionActive {
            sessionActive = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        #endif
    }

    #if DEBUG
    /// Debug builds: `words` in the system voice, as a 48 kHz microphone would give them, a tenth of a second at a time
    /// in real time, then silence until the run ends.
    nonisolated private static func feed(_ words: String, converter: AudioConverter, into input: AsyncStream<AnalyzerInput>.Continuation) async {
        guard let mic = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1), let spoken = await speak(words, as: mic) else {
            DictationController.log("the test words could not be spoken")
            return
        }
        DictationController.log("feeding \(String(format: "%.1f", Double(spoken.frameLength) / 48_000)) s of speech")
        let chunk = 4_800
        var at = 0
        while !Task.isCancelled {
            guard let piece = AVAudioPCMBuffer(pcmFormat: mic, frameCapacity: AVAudioFrameCount(chunk)),
                  let src = spoken.floatChannelData?[0], let dst = piece.floatChannelData?[0] else { return }
            piece.frameLength = AVAudioFrameCount(chunk)
            for i in 0..<chunk { dst[i] = at + i < Int(spoken.frameLength) ? src[at + i] : 0 }
            at += chunk
            if let b = converter.convert(piece) { input.yield(AnalyzerInput(buffer: b)) }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    /// The system voice saying `words`, in `format`.
    nonisolated private static func speak(_ words: String, as format: AVAudioFormat) async -> AVAudioPCMBuffer? {
        let parts: [AVAudioPCMBuffer] = await withCheckedContinuation { c in
            let synth = AVSpeechSynthesizer()
            let u = AVSpeechUtterance(string: words)
            u.voice = AVSpeechSynthesisVoice(language: "en-US")
            var got: [AVAudioPCMBuffer] = []
            var ended = false
            synth.write(u) { buffer in
                guard !ended else { return }
                guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else {
                    ended = true
                    _ = synth
                    c.resume(returning: got)
                    return
                }
                got.append(pcm)
            }
        }
        guard let first = parts.first, let up = AVAudioConverter(from: first.format, to: format) else { return nil }
        let frames = parts.reduce(0) { $0 + Double($1.frameLength) } * format.sampleRate / first.format.sampleRate
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames) + 4_800) else { return nil }
        var next = 0
        _ = up.convert(to: out, error: nil) { _, state in
            guard next < parts.count else { state.pointee = .endOfStream; return nil }
            state.pointee = .haveData
            next += 1
            return parts[next - 1]
        }
        return out.frameLength > 0 ? out : nil
    }
    #endif

    /// Each report's text, and whether it is final (later reports no longer change it).
    private static func reports(_ module: any SpeechModule) -> AsyncThrowingStream<(String, Bool), Error> {
        AsyncThrowingStream { c in
            let task = Task {
                do {
                    if let t = module as? SpeechTranscriber {
                        for try await r in t.results { c.yield((String(r.text.characters), r.isFinal)) }
                    } else if let t = module as? DictationTranscriber {
                        for try await r in t.results { c.yield((String(r.text.characters), r.isFinal)) }
                    }
                    c.finish()
                } catch {
                    c.finish(throwing: error)
                }
            }
            c.onTermination = { _ in task.cancel() }
        }
    }
}

#if DEBUG
/// Debug builds with `-EADictationLog YES`: the microphone's loudest sample each second for the first five seconds, so
/// a check can tell real sound (room noise is above zero) from a microphone the system keeps silent (exact zeros).
private final class LevelMeter: @unchecked Sendable {
    private var peak: Float = 0
    private var frames = 0
    private var seconds = 0

    func measure(_ buffer: AVAudioPCMBuffer) {
        guard seconds < 5, let data = buffer.floatChannelData?[0] else { return }
        for i in 0..<Int(buffer.frameLength) { peak = max(peak, abs(data[i])) }
        frames += Int(buffer.frameLength)
        if frames >= Int(buffer.format.sampleRate) {
            seconds += 1
            DictationController.log("microphone second \(seconds): loudest sample \(String(format: "%.5f", peak))")
            peak = 0
            frames = 0
        }
    }
}
#endif

/// The microphone's audio in the format the speech model takes. Used on the audio thread only.
private final class AudioConverter: @unchecked Sendable {
    private let target: AVAudioFormat
    private var converter: AVAudioConverter?

    init(to target: AVAudioFormat) { self.target = target }

    /// A converted copy (the engine reuses its buffer once the tap returns); nil if it could not be converted.
    func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: target)
            // No priming: the first samples are not held back, so the audio's times stay in step with the microphone.
            converter?.primeMethod = .none
            // A microphone with more channels than the model takes: the first one.
            if buffer.format.channelCount > target.channelCount { converter?.channelMap = (0..<Int(target.channelCount)).map { NSNumber(value: $0) } }
        }
        guard let converter, buffer.format.sampleRate > 0 else { return nil }
        let frames = (Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate).rounded(.up)
        guard frames > 0, let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(frames) + 16) else { return nil }
        var given = false
        var failure: NSError?
        let status = converter.convert(to: out, error: &failure) { _, state in
            if given { state.pointee = .noDataNow; return nil }
            given = true
            state.pointee = .haveData
            return buffer
        }
        return status == .error || out.frameLength == 0 ? nil : out
    }
}

/// The recognition request the audio tap feeds, swapped on restart. Read on the audio thread.
private final class RequestHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    func set(_ r: SFSpeechAudioBufferRecognitionRequest?) { lock.lock(); request = r; lock.unlock() }
    func get() -> SFSpeechAudioBufferRecognitionRequest? { lock.lock(); defer { lock.unlock() }; return request }
}
