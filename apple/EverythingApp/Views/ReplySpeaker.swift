import Foundation
import AVFoundation
import EACore

/// Reads assistant replies aloud with the system voice, one at a time. `speakingId` names the reply being read, so
/// its bubble can show Stop. Markdown is cleaned first (`Speakable`), so code and links are not spelled out.
@MainActor
final class ReplySpeaker: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    static let shared = ReplySpeaker()
    @Published private(set) var speakingId: String?
    private let synth = AVSpeechSynthesizer()

    override private init() {
        super.init()
        synth.delegate = self
    }

    func toggle(_ text: String, id: String) { speakingId == id ? stop() : speak(text, id: id) }

    func speak(_ text: String, id: String) {
        stop()
        let said = Speakable.text(text)
        guard !said.isEmpty else { return }
        #if os(iOS)
        // Playback, so it is heard with the ringer switch on silent; other audio dips while it talks.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: .duckOthers)
        try? AVAudioSession.sharedInstance().setActive(true)
        #endif
        // The best voice installed (Enhanced or Premium when the owner added one), not the basic default.
        let u = SpeechVoice.utterance(said)
        speakingId = id
        synth.speak(u)
    }

    func stop() {
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        speakingId = nil
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { Task { @MainActor in self.ended() } }
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { Task { @MainActor in self.ended() } }

    /// A cancelled reply reports in after the next one has started; only clear when nothing is playing.
    private func ended() {
        guard !synth.isSpeaking else { return }
        speakingId = nil
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}
