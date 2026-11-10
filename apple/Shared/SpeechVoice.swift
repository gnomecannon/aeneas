import AVFoundation

/// The voice answers are read in: the best one installed for the device's language. Premium, then Enhanced, then the
/// default voice; novelty voices (Bells, Zarvox) never. Apple keeps the Siri voices for Siri itself, so an app cannot
/// use them; Enhanced and Premium voices are the closest, and the owner adds them in the system's Settings,
/// Accessibility, Spoken Content (or Read and Speak), Voices. A voice chosen there for Spoken Content is used instead
/// (`prefersAssistiveTechnologySettings`).
enum SpeechVoice {
    static func best(for language: String = AVSpeechSynthesisVoice.currentLanguageCode()) -> AVSpeechSynthesisVoice? {
        let base = language.split(separator: "-").first.map(String.init) ?? language
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { !$0.voiceTraits.contains(.isNoveltyVoice) && !$0.voiceTraits.contains(.isPersonalVoice) }
        let exact = voices.filter { $0.language == language }
        let pool = exact.isEmpty ? voices.filter { $0.language.hasPrefix(base + "-") } : exact
        let pick = pool.max { rank($0) < rank($1) }
        return pick ?? AVSpeechSynthesisVoice(language: language)
    }

    /// Quality first; among equals the system's own default for the language, so nothing changes until a better voice
    /// is installed.
    private static func rank(_ v: AVSpeechSynthesisVoice) -> Int {
        let q: Int
        switch v.quality {
        case .premium: q = 3
        case .enhanced: q = 2
        default: q = 1
        }
        let isDefault = v.identifier == AVSpeechSynthesisVoice(language: v.language)?.identifier
        return q * 10 + (isDefault ? 1 : 0)
    }

    /// An utterance in that voice, or in the one the owner picked for Spoken Content.
    static func utterance(_ text: String) -> AVSpeechUtterance {
        let u = AVSpeechUtterance(string: text)
        u.voice = best()
        u.prefersAssistiveTechnologySettings = true
        return u
    }
}
