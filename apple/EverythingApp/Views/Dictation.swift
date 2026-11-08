import Foundation
import Speech
import AVFoundation
import EACore

/// Dictation that waits for you: transcribes only between `start()` and `stop()` and never submits.
/// On-device recognition is used when the device supports it, which has no one-minute limit; if the
/// recognizer ends on its own (a pause, a server limit), it restarts and keeps what was already said.
/// On `stop()` the final transcript is handed back for review.
@MainActor
final class DictationController: ObservableObject {
    @Published var transcript: String = ""
    @Published var listening = false
    @Published var error: String?
    @Published var authorized = false
    /// Said once, before the first dictation on a device that cannot turn speech into text by itself.
    @Published var notice: String?
    static let serverNoticeKey = "ea.dictation.serverNoticeShown"
    static let serverNotice = "This device cannot turn speech into text by itself, so Apple's speech service does it: what you say goes to Apple while the mic is on. Tap the mic again to dictate, or type instead."

    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer()
    /// Joins the recognizer's reports, keeping what was said before a pause or a restart.
    private var joiner = TranscriptJoiner()
    private var lastRestart = Date.distantPast
    private let holder = RequestHolder()

    func toggle() { listening ? stop() : start() }

    /// Whether dictation can start now, read without asking (a screen appearing never asks, release rule 2).
    func refreshAuthorization() {
        let speech = SFSpeechRecognizer.authorizationStatus()
        #if os(iOS)
        let mic = AVAudioApplication.shared.recordPermission
        let micOK = mic == .granted, micRefused = mic == .denied
        #else
        let mic = AVCaptureDevice.authorizationStatus(for: .audio)
        let micOK = mic == .authorized, micRefused = mic == .denied || mic == .restricted
        #endif
        authorized = speech == .authorized && micOK
        if speech == .denied || speech == .restricted { error = "Speech recognition is off for EverythingApp. Turn it on in the system's Privacy settings." }
        else if micRefused { error = "The microphone is off for EverythingApp. Turn it on in the system's Privacy settings." }
        else if authorized, error != nil, !listening { error = nil }
    }

    /// The mic button. The first tap asks for speech recognition and the microphone (the person asked for
    /// dictation), then listening starts.
    func startAsking() async {
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
        start()
    }

    func start() {
        guard !listening else { return }
        error = nil
        transcript = ""
        joiner = TranscriptJoiner()
        lastRestart = .distantPast
        guard let recognizer = recognizer, recognizer.isAvailable else { error = "Speech recognizer unavailable"; return }
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
        listening = true
        AudioFocus.recording = true
        begin(recognizer, request)
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
                    self.transcript = self.joiner.update(r.bestTranscription.formattedString)
                    if r.isFinal { self.restartIfListening(recognizer) }
                } else if err != nil {
                    self.restartIfListening(recognizer)
                }
            }
        }
    }

    /// The recognizer stopped while the owner is still talking: keep the text and listen again.
    private func restartIfListening(_ recognizer: SFSpeechRecognizer) {
        guard listening else { return }
        // A recognizer that fails at once would spin; stop and say so instead.
        if Date().timeIntervalSince(lastRestart) < 1 { error = "Speech recognition stopped. Tap the mic to try again."; stop(); return }
        lastRestart = Date()
        joiner.endRun()
        request?.endAudio()
        let next = makeRequest(recognizer)
        request = next
        holder.set(next)
        begin(recognizer, next)
    }


    /// Stop listening. The transcript stays in `transcript` for the caller to place in the field.
    func stop() {
        guard listening else { return }
        listening = false
        AudioFocus.recording = false
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        request?.endAudio()
        // Give the recognizer a moment to deliver the final result, then cancel.
        let t = task
        Task { @MainActor in
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
}

/// The recognition request the audio tap feeds, swapped on restart. Read on the audio thread.
private final class RequestHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    func set(_ r: SFSpeechAudioBufferRecognitionRequest?) { lock.lock(); request = r; lock.unlock() }
    func get() -> SFSpeechAudioBufferRecognitionRequest? { lock.lock(); defer { lock.unlock() }; return request }
}
