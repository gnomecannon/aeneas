import Foundation
import AVFoundation
import EACore

/// Set while the app records from the microphone (a hum or dictation) or plays a hum, so Feel's tap sounds stay out
/// of the recording and do not switch the audio session under it.
@MainActor
enum AudioFocus {
    static var recording = false
    static var playing = false
    static var busy: Bool { recording || playing }
}

/// One finished recording waiting to be sent to the hub.
struct HumTake: Equatable, Identifiable {
    let id = UUID()
    var url: URL
    var seconds: TimeInterval
}

/// Records a hum for the hub: linear PCM WAV, 22,050 Hz, mono, 16 bit, to a temporary file, up to two minutes
/// (one on the Watch). The microphone is on only from `start()` until `stop()`, `cancel()` or the limit; permission
/// is asked at the first press, not when a screen opens. Used by Music and Capture, and by the Watch's Hum.
@MainActor
final class HumRecorder: NSObject, ObservableObject {
    @Published private(set) var recording = false
    @Published private(set) var elapsed: TimeInterval = 0
    /// Input level from 0 to 1 for the meter.
    @Published private(set) var level: Float = 0
    @Published var error: String?
    /// Set when a recording ends with Stop or at the limit; the screen sends it and clears this.
    @Published var finished: HumTake?

    static let maxSeconds = HubClient.humMaxSeconds
    /// Where this recorder stops on its own.
    let limit: TimeInterval

    init(limit: TimeInterval = HubClient.humMaxSeconds) {
        self.limit = min(limit, Self.maxSeconds)
        super.init()
    }

    /// The format the hub asks for: small, and plenty for a voice.
    static let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 22_050.0,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
    ]

    private var recorder: AVAudioRecorder?
    /// Set while the permission question is open, so a second press does not start a second recorder.
    private var starting = false
    private var meterTask: Task<Void, Never>?
    private var discard = false
    private var interruption: NSObjectProtocol?

    func start() async {
        guard !recording, !starting, recorder == nil else { return }
        starting = true
        defer { starting = false }
        error = nil
        guard await Self.microphoneAllowed() else {
            #if os(macOS)
            error = "The microphone is not allowed. Turn it on in System Settings, Privacy and Security, Microphone."
            #else
            error = "The microphone is not allowed. Turn it on in Settings, Privacy and Security, Microphone."
            #endif
            return
        }
        // Complete unless open: a take still recording when the device locks (the Watch keeps recording with the
        // wrist down) can be finished; once closed it is unreadable while the device is locked.
        let folder = DataProtection.folder(FileManager.default.temporaryDirectory.appendingPathComponent("hum-takes", isDirectory: true), .completeUnlessOpen)
        let url = folder.appendingPathComponent("hum-\(UUID().uuidString).wav")
        do {
            #if os(iOS) || os(watchOS)
            // Measurement mode leaves out automatic gain, which would flatten the hits of a tapped rhythm.
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [])
            try session.setActive(true)
            #endif
            let r = try AVAudioRecorder(url: url, settings: Self.settings)
            r.delegate = self
            r.isMeteringEnabled = true
            guard r.prepareToRecord(), r.record(forDuration: limit) else {
                throw NSError(domain: "Hum", code: 1, userInfo: [NSLocalizedDescriptionKey: "the microphone did not start"])
            }
            recorder = r
        } catch {
            try? FileManager.default.removeItem(at: url)
            deactivate()
            self.error = "Could not start recording: \(error.localizedDescription)"
            return
        }
        discard = false
        elapsed = 0
        level = 0
        recording = true
        AudioFocus.recording = true
        #if os(iOS) || os(watchOS)
        // A call or another app taking the microphone ends the take; what was recorded is kept.
        interruption = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
            if began { Task { @MainActor in self?.stop() } }
        }
        #endif
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.tick()
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        }
    }

    /// Ends the take and hands it over in `finished`.
    func stop() {
        guard recording, let r = recorder else { return }
        elapsed = r.currentTime
        r.stop()
    }

    /// Ends the take and throws it away.
    func cancel() {
        guard recording, let r = recorder else { return }
        discard = true
        r.stop()
    }

    private func tick() {
        guard let r = recorder, r.isRecording else { return }
        r.updateMeters()
        elapsed = r.currentTime
        // -50 dB and below shows as empty, like a mixer's meter.
        level = max(0, min(1, (r.averagePower(forChannel: 0) + 50) / 50))
    }

    private func finish(_ r: AVAudioRecorder, ok: Bool) {
        guard r === recorder else { return }
        meterTask?.cancel()
        meterTask = nil
        if let o = interruption { NotificationCenter.default.removeObserver(o); interruption = nil }
        recorder = nil
        recording = false
        AudioFocus.recording = false
        level = 0
        deactivate()
        if discard {
            try? FileManager.default.removeItem(at: r.url)
            return
        }
        // The file's own length; the meter's clock stops a little early at the limit.
        let seconds = (try? AVAudioFile(forReading: r.url)).map { Double($0.length) / $0.fileFormat.sampleRate } ?? elapsed
        guard ok else {
            try? FileManager.default.removeItem(at: r.url)
            error = "The recording stopped with an error. Try again."
            return
        }
        guard seconds >= 1 else {
            try? FileManager.default.removeItem(at: r.url)
            error = "That was too short to hear. Record for at least a second."
            return
        }
        finished = HumTake(url: r.url, seconds: seconds)
    }

    private func deactivate() {
        #if os(iOS) || os(watchOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    static func microphoneAllowed() async -> Bool {
        #if os(iOS) || os(watchOS)
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
        #else
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
        #endif
    }
}

extension HumRecorder: AVAudioRecorderDelegate {
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor in self.finish(recorder, ok: flag) }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor in
            recorder.stop()
            self.finish(recorder, ok: false)
        }
    }
}
