#if !os(watchOS)
import AVFoundation
import EACore
import os

/// A tiny polyphonic synth for tap notes. Eight voices are rendered in an AVAudioSourceNode with no allocation
/// on the audio thread; a new note takes a free voice or the oldest one. The engine starts on the first note
/// and stops after 25 s of quiet. On iOS the session is `.ambient`, so it mixes with music and obeys the silent switch.
/// Engine and session calls run on a private serial queue: they can block for a while, never on the main thread.
///
/// A press is a note on with a handle (`press`), later moved (`bend`, `filter`) and ended (`release`). While the
/// finger is down the level only ever eases down, to a steady sustain for sine, glass, pad and chip and a quiet one
/// for pluck, bell and marimba. Released within about 300 ms, the note finishes along the short note's own fade;
/// held longer, lifting the finger fades it out over its release time. A held note ends on its own after 20 s.
final class FeelSynth: @unchecked Sendable {
    enum Voice: Int32, CaseIterable { case glass, sine, pluck, bell, marimba, chip, pad
        init(name: String) { self = Voice.allCases.first { "\($0)" == name } ?? .sine }
    }

    /// One note to start: pitch, synth, and a delay so an arpeggio can be queued at once.
    struct Note { var hz: Float; var voice: Voice; var delay: TimeInterval = 0 }

    /// Names a pressed note so it can be bent and released. Zero is never used.
    typealias Handle = UInt32

    private let queue = DispatchQueue(label: "everythingapp.feel-synth", qos: .userInteractive)

    /// Set just before the audio engine starts and cleared once it is running. Found set at launch, the app died
    /// while starting audio, so sound stays off on this device (`blocked`) until it is switched on again by hand.
    private static let startingKey = "ea.feel.audioStarting"
    private static let blockedKey = "ea.feel.audioBlocked"
    static var blocked: Bool { UserDefaults.standard.bool(forKey: blockedKey) }
    static func checkLastLaunch() {
        let d = UserDefaults.standard
        if d.bool(forKey: startingKey) { d.set(true, forKey: blockedKey); d.set(false, forKey: startingKey) }
    }
    static func unblock() { UserDefaults.standard.set(false, forKey: blockedKey) }
    // Touched only on `queue`.
    private var engine: AVAudioEngine?
    private var core: SynthCore?
    private var idleStop: DispatchWorkItem?
    private static let idleSeconds: TimeInterval = 25
    // Main thread only.
    private var nextHandle: Handle = 0

    /// Short notes (a tap with hold off, an arpeggio, a chord). `volume` is 0 to 1.
    func play(_ notes: [Note], volume: Float) {
        guard !notes.isEmpty, !Self.blocked else { return }
        let cmds = notes.map { SynthCore.Command(op: .start, handle: 0, hz: $0.hz, kind: $0.voice.rawValue,
                                                 delay: $0.delay, held: false, bend: false) }
        send(cmds, volume: volume)
    }

    /// A finger went down: start a note that can be held (`hold`) and bent (`bend`). Returns its handle.
    func press(hz: Float, voice: Voice, volume: Float, hold: Bool, bend: Bool) -> Handle? {
        guard !Self.blocked else { return nil }
        nextHandle = nextHandle == .max ? 1 : nextHandle + 1
        let h = nextHandle
        send([SynthCore.Command(op: .start, handle: h, hz: hz, kind: voice.rawValue, delay: 0, held: hold, bend: bend)], volume: volume)
        return h
    }

    /// Glide a pressed note to a new pitch.
    func bend(_ h: Handle, hz: Float) { send([SynthCore.Command(op: .pitch, handle: h, hz: hz)]) }

    /// Sweep a pressed note's low-pass filter.
    func filter(_ h: Handle, cutoff: Float, drive: Float) { send([SynthCore.Command(op: .cutoff, handle: h, hz: cutoff, drive: drive)]) }

    /// The finger lifted or the touch was cancelled.
    func release(_ h: Handle) { send([SynthCore.Command(op: .release, handle: h)]) }

    /// The app is going to the background: let every held note go.
    func releaseAll() { send([SynthCore.Command(op: .releaseAll)], start: false) }

    private func send(_ cmds: [SynthCore.Command], volume: Float? = nil, start: Bool = true) {
        queue.async { [self] in
            let core: SynthCore?
            if start { core = ensureRunning() } else { core = self.core }
            guard let core else { return }
            if let volume { core.setVolume(volume) }
            core.push(cmds)
            if start { scheduleStop() }
        }
    }

    private func ensureRunning() -> SynthCore? {
        // Session, engine and start can each abort inside Apple's audio code; mark the attempt so a crash is caught.
        if engine?.isRunning != true {
            UserDefaults.standard.set(true, forKey: Self.startingKey)
            UserDefaults.standard.synchronize()
        }
        defer { UserDefaults.standard.set(false, forKey: Self.startingKey) }
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        if session.category != .ambient { try? session.setCategory(.ambient, mode: .default, options: []) }
        #endif
        if engine == nil {
            #if os(iOS)
            try? session.setActive(true)
            #endif
            let e = AVAudioEngine()
            var rate = e.outputNode.outputFormat(forBus: 0).sampleRate
            if rate <= 0 { rate = 48000 }
            guard let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1) else { return nil }
            let c = SynthCore(sampleRate: rate)
            let node = AVAudioSourceNode(format: format) { isSilence, _, frames, abl in
                c.render(frames: Int(frames), into: abl, isSilence: isSilence)
                return noErr
            }
            e.attach(node)
            e.connect(node, to: e.mainMixerNode, format: format)
            engine = e
            core = c
        }
        guard let e = engine else { return nil }
        if !e.isRunning {
            #if os(iOS)
            try? session.setActive(true)
            #endif
            e.prepare()
            do { try e.start() } catch { return nil }
        }
        return core
    }

    private func scheduleStop() {
        idleStop?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self, let e = self.engine, e.isRunning else { return }
            e.stop()
            #if os(iOS)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            #endif
        }
        idleStop = w
        queue.asyncAfter(deadline: .now() + Self.idleSeconds, execute: w)
    }
}

/// Everything the audio thread touches, in fixed buffers allocated once. Other threads hand over commands through
/// a small fixed queue under an unfair lock that the render block only ever try-locks; a missed try waits one buffer.
/// Pitch, cutoff and volume changes are smoothed per sample, and filter coefficients follow every 16 samples.
final class SynthCore {
    enum Op: Int32 { case start, release, pitch, cutoff, releaseAll }

    struct Command {
        var op: Op
        var handle: UInt32 = 0
        var hz: Float = 0
        var kind: Int32 = 0
        var delay: TimeInterval = 0
        var held = false
        var bend = false
        var drive: Float = 0
    }

    private struct VoiceState {
        var active = false
        var kind: Int32 = 0
        var handle: UInt32 = 0
        var frame = 0              // frames since the note began; negative while waiting for its delay
        var length = 0
        var attack = 1
        var release = 1
        var hz: Double = 440       // current pitch, gliding toward `hzTarget`
        var hzTarget: Double = 440
        var gain: Float = 1
        var decay: Float = 1       // multiplied each frame
        var decayMul: Float = 1
        var aux: Float = 1         // a second, faster decay (bell index, marimba partial)
        var auxMul: Float = 1
        var p1: Double = 0, p2: Double = 0, p3: Double = 0
        var lp1: Float = 0, lp2: Float = 0, lpA: Float = 0
        var ksLen = 0, ksPos = 0
        var ksHz: Double = 0       // pitch the delay line is tuned to
        var ksFeedback: Float = 0.998
        var apC: Float = 0, apX: Float = 0, apY: Float = 0
        var serial: UInt64 = 0
        // Holding: `held` while the finger is down, easing toward `sustain` by `settleMul` a frame; `sustained` once
        // past the quick tap, so letting go fades over `heldRelease`.
        var held = false
        var sustained = false
        var holdAt = 0
        var heldFrames = 0
        var sustain: Float = 0
        var settleMul: Float = 1
        var heldRelease = 1
        var releasing = false
        var relPos = 0
        var relLen = 1
        var relStart: Float = 0
        var lastEnv: Float = 0
        // Bending: a resonant low-pass resting at 3.1 kHz that sideways moves sweep.
        var bend = false
        var cutoff: Float = 3000
        var cutoffTarget: Float = 3000
        var wet: Float = 0
        var wetTarget: Float = 0
        var drive: Float = 0
        var driveTarget: Float = 0
        var ic1: Float = 0, ic2: Float = 0
        var fa1: Float = 0, fa2: Float = 0, fa3: Float = 0
    }

    static let voices = 8
    static let queueSize = 128
    static let ksMax = 4096
    static let filterQ: Float = 4.5
    static let maxHoldSeconds = 20.0

    let sampleRate: Double
    private let state: UnsafeMutablePointer<VoiceState>
    private let ks: UnsafeMutablePointer<Float>
    private let queue: UnsafeMutablePointer<Command>
    private let lock: UnsafeMutablePointer<os_unfair_lock>
    private var queued = 0                 // guarded by lock
    private var pendingVolume: Float = 0.4 // guarded by lock
    private var volumeTarget: Float = 0.4  // audio thread only
    private var volume: Float = 0.4        // audio thread only, smoothed
    private var serial: UInt64 = 0         // audio thread only
    private var rng: UInt32 = 0x9E3779B9   // audio thread only
    private var blockCounter = 0           // audio thread only
    private let glideCoef: Double
    private let smoothCoef: Float
    private let maxHoldFrames: Int

    init(sampleRate: Double) {
        self.sampleRate = sampleRate
        state = .allocate(capacity: Self.voices)
        state.initialize(repeating: VoiceState(), count: Self.voices)
        ks = .allocate(capacity: Self.voices * Self.ksMax)
        ks.initialize(repeating: 0, count: Self.voices * Self.ksMax)
        queue = .allocate(capacity: Self.queueSize)
        queue.initialize(repeating: Command(op: .start), count: Self.queueSize)
        lock = .allocate(capacity: 1)
        lock.initialize(to: os_unfair_lock())
        // Pitch settles in about 50 ms; cutoff, drive and volume in about 20 ms.
        glideCoef = 1 - exp(-1 / (0.012 * sampleRate))
        smoothCoef = Float(1 - exp(-1 / (0.005 * sampleRate)))
        maxHoldFrames = Int(Self.maxHoldSeconds * sampleRate)
    }

    deinit {
        state.deallocate(); ks.deallocate(); queue.deallocate(); lock.deallocate()
    }

    func setVolume(_ v: Float) {
        os_unfair_lock_lock(lock)
        pendingVolume = max(0, min(1, v))
        os_unfair_lock_unlock(lock)
    }

    /// Queue commands for the next buffer. A pitch or cutoff replaces one still waiting for the same note, so a
    /// fast drag never fills the queue.
    func push(_ cmds: [Command]) {
        os_unfair_lock_lock(lock)
        for c in cmds {
            if c.op == .pitch || c.op == .cutoff {
                var replaced = false
                for i in 0..<queued where queue[i].op == c.op && queue[i].handle == c.handle {
                    queue[i] = c; replaced = true; break
                }
                if replaced { continue }
            }
            guard queued < Self.queueSize else { continue }
            queue[queued] = c
            queued += 1
        }
        os_unfair_lock_unlock(lock)
    }

    /// Whether any voice is sounding (for tests).
    var activeVoices: Int {
        var n = 0
        for v in 0..<Self.voices where state[v].active { n += 1 }
        return n
    }

    // MARK: audio thread

    func render(frames: Int, into abl: UnsafeMutablePointer<AudioBufferList>, isSilence: UnsafeMutablePointer<ObjCBool>) {
        if os_unfair_lock_trylock(lock) {
            volumeTarget = pendingVolume
            for i in 0..<queued { apply(queue[i]) }
            queued = 0
            os_unfair_lock_unlock(lock)
        }
        let buffers = UnsafeMutableAudioBufferListPointer(abl)
        guard let first = buffers.first, let raw = first.mData else { return }
        let out = raw.assumingMemoryBound(to: Float.self)
        var any = false
        for v in 0..<Self.voices where state[v].active { any = true; break }
        if !any {
            volume = volumeTarget
            for b in buffers { if let d = b.mData { memset(d, 0, Int(b.mDataByteSize)) } }
            isSilence.pointee = true
            return
        }
        for f in 0..<frames {
            if blockCounter & 15 == 0 { updateFilters() }
            blockCounter &+= 1
            volume += (volumeTarget - volume) * smoothCoef
            var mix: Float = 0
            for v in 0..<Self.voices where state[v].active { mix += sample(v) }
            mix *= volume * 0.32
            // Soft knee above 0.8 so many stacked voices round off instead of clipping.
            let m = abs(mix)
            if m > 0.8 { mix = (mix < 0 ? -1 : 1) * (0.8 + 0.2 * tanhf((m - 0.8) / 0.2)) }
            out[f] = mix
        }
        for b in buffers.dropFirst() { if let d = b.mData { memcpy(d, raw, Int(b.mDataByteSize)) } }
    }

    private func apply(_ c: Command) {
        switch c.op {
        case .start: start(c)
        case .release:
            for v in 0..<Self.voices where state[v].active && state[v].handle == c.handle && c.handle != 0 { letGo(v) }
        case .releaseAll:
            for v in 0..<Self.voices where state[v].active && state[v].handle != 0 { letGo(v) }
        case .pitch:
            for v in 0..<Self.voices where state[v].active && state[v].handle == c.handle && c.handle != 0 {
                state[v].hzTarget = Double(max(20, c.hz))
                if state[v].kind == FeelSynth.Voice.pluck.rawValue && state[v].sustained { tuneHeldPluck(v) }
            }
        case .cutoff:
            for v in 0..<Self.voices where state[v].active && state[v].handle == c.handle && c.handle != 0 && state[v].bend {
                state[v].cutoffTarget = max(40, min(Float(sampleRate) * 0.45, c.hz))
                state[v].wetTarget = 1
                state[v].driveTarget = max(0, min(1, c.drive))
            }
        }
    }

    /// The finger lifted: a quick tap goes on as the short note; a held one fades out over its release time.
    private func letGo(_ v: Int) {
        let s = state + v
        s.pointee.handle = 0
        guard s.pointee.held else { return }
        s.pointee.held = false
        if !s.pointee.sustained {
            // A quick tap: from this level down the short note's own fade, ending where that note would have.
            let left = s.pointee.length - max(0, s.pointee.frame)
            let end = powf(s.pointee.decayMul, Float(s.pointee.length))
            if left > 0, s.pointee.decay > end { s.pointee.decayMul = powf(end / s.pointee.decay, 1 / Float(left)) }
        } else if !s.pointee.releasing {
            s.pointee.releasing = true
            s.pointee.relPos = 0
            s.pointee.relLen = s.pointee.heldRelease
            s.pointee.relStart = s.pointee.lastEnv
        }
    }

    private func nextRandom() -> Float {
        rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5
        return Float(rng) / Float(UInt32.max) * 2 - 1
    }

    private func start(_ p: Command) {
        var idx = -1
        for v in 0..<Self.voices where !state[v].active { idx = v; break }
        if idx < 0 {
            idx = 0
            for v in 1..<Self.voices where state[v].serial < state[idx].serial { idx = v }
        }
        serial &+= 1
        let sr = sampleRate
        var s = VoiceState()
        s.active = true
        s.kind = p.kind
        s.handle = p.handle
        s.frame = -Int(p.delay * sr)
        s.hz = Double(max(20, p.hz))
        s.hzTarget = s.hz
        s.serial = serial
        s.held = p.held && p.handle != 0
        s.bend = p.bend && p.handle != 0
        // Seconds: attack, length, how fast the body decays (per second), and the held sustain, how fast a held
        // note eases to it, and its release.
        var attack = 0.004, length = 0.6, k: Double = 4.6 / 0.6
        var sustain: Float = 0.4, settle = 0.2, heldRelease = 0.15
        switch p.kind {
        case FeelSynth.Voice.glass.rawValue:
            attack = 0.004; length = 0.6; k = 4.6 / 0.6; s.gain = 0.9
            sustain = 0.4; settle = 0.2; heldRelease = 0.45
        case FeelSynth.Voice.sine.rawValue:
            attack = 0.008; length = 0.5; k = 4.0 / 0.5; s.gain = 1
            sustain = 0.45; settle = 0.25; heldRelease = 0.45
        case FeelSynth.Voice.pluck.rawValue:
            attack = 0.002; length = 0.8; k = 2.0 / 0.8; s.gain = 0.9
            sustain = 0.35; settle = 0.1; heldRelease = 0.35
        case FeelSynth.Voice.bell.rawValue:
            attack = 0.003; length = 1.2; k = 4.6 / 1.2; s.gain = 0.7
            s.auxMul = Float(exp(-3.5 / sr))
            sustain = 0.12; settle = 0.14; heldRelease = 0.8
        case FeelSynth.Voice.marimba.rawValue:
            attack = 0.002; length = 0.4; k = 4.6 / 0.4; s.gain = 0.7
            s.auxMul = Float(exp(-40 / sr))
            sustain = 0.12; settle = 0.047; heldRelease = 0.25
        case FeelSynth.Voice.chip.rawValue:
            attack = 0.002; length = 0.15; k = 2.0 / 0.15; s.gain = 0.3
            sustain = 0.45; settle = 0.05; heldRelease = 0.08
        case FeelSynth.Voice.pad.rawValue:
            attack = 0.04; length = 0.9; k = 3.0 / 0.9; s.gain = 1
            let fc = min(4000, s.hz * 4)
            s.lpA = Float(1 - exp(-2 * Double.pi * fc / sr))
            sustain = 0.7; settle = 0.2; heldRelease = 0.6
        default: break
        }
        s.attack = max(1, Int(attack * sr))
        s.length = Int(length * sr)
        s.release = max(1, Int(0.03 * sr))
        s.decayMul = Float(exp(-k / sr))
        s.sustain = sustain
        s.settleMul = Float(exp(-1 / (settle * sr)))
        s.heldRelease = max(1, Int(heldRelease * sr))
        // A quick tap is decided before the short note's own fade would end, so it can still finish along it.
        s.holdAt = min(Int(FeelBend.quickTap * sr), s.length - s.release - 1)
        s.cutoff = Float(FeelBend.restCutoff)
        s.cutoffTarget = s.cutoff
        s.wet = s.bend ? 1 : 0
        s.wetTarget = s.wet
        if p.kind == FeelSynth.Voice.pluck.rawValue {
            // Karplus-Strong: a noise burst in a delay line about one period long, tuned with an all-pass for the fraction.
            let buf = ks + idx * Self.ksMax
            memset(buf, 0, Self.ksMax * MemoryLayout<Float>.size)
            Self.tune(&s, hz: s.hz, sampleRate: sr)
            var prev: Float = 0
            for i in 0..<s.ksLen {
                let x = nextRandom()
                buf[i] = 0.5 * (x + prev)
                prev = x
            }
        }
        state[idx] = s
        if s.bend { computeFilter(idx) }
    }

    /// Delay line length and all-pass for a pitch. The two-point average shortens the loop by half a sample,
    /// so the line is half a sample longer than the period.
    private static func tune(_ s: inout VoiceState, hz: Double, sampleRate sr: Double) {
        let period = sr / max(20, hz) + 0.5
        var n = Int(period)
        var d = period - Double(n)
        if d < 0.1 { n -= 1; d += 1 }
        n = max(2, min(ksMax - 1, n))
        s.ksLen = n
        s.apC = Float((1 - d) / (1 + d))
        s.ksHz = hz
        if s.ksPos >= n { s.ksPos = 0 }
    }

    /// While held, the string loses only a little each second at its fundamental, so it rings on quietly.
    private func tuneHeldPluck(_ v: Int) {
        let hz = max(20, state[v].hzTarget)
        let perPeriod = pow(0.97, 1 / hz)
        let averaging = cos(Double.pi * hz / sampleRate)
        state[v].ksFeedback = Float(min(0.99995, perPeriod / max(0.5, averaging)))
    }

    /// Topology-preserving state variable low-pass coefficients for each bending voice's current cutoff.
    private func updateFilters() {
        for v in 0..<Self.voices where state[v].active && state[v].bend { computeFilter(v) }
    }

    private func computeFilter(_ v: Int) {
        let fc = Double(min(Float(sampleRate) * 0.45, max(40, state[v].cutoff)))
        let g = Float(tan(Double.pi * fc / sampleRate))
        let k = 1 / Self.filterQ
        let a1 = 1 / (1 + g * (g + k))
        state[v].fa1 = a1
        state[v].fa2 = g * a1
        state[v].fa3 = g * g * a1
    }

    @inline(__always)
    private func sample(_ v: Int) -> Float {
        let s = state + v
        if s.pointee.frame < 0 { s.pointee.frame += 1; return 0 }
        let f = s.pointee.frame
        let held = s.pointee.held, sustained = s.pointee.sustained, releasing = s.pointee.releasing
        if !held && !sustained && f >= s.pointee.length { s.pointee.active = false; return 0 }
        let sr = sampleRate
        let twoPi = 2 * Double.pi
        if s.pointee.hz != s.pointee.hzTarget {
            let d = s.pointee.hzTarget - s.pointee.hz
            s.pointee.hz = abs(d) < 0.01 ? s.pointee.hzTarget : s.pointee.hz + d * glideCoef
        }
        let hz = s.pointee.hz
        var x: Float = 0
        switch s.pointee.kind {
        case FeelSynth.Voice.glass.rawValue:
            let p = s.pointee.p1
            let tri = Float(4 * abs(p - 0.5) - 1)
            x = 0.8 * tri + 0.2 * Float(sin(twoPi * s.pointee.p2))
            s.pointee.p1 = advance(p, hz / sr)
            s.pointee.p2 = advance(s.pointee.p2, hz * 2.006 / sr)
        case FeelSynth.Voice.sine.rawValue:
            x = Float(sin(twoPi * s.pointee.p1))
            s.pointee.p1 = advance(s.pointee.p1, hz / sr)
        case FeelSynth.Voice.pluck.rawValue:
            if abs(hz - s.pointee.ksHz) > 0.01 { Self.tune(&s.pointee, hz: hz, sampleRate: sr) }
            let buf = ks + v * Self.ksMax
            let n = s.pointee.ksLen
            let pos = s.pointee.ksPos
            let a = buf[pos]
            let b = buf[pos + 1 < n ? pos + 1 : 0]
            let avg = 0.5 * (a + b) * s.pointee.ksFeedback
            let c = s.pointee.apC
            let y = c * avg + s.pointee.apX - c * s.pointee.apY
            s.pointee.apX = avg
            s.pointee.apY = y
            buf[pos] = y
            s.pointee.ksPos = pos + 1 < n ? pos + 1 : 0
            x = a
        case FeelSynth.Voice.bell.rawValue:
            let index = 3.2 * Double(s.pointee.aux)
            x = Float(sin(twoPi * s.pointee.p1 + index * sin(twoPi * s.pointee.p2)))
            s.pointee.p1 = advance(s.pointee.p1, hz / sr)
            s.pointee.p2 = advance(s.pointee.p2, hz * 3.5 / sr)
            s.pointee.aux *= s.pointee.auxMul
        case FeelSynth.Voice.marimba.rawValue:
            x = Float(sin(twoPi * s.pointee.p1)) + 0.5 * s.pointee.aux * Float(sin(twoPi * s.pointee.p2))
            s.pointee.p1 = advance(s.pointee.p1, hz / sr)
            s.pointee.p2 = advance(s.pointee.p2, hz * 4 / sr)
            s.pointee.aux *= s.pointee.auxMul
        case FeelSynth.Voice.chip.rawValue:
            x = s.pointee.p1 < 0.5 ? 1 : -1
            s.pointee.p1 = advance(s.pointee.p1, hz / sr)
        case FeelSynth.Voice.pad.rawValue:
            let saw = Float(2 * s.pointee.p1 - 1) + Float(2 * s.pointee.p2 - 1)
            s.pointee.p1 = advance(s.pointee.p1, hz * 0.994 / sr)
            s.pointee.p2 = advance(s.pointee.p2, hz * 1.006 / sr)
            let a = s.pointee.lpA
            s.pointee.lp1 += a * (0.5 * saw - s.pointee.lp1)
            s.pointee.lp2 += a * (s.pointee.lp1 - s.pointee.lp2)
            x = s.pointee.lp2
        default: break
        }
        if s.pointee.bend {
            // Cutoff glides per sample.
            s.pointee.cutoff += (s.pointee.cutoffTarget - s.pointee.cutoff) * smoothCoef
            s.pointee.wet += (s.pointee.wetTarget - s.pointee.wet) * smoothCoef
            // Saturation ahead of the filter gives a plain wave overtones to cut, like driving a synth's filter.
            s.pointee.drive += (s.pointee.driveTarget - s.pointee.drive) * smoothCoef
            let dr = s.pointee.drive
            if dr > 0.001 {
                let g = 1 + 5 * dr
                x += dr * (tanhf(g * x) / tanhf(g) - x)
            }
            let v3 = x - s.pointee.ic2
            let v1 = s.pointee.fa1 * s.pointee.ic1 + s.pointee.fa2 * v3
            let v2 = s.pointee.ic2 + s.pointee.fa2 * s.pointee.ic1 + s.pointee.fa3 * v3
            s.pointee.ic1 = 2 * v1 - s.pointee.ic1
            s.pointee.ic2 = 2 * v2 - s.pointee.ic2
            let w = s.pointee.wet
            x = x * (1 - w) + v2 * 0.8 * w
        }
        let att = f < s.pointee.attack ? Float(f) / Float(s.pointee.attack) : 1
        var env: Float
        if releasing {
            let r = s.pointee.relPos
            // A curved fade, like a voice's natural decay, that still lands exactly on zero.
            let t = Float(r) / Float(s.pointee.relLen)
            env = s.pointee.relStart * expf(-4.6 * t) * (1 - t)
            s.pointee.relPos = r + 1
            if r + 1 >= s.pointee.relLen { s.pointee.active = false }
        } else if held || sustained {
            // Held: the level eases from the peak down to the sustain and stays there; it never rises.
            let sus = s.pointee.sustain
            s.pointee.decay = sus + (s.pointee.decay - sus) * s.pointee.settleMul
            env = att * s.pointee.decay
            if !sustained && f >= s.pointee.holdAt {
                s.pointee.sustained = true
                if s.pointee.kind == FeelSynth.Voice.pluck.rawValue { tuneHeldPluck(v) }
            }
            s.pointee.heldFrames += 1
            if s.pointee.heldFrames >= maxHoldFrames {
                s.pointee.held = true
                s.pointee.handle = 0
                letGo(v)
            }
        } else {
            let left = s.pointee.length - f
            let rel = left < s.pointee.release ? Float(left) / Float(s.pointee.release) : 1
            env = att * rel * s.pointee.decay
            s.pointee.decay *= s.pointee.decayMul
        }
        s.pointee.lastEnv = env
        s.pointee.frame = f + 1
        return x * env * s.pointee.gain
    }

    @inline(__always)
    private func advance(_ p: Double, _ step: Double) -> Double {
        let n = p + step
        return n >= 1 ? n - 1 : n
    }
}
#endif
