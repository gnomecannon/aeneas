import SwiftUI
import WatchKit
import AVFoundation
import EACore

/// Reads answers through the Watch speaker (or connected headphones), one at a time, louder than the plain speech
/// synthesizer: Apple's speech comes out about 15 dB under full scale (measured 2026-11-10: peak 0.78, RMS 0.17),
/// so it is made into sound here and lifted about 6 dB, with a soft limit that rounds the loudest peaks instead of
/// clipping them. The Watch's own volume (Digital Crown while it speaks, or Settings, Sounds and Haptics) still sets
/// the top.
@MainActor
final class WatchSpeaker: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published private(set) var speakingId: String?
    private let synth = AVSpeechSynthesizer()
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var connected: AVAudioFormat?
    /// Each answer gets a number; buffers and callbacks of an answer that was stopped are dropped.
    private var generation = 0
    private var scheduled = 0
    private var written = false
    /// The engine could not start once: speak plainly from then on.
    private var plain = false
    /// The answer being read, so a late report about an earlier one is ignored.
    private var current: AVSpeechUtterance?

    /// How much louder than Apple's level, before the soft limit.
    nonisolated static let gain: Float = 2.2

    override init() {
        super.init()
        synth.delegate = self
        engine.attach(player)
    }

    func toggle(_ text: String, id: String) { speakingId == id ? stop() : speak(text, id: id) }

    func speak(_ text: String, id: String) {
        stop()
        let said = Speakable.text(text)
        // A hum being recorded keeps the microphone's audio session: speaking would switch it and cut the take.
        guard !said.isEmpty, !AudioFocus.recording else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        let u = SpeechVoice.utterance(said)
        speakingId = id
        current = u
        if plain { synth.speak(u); return }
        generation += 1
        let gen = generation
        scheduled = 0
        written = false
        synth.write(u) { [weak self] buffer in
            // Lifted here, on the synthesizer's thread, into a buffer of our own: the synthesizer may reuse its own.
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            let loud = pcm.frameLength == 0 ? nil : Self.louder(pcm)
            Task { @MainActor in self?.received(loud, ended: pcm.frameLength == 0, gen: gen) }
        }
    }

    func stop() {
        generation += 1
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        player.stop()
        speakingId = nil
    }

    private func received(_ buffer: AVAudioPCMBuffer?, ended: Bool, gen: Int) {
        guard gen == generation else { return }
        if ended {
            written = true
            if scheduled == 0 { finished() }
            return
        }
        guard let buffer else { return }
        do {
            if connected != buffer.format {
                engine.disconnectNodeOutput(player)
                engine.connect(player, to: engine.mainMixerNode, format: buffer.format)
                connected = buffer.format
            }
            if !engine.isRunning { try engine.start() }
        } catch {
            // No engine on this Watch right now: the rest of this answer, and every later one, the plain way.
            plain = true
            generation += 1
            speakingId = nil
            return
        }
        scheduled += 1
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in self?.played(gen: gen) }
        }
        if !player.isPlaying { player.play() }
    }

    private func played(gen: Int) {
        guard gen == generation else { return }
        scheduled -= 1
        if scheduled == 0, written { finished() }
    }

    private func finished() {
        generation += 1
        player.stop()
        engine.stop()
        speakingId = nil
        guard !AudioFocus.recording else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// A float copy, `gain` louder, through a soft limit: quiet speech grows by the full gain, the loudest peaks are
    /// rounded off just under full scale (tanh) instead of clipping.
    nonisolated static func louder(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let frames = Int(input.frameLength)
        let channels = Int(input.format.channelCount)
        guard frames > 0, let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: input.format.sampleRate, channels: input.format.channelCount, interleaved: false),
              let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: input.frameLength), let dst = out.floatChannelData else { return nil }
        out.frameLength = input.frameLength
        let norm = tanhf(gain)
        for c in 0..<channels {
            for i in 0..<frames {
                let x: Float
                if let f = input.floatChannelData { x = f[c][i] }
                else if let s = input.int16ChannelData { x = Float(s[c][i]) / 32768 }
                else if let s = input.int32ChannelData { x = Float(s[c][i]) / 2_147_483_648 }
                else { x = 0 }
                dst[c][i] = tanhf(x * gain) / norm * 0.98
            }
        }
        return out
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        let id = ObjectIdentifier(u)
        Task { @MainActor in self.reported(id) }
    }
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        let id = ObjectIdentifier(u)
        Task { @MainActor in self.reported(id) }
    }

    /// The plain way ends here. Written speech ends with an empty buffer; should a Watch report the end here instead,
    /// it ends once what was scheduled has played.
    private func reported(_ u: ObjectIdentifier) {
        guard let c = current, ObjectIdentifier(c) == u else { return }
        if !plain {
            guard speakingId != nil, !written else { return }
            written = true
            if scheduled == 0 { finished() }
            return
        }
        guard !synth.isSpeaking else { return }
        speakingId = nil
        guard !AudioFocus.recording else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// The Watch speaker's volume on the Digital Crown: shown while an answer is read, so turning the crown sets how loud
/// it is (up to the Watch's maximum) instead of scrolling.
struct SpeakerVolume: WKInterfaceObjectRepresentable {
    func makeWKInterfaceObject(context: Context) -> WKInterfaceVolumeControl {
        let v = WKInterfaceVolumeControl(origin: .local)
        v.setTintColor(.blue)
        v.focus()
        return v
    }
    func updateWKInterfaceObject(_ v: WKInterfaceVolumeControl, context: Context) {}
}
