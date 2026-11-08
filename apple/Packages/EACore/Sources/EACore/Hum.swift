import Foundation

/// `fields.midi` of a music idea made from a hum (hub `hum.ts`): the notes the hub heard in a hummed melody or a
/// tapped rhythm. `state` is `listening` until the hub has heard it; the notes, tempo, key and title then arrive by sync.
public struct HumMidi: Codable, Equatable, Sendable {
    public enum Mode: String, Codable, CaseIterable, Sendable {
        case melody, rhythm
    }

    public enum State: String, Codable, Sendable {
        case listening, done, failed
    }

    /// One note: `p` MIDI pitch (36 kick, 38 snare, 42 hat in a rhythm), `s` start and `d` length in seconds from
    /// the first note, `v` velocity 1 to 127.
    public struct Note: Codable, Equatable, Hashable, Sendable {
        public var p: Int
        public var s: Double
        public var d: Double
        public var v: Int

        public init(p: Int, s: Double, d: Double, v: Int) {
            self.p = p; self.s = s; self.d = d; self.v = v
        }

        enum CodingKeys: String, CodingKey { case p, s, d, v }

        // Numbers are read as doubles and clamped, so a 60.0 or a stray value never drops the whole idea.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            p = min(127, max(0, Int(try c.decode(Double.self, forKey: .p).rounded())))
            s = max(0, try c.decode(Double.self, forKey: .s))
            d = max(0, try c.decodeIfPresent(Double.self, forKey: .d) ?? 0)
            v = min(127, max(1, Int((try c.decodeIfPresent(Double.self, forKey: .v) ?? 100).rounded())))
        }
    }

    /// The drum a rhythm note is drawn and played as, top lane first. The hub sends 36, 38 and 42; anything else
    /// goes to the nearest of them.
    public enum Drum: Int, CaseIterable, Sendable {
        case hat, snare, kick

        public var name: String {
            switch self {
            case .hat: return "Hat"
            case .snare: return "Snare"
            case .kick: return "Kick"
            }
        }
    }

    public static let kick = 36, snare = 38, hat = 42

    public var source: String
    public var mode: Mode
    public var state: State
    public var error: String?
    public var seconds: Double?
    public var notes: [Note]

    public init(source: String = "hum", mode: Mode, state: State, error: String? = nil, seconds: Double? = nil, notes: [Note] = []) {
        self.source = source; self.mode = mode; self.state = state; self.error = error; self.seconds = seconds; self.notes = notes
    }

    enum CodingKeys: String, CodingKey { case source, mode, state, error, seconds, notes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? "hum"
        mode = (try? c.decodeIfPresent(String.self, forKey: .mode)).flatMap(Mode.init(rawValue:)) ?? .melody
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        seconds = try? c.decodeIfPresent(Double.self, forKey: .seconds)
        // A malformed note is left out; the rest still show.
        notes = (try? c.decodeIfPresent([Lenient<Note>].self, forKey: .notes))?.compactMap(\.value) ?? []
        // A state from a newer hub reads as done when there are notes to show, else as still listening.
        state = (try? c.decodeIfPresent(String.self, forKey: .state)).flatMap(State.init(rawValue:)) ?? (notes.isEmpty ? .listening : .done)
    }

    /// Where the last note ends, in seconds.
    public var length: Double { notes.map { $0.s + $0.d }.max() ?? 0 }

    /// "24 notes" or "16 hits".
    public var countText: String {
        let word = mode == .rhythm ? "hit" : "note"
        return notes.count == 1 ? "1 \(word)" : "\(notes.count) \(word)s"
    }

    /// What the app calls it before the hub names it.
    public var kindName: String { mode == .rhythm ? "Tapped rhythm" : "Hummed melody" }

    public static func drum(_ pitch: Int) -> Drum {
        if pitch <= 37 { return .kick }
        if pitch <= 40 { return .snare }
        return .hat
    }

    /// The pitches a piano roll shows, low to high: the notes with two semitones either side, at least an octave.
    public var pitchRange: ClosedRange<Int> {
        guard let lo = notes.map(\.p).min(), let hi = notes.map(\.p).max() else { return 57...72 }
        var a = lo - 2, b = hi + 2
        while b - a < 12 { a -= 1; if b - a < 12 { b += 1 } }
        a = max(0, a); b = min(127, b)
        return a...b
    }

    /// "C4" for 60.
    public static func noteName(_ pitch: Int) -> String {
        let names = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
        return "\(names[((pitch % 12) + 12) % 12])\(pitch / 12 - 1)"
    }

    /// A format 0 MIDI file of the notes for playing on this device, at 120 BPM so one second is 960 ticks and the
    /// timing stays as heard. The hub's `GET /music/<id>/midi` makes the file for a DAW, at the idea's own tempo.
    public func playbackMIDIFile(channel: UInt8 = 0) -> Data {
        let perSecond = 960.0
        // Note offs sort before note ons at the same tick, so a repeated pitch is not cut short.
        var events: [(tick: Int, order: Int, bytes: [UInt8])] = []
        for n in notes {
            let on = max(0, Int((n.s * perSecond).rounded()))
            // Very short notes still sound.
            let off = on + max(24, Int((n.d * perSecond).rounded()))
            events.append((on, 1, [0x90 | (channel & 0x0F), UInt8(n.p), UInt8(n.v)]))
            events.append((off, 0, [0x80 | (channel & 0x0F), UInt8(n.p), 0]))
        }
        events.sort { $0.tick != $1.tick ? $0.tick < $1.tick : $0.order < $1.order }

        var track: [UInt8] = [0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20] // tempo 500,000 us a quarter: 120 BPM
        var last = 0
        for e in events {
            track += Self.vlq(e.tick - last) + e.bytes
            last = e.tick
        }
        track += [0x00, 0xFF, 0x2F, 0x00]

        var out: [UInt8] = Array("MThd".utf8) + Self.be32(6) + [0x00, 0x00, 0x00, 0x01, 0x01, 0xE0] // format 0, 1 track, 480 a quarter
        out += Array("MTrk".utf8) + Self.be32(track.count) + track
        return Data(out)
    }

    static func vlq(_ value: Int) -> [UInt8] {
        var v = max(0, value)
        var bytes: [UInt8] = [UInt8(v & 0x7F)]
        v >>= 7
        while v > 0 {
            bytes.insert(UInt8(v & 0x7F) | 0x80, at: 0)
            v >>= 7
        }
        return bytes
    }

    static func be32(_ v: Int) -> [UInt8] { [UInt8((v >> 24) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)] }
}

/// A `music_idea`'s fields (contract section 2, `MusicIdeaFields` in packages/shared). `midi` is there only for an
/// idea made from a hum, and an idea from an older hub has none.
public struct MusicIdeaFields: Codable, Equatable, Sendable {
    public var title: String
    public var type: String
    public var body: String
    public var key: String?
    public var bpm: Double?
    public var time_sig: String?
    public var tuning: String?
    public var status: String
    public var tags: [String]
    public var project_id: String?
    public var audio_ref: String?
    public var midi: HumMidi?

    public init(title: String, type: String = "riff", body: String = "", key: String? = nil, bpm: Double? = nil, time_sig: String? = nil,
                tuning: String? = nil, status: String = "idea", tags: [String] = [], project_id: String? = nil, audio_ref: String? = nil, midi: HumMidi? = nil) {
        self.title = title; self.type = type; self.body = body; self.key = key; self.bpm = bpm; self.time_sig = time_sig
        self.tuning = tuning; self.status = status; self.tags = tags; self.project_id = project_id; self.audio_ref = audio_ref; self.midi = midi
    }

    enum CodingKeys: String, CodingKey { case title, type, body, key, bpm, time_sig, tuning, status, tags, project_id, audio_ref, midi }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "riff"
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        key = try c.decodeIfPresent(String.self, forKey: .key)
        bpm = try c.decodeIfPresent(Double.self, forKey: .bpm)
        time_sig = try c.decodeIfPresent(String.self, forKey: .time_sig)
        tuning = try c.decodeIfPresent(String.self, forKey: .tuning)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "idea"
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        project_id = try c.decodeIfPresent(String.self, forKey: .project_id)
        audio_ref = try c.decodeIfPresent(String.self, forKey: .audio_ref)
        // A midi block this app cannot read never hides the idea itself.
        midi = try? c.decodeIfPresent(HumMidi.self, forKey: .midi)
    }
}

extension Entity {
    /// The hummed notes of a music idea; nil for an idea typed by hand or one from a hub older than hum to MIDI.
    public var humMidi: HumMidi? {
        guard kind == .music_idea, let v = fields["midi"], case .object = v else { return nil }
        return try? JSONCoding.typed(HumMidi.self, from: v)
    }
}

/// Short drum sounds made from scratch for playing a tapped rhythm on the device: a low sine thump for the kick, a
/// noise burst for the snare and a short high hiss for the hat. Pure math, so the same notes always give the same samples.
public enum HumDrums {
    /// The whole rhythm as mono samples at `sampleRate`, every hit scaled by its velocity, kept under full scale.
    public static func render(_ notes: [HumMidi.Note], sampleRate: Double = 44_100) -> [Float] {
        guard !notes.isEmpty, sampleRate > 0 else { return [] }
        var sounds: [HumMidi.Drum: [Float]] = [:]
        for d in HumMidi.Drum.allCases { sounds[d] = hit(d, sampleRate: sampleRate) }
        let longest = sounds.values.map(\.count).max() ?? 0
        let lastStart = notes.map(\.s).max() ?? 0
        var out = [Float](repeating: 0, count: Int((lastStart * sampleRate).rounded(.up)) + longest + 1)
        for n in notes {
            guard let sound = sounds[HumMidi.drum(n.p)] else { continue }
            let at = max(0, Int((n.s * sampleRate).rounded()))
            let gain = Float(min(127, max(1, n.v))) / 127
            for i in 0..<sound.count where at + i < out.count { out[at + i] += sound[i] * gain }
        }
        let peak = out.reduce(Float(0)) { max($0, abs($1)) }
        if peak > 0.95 {
            let k = 0.95 / peak
            for i in out.indices { out[i] *= k }
        }
        return out
    }

    /// One hit at full velocity.
    public static func hit(_ drum: HumMidi.Drum, sampleRate sr: Double) -> [Float] {
        var noise = Noise(seed: UInt64(drum.rawValue + 1))
        switch drum {
        case .kick:
            // The pitch falls from about 200 Hz to 50 Hz, so small speakers still hear the start of it.
            let n = Int(0.3 * sr)
            var out = [Float](repeating: 0, count: n)
            var phase = 0.0
            for i in 0..<n {
                let t = Double(i) / sr
                phase += 2 * .pi * (50 + 150 * exp(-t / 0.03)) / sr
                out[i] = Float(sin(phase) * exp(-t / 0.09) * 0.95)
            }
            return out
        case .snare:
            let n = Int(0.2 * sr)
            var out = [Float](repeating: 0, count: n)
            for i in 0..<n {
                let t = Double(i) / sr
                let tone = sin(2 * .pi * 185 * t) * exp(-t / 0.04) * 0.35
                out[i] = Float(tone + noise.next() * exp(-t / 0.06) * 0.55)
            }
            return out
        case .hat:
            // The difference of two noise samples keeps only the high end: a hiss.
            let n = Int(0.08 * sr)
            var out = [Float](repeating: 0, count: n)
            var prev = 0.0
            for i in 0..<n {
                let t = Double(i) / sr
                let x = noise.next()
                out[i] = Float((x - prev) * 0.5 * exp(-t / 0.018) * 0.6)
                prev = x
            }
            return out
        }
    }

    /// A small fixed-seed generator, so a rhythm sounds the same every time and the tests can rely on it.
    struct Noise {
        var state: UInt64
        init(seed: UInt64) { state = seed &* 0x9E3779B97F4A7C15 }
        mutating func next() -> Double {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Double(state >> 11) / Double(UInt64(1) << 53) * 2 - 1
        }
    }
}
