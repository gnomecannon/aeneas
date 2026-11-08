import Foundation
import AVFoundation
import AudioToolbox
import EACore

/// Plays a hummed idea on this device: a melody through a sampler, a rhythm as short drum sounds made on the spot,
/// or the original recording. One thing plays at a time, and the audio session is active only while it plays.
@MainActor
final class HumPlayer: NSObject, ObservableObject {
    enum Playing: Equatable { case notes, recording }

    @Published private(set) var playing: Playing?
    @Published var error: String?
    /// When playing started, for the piano roll's playhead.
    private(set) var startedAt: Date?

    private var engine: AVAudioEngine?
    private var sequencer: AVAudioSequencer?
    private var audio: AVAudioPlayer?
    private var endTask: Task<Void, Never>?

    func playNotes(_ midi: HumMidi) {
        stop()
        error = nil
        guard !midi.notes.isEmpty else { return }
        do {
            try activate()
            let engine = AVAudioEngine()
            switch midi.mode {
            case .melody:
                let sampler = AVAudioUnitSampler()
                engine.attach(sampler)
                engine.connect(sampler, to: engine.mainMixerNode, format: nil)
                Self.loadPiano(sampler)
                try engine.start()
                let seq = AVAudioSequencer(audioEngine: engine)
                try seq.load(from: midi.playbackMIDIFile(), options: [])
                for t in seq.tracks { t.destinationAudioUnit = sampler }
                seq.prepareToPlay()
                try seq.start()
                sequencer = seq
            case .rhythm:
                let rate = 44_100.0
                let samples = HumDrums.render(midi.notes, sampleRate: rate)
                guard let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1),
                      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
                      let channel = buffer.floatChannelData?[0] else {
                    throw NSError(domain: "Hum", code: 2, userInfo: [NSLocalizedDescriptionKey: "no audio buffer"])
                }
                buffer.frameLength = AVAudioFrameCount(samples.count)
                samples.withUnsafeBufferPointer { src in
                    if let base = src.baseAddress { channel.update(from: base, count: samples.count) }
                }
                let node = AVAudioPlayerNode()
                engine.attach(node)
                engine.connect(node, to: engine.mainMixerNode, format: format)
                try engine.start()
                node.scheduleBuffer(buffer, at: nil, options: [])
                node.play()
            }
            self.engine = engine
            playing = .notes
            AudioFocus.playing = true
            startedAt = Date()
            stopAfter(midi.length + 0.6)
        } catch {
            stop()
            deactivate()
            self.error = "Could not play the notes: \(error.localizedDescription)"
        }
    }

    func playRecording(_ data: Data) {
        stop()
        error = nil
        do {
            try activate()
            let p = try AVAudioPlayer(data: data)
            p.delegate = self
            guard p.play() else { throw NSError(domain: "Hum", code: 3, userInfo: [NSLocalizedDescriptionKey: "the recording did not start"]) }
            audio = p
            playing = .recording
            AudioFocus.playing = true
            startedAt = Date()
        } catch {
            stop()
            deactivate()
            self.error = "Could not play the recording: \(error.localizedDescription)"
        }
    }

    func stop() {
        endTask?.cancel()
        endTask = nil
        sequencer?.stop()
        sequencer = nil
        engine?.stop()
        engine = nil
        audio?.stop()
        audio = nil
        let was = playing != nil
        playing = nil
        startedAt = nil
        if was { AudioFocus.playing = false }
        if was { deactivate() }
    }

    private func stopAfter(_ seconds: TimeInterval) {
        endTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
            if !Task.isCancelled { self?.stop() }
        }
    }

    private func activate() throws {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setActive(true)
        #endif
    }

    private func deactivate() {
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    /// The Mac has General MIDI instruments built in; a piano reads better than the sampler's plain tone.
    /// iOS has none, so the sampler's own tone plays there.
    private static func loadPiano(_ sampler: AVAudioUnitSampler) {
        #if os(macOS)
        let bank = URL(fileURLWithPath: "/System/Library/Components/CoreAudio.component/Contents/Resources/gs_instruments.dls")
        guard FileManager.default.fileExists(atPath: bank.path) else { return }
        try? sampler.loadSoundBankInstrument(at: bank, program: 0, bankMSB: UInt8(kAUSampler_DefaultMelodicBankMSB), bankLSB: UInt8(kAUSampler_DefaultBankLSB))
        #endif
    }
}

extension HumPlayer: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in if self.audio === player { self.stop() } }
    }
}
