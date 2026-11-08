import SwiftUI
import UniformTypeIdentifiers
import EACore
#if os(macOS)
import AppKit
#endif

/// Hum to MIDI on the device: sending a take, and the files handed to a DAW.
enum Hum {
    /// A typed tempo the hub takes (30 to 300 BPM), or nil to let the hub find it.
    static func tempo(_ text: String) -> Double? {
        let t = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard let v = Double(t), (30...300).contains(v) else { return nil }
        return v.rounded()
    }

    /// The hub's lower-case reason as a sentence: "No notes were heard; hum a little louder or closer."
    static func sentence(_ text: String?) -> String? {
        guard let t = text?.trimmingCharacters(in: .whitespacesAndNewlines), let first = t.first else { return nil }
        let s = first.uppercased() + t.dropFirst()
        return ".!?".contains(s.last!) ? s : s + "."
    }

    /// "1:05".
    static func clock(_ t: TimeInterval) -> String {
        let s = max(0, Int(t))
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }

    /// Sends a take; the idea comes back at once and goes in the local store, and the recording leaves the device.
    @MainActor
    static func send(_ take: HumTake, mode: HumMidi.Mode, bpm: Double?, fromCapture: Bool, engine: SyncEngine) async throws -> Entity {
        guard let c = engine.client else { throw HubError.notConfigured }
        let e = try await c.uploadHum(fileURL: take.url, mode: mode, bpm: bpm, fromCapture: fromCapture, clientId: "app-\(take.id.uuidString.lowercased())")
        await engine.absorb(e)
        engine.moment(.create, kind: .music_idea)
        try? FileManager.default.removeItem(at: take.url)
        return e
    }

    /// Writes the hub's .mid to a temporary file named from the hub's name, one folder per idea and timing.
    static func write(_ m: HumMIDIFile, ideaId: String, grid: Bool) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("hum-midi", isDirectory: true)
            .appendingPathComponent(ideaId, isDirectory: true)
            .appendingPathComponent(grid ? "grid" : "hummed", isDirectory: true)
        try? FileManager.default.removeItem(at: dir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let name = grid ? m.name : (m.name as NSString).deletingPathExtension + " as hummed.mid"
        let url = dir.appendingPathComponent(name)
        // Complete protection: made for the share sheet or a drag from the open app.
        try DataProtection.write(m.data, to: url, .complete)
        return url
    }

    /// What a drag carries: the file itself and its URL, which Cubase, Ableton and the Finder all take.
    static func dragProvider(_ url: URL) -> NSItemProvider {
        let p = NSItemProvider(contentsOf: url) ?? NSItemProvider(object: url as NSURL)
        p.suggestedName = url.deletingPathExtension().lastPathComponent
        return p
    }
}

// MARK: recording

/// Elapsed time, a live level meter, Stop and Cancel. With `mode` it also lets you pick melody or rhythm while you record.
struct HumRecordingPanel: View {
    @ObservedObject var recorder: HumRecorder
    var mode: Binding<HumMidi.Mode>? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let mode {
                HumModePicker(mode: mode)
            }
            HStack(spacing: 8) {
                Circle().fill(.red).frame(width: 10, height: 10)
                Text("Recording").font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(Hum.clock(recorder.elapsed)) of \(Hum.clock(HumRecorder.maxSeconds))")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            HumLevelMeter(level: recorder.level)
            HStack {
                Button(role: .cancel) { recorder.cancel() } label: { Label("Cancel", systemImage: "xmark") }
                    .buttonStyle(.bordered)
                Spacer()
                Button { recorder.stop() } label: { Label("Stop", systemImage: "stop.fill") }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(.vertical, 4)
    }
}

struct HumModePicker: View {
    @Binding var mode: HumMidi.Mode
    var body: some View {
        Picker("Hum", selection: $mode) {
            Text("Melody").tag(HumMidi.Mode.melody)
            Text("Rhythm").tag(HumMidi.Mode.rhythm)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
    }
}

struct HumLevelMeter: View {
    var level: Float

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.2))
                LinearGradient(colors: [.green, .green, .yellow, .red], startPoint: .leading, endPoint: .trailing)
                    .mask(alignment: .leading) {
                        Capsule().frame(width: max(0, g.size.width * CGFloat(level)))
                    }
            }
        }
        .frame(height: 8)
        .animation(.linear(duration: 0.08), value: level)
        .accessibilityElement()
        .accessibilityLabel("Input level")
        .accessibilityValue("\(Int(level * 100)) percent")
    }
}

// MARK: piano roll

/// Time runs left to right and pitch upward; a rhythm has three lanes, hat, snare and kick. Beat lines follow the
/// tempo, counted from the first note as the hub's grid is. Long hums scroll sideways.
struct HumRoll: View {
    var midi: HumMidi
    var bpm: Double?
    @ObservedObject var player: HumPlayer
    @State private var available: CGFloat = 300

    private let height: CGFloat = 200
    private let gutter: CGFloat = 40

    private var rows: [Int] {
        midi.mode == .rhythm ? HumMidi.Drum.allCases.map(\.rawValue) : Array(midi.pitchRange.reversed())
    }

    private func row(of p: Int) -> Int {
        midi.mode == .rhythm ? HumMidi.drum(p).rawValue : midi.pitchRange.upperBound - p
    }

    var body: some View {
        let length = max(midi.length, 1)
        // About 50 points a second, never narrower than the screen, and capped so a long hum stays a light drawing.
        let width = min(max(available, CGFloat(length) * 50), 2400)
        HStack(spacing: 0) {
            Canvas { ctx, size in drawLabels(&ctx, size) }
                .frame(width: gutter, height: height)
            ScrollView(.horizontal) {
                ZStack(alignment: .topLeading) {
                    Canvas { ctx, size in drawNotes(&ctx, size, length: length) }
                    if player.playing == .notes, let start = player.startedAt {
                        TimelineView(.animation) { tl in
                            let x = CGFloat(tl.date.timeIntervalSince(start) / length) * width
                            Rectangle().fill(Color.accentColor).frame(width: 2, height: height).offset(x: min(x, width - 2))
                        }
                    }
                }
                .frame(width: width, height: height)
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { available = $0 }
        }
        .frame(height: height)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement()
        .accessibilityLabel(midi.mode == .rhythm ? "Rhythm lanes" : "Piano roll")
        .accessibilityValue(midi.countText)
    }

    private func rowHeight(_ size: CGSize) -> CGFloat { size.height / CGFloat(max(1, rows.count)) }

    private func drawLabels(_ ctx: inout GraphicsContext, _ size: CGSize) {
        let h = rowHeight(size)
        for (i, p) in rows.enumerated() {
            let label: String?
            if midi.mode == .rhythm { label = HumMidi.Drum(rawValue: p)?.name }
            else { label = p % 12 == 0 || rows.count <= 16 ? HumMidi.noteName(p) : nil }
            guard let label else { continue }
            ctx.draw(Text(label).font(.system(size: min(11, max(8, h * 0.8)))).foregroundColor(.secondary),
                     at: CGPoint(x: 4, y: CGFloat(i) * h + h / 2), anchor: .leading)
        }
    }

    private func drawNotes(_ ctx: inout GraphicsContext, _ size: CGSize, length: Double) {
        let h = rowHeight(size)
        let perSecond = size.width / CGFloat(length)
        // Black keys and every other drum lane are shaded, so a row is easy to follow across.
        for (i, p) in rows.enumerated() {
            let shaded = midi.mode == .rhythm ? i % 2 == 1 : [1, 3, 6, 8, 10].contains(p % 12)
            if shaded { ctx.fill(Path(CGRect(x: 0, y: CGFloat(i) * h, width: size.width, height: h)), with: .color(.secondary.opacity(0.08))) }
        }
        if let bpm, bpm > 0 {
            let beat = 60 / bpm
            var n = 0
            var t = 0.0
            while t <= length {
                let x = CGFloat(t) * perSecond
                ctx.fill(Path(CGRect(x: x, y: 0, width: n % 4 == 0 ? 1 : 0.5, height: size.height)),
                         with: .color(.secondary.opacity(n % 4 == 0 ? 0.35 : 0.15)))
                n += 1
                t = Double(n) * beat
            }
        }
        for note in midi.notes {
            let x = CGFloat(note.s) * perSecond
            let w = max(midi.mode == .rhythm ? 5 : 3, CGFloat(note.d) * perSecond - 1)
            let y = CGFloat(row(of: note.p)) * h
            let rect = CGRect(x: x, y: y + 1, width: w, height: max(2, h - 2))
            ctx.fill(Path(roundedRect: rect, cornerRadius: min(3, h / 3)), with: .color(Color.accentColor.opacity(0.45 + 0.55 * Double(note.v) / 127)))
        }
    }
}

// MARK: a hummed idea

/// What a music idea made from a hum shows: Listening until the notes arrive (or why it failed), then the piano
/// roll, playing, the MIDI file for a DAW, and hearing the recording again as the other mode or at a set tempo.
struct HumIdeaSections: View {
    @EnvironmentObject var engine: SyncEngine
    var idea: Entity
    var midi: HumMidi
    /// Owned by the idea's screen, so playing stops when that screen goes, not when a row scrolls away.
    @ObservedObject var player: HumPlayer

    @State private var grid = true
    @State private var file: URL?
    /// What the current file was made from: the notes and timing, then also the title and tempo.
    @State private var fileFor: String?
    @State private var fileKeyDone: String?
    @State private var fileError: String?
    @State private var fileTry = 0
    @State private var recording: Data?
    @State private var loadingRecording = false
    @State private var tempo = ""
    @State private var busy = false
    @State private var error: String?

    private var heard: Bool { midi.state == .done && !midi.notes.isEmpty }
    private var bpm: Double? { idea.number("bpm") }

    /// The hub's file follows the notes, the timing choice, the title (its name) and the tempo.
    private var fileKey: String {
        "\(idea.id)|\(grid)|\(idea.field_ts["midi"] ?? "")|\(idea.str("title"))|\(bpm.map { Making.num($0) } ?? "")|\(fileTry)"
    }

    var body: some View {
        SwiftUI.Section {
            switch midi.state {
            case .listening: listening
            case .failed: failed
            case .done: if heard { notes } else { failed }
            }
            if let e = error { MakingErrorLine(text: e) }
        } header: {
            Text(midi.kindName)
        }

        if heard {
            SwiftUI.Section {
                export
            } header: {
                Text("MIDI for your DAW")
            } footer: {
                #if os(macOS)
                Text("Drag the file onto a MIDI track in Cubase or Ableton, or save it. Snapped puts every note on the nearest 1/16.")
                #else
                Text("AirDrop it to the Mac or save it to Files, then drag it onto a MIDI track. Snapped puts every note on the nearest 1/16.")
                #endif
            }
            .task(id: fileKey) { await loadFile() }
        }

        if midi.state != .listening {
            SwiftUI.Section {
                Button { Task { await rehear(mode: midi.mode == .melody ? .rhythm : .melody, bpm: Hum.tempo(tempo)) } } label: {
                    Label(midi.mode == .melody ? "Hear again as rhythm" : "Hear again as melody", systemImage: "arrow.triangle.2.circlepath")
                }
                .disabled(busy)
                LabeledContent("Tempo") {
                    HStack(spacing: 8) {
                        TextField(bpm.map { Making.num($0) } ?? "BPM", text: $tempo)
                            .multilineTextAlignment(.trailing)
                            .font(.body.monospaced())
                            .numericKeyboard()
                            .frame(maxWidth: 90)
                        Button("Hear again") { Task { await rehear(mode: nil, bpm: Hum.tempo(tempo)) } }
                            .buttonStyle(.borderless)
                            .disabled(busy || Hum.tempo(tempo) == nil)
                    }
                }
            } header: {
                Text("Hear it again")
            } footer: {
                Text("The hub listens to the kept recording again. Type a tempo from 30 to 300 to set it; leave it empty and the hub finds one.")
            }
        }
    }

    private var listening: some View {
        HStack(spacing: 12) {
            ProgressView()
            VStack(alignment: .leading, spacing: 2) {
                Text("Listening")
                Text(midi.mode == .rhythm
                     ? "The hub is finding the hits. This takes a few seconds."
                     : "The hub is hearing the notes. This takes about \(Int(((midi.seconds ?? 10) * 1.2).rounded(.up)) + 3) seconds.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private var failed: some View {
        VStack(alignment: .leading, spacing: 10) {
            MakingErrorLine(text: StyleGuard.dashes(Hum.sentence(midi.error) ?? "The hub could not hear it."))
            recordingButton
        }
        .padding(.vertical, 4)
    }

    private var notes: some View {
        VStack(alignment: .leading, spacing: 10) {
            HumRoll(midi: midi, bpm: bpm, player: player)
            HStack(spacing: 14) {
                if midi.mode == .melody, let k = idea.string("key"), !k.isEmpty { Text(k) }
                if let b = bpm { Text("\(Making.num(b)) BPM") }
                Text(midi.countText)
            }
            .font(.callout.monospaced())
            .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button {
                    if player.playing == .notes { player.stop() } else { player.playNotes(midi) }
                } label: {
                    Label(player.playing == .notes ? "Stop" : "Play", systemImage: player.playing == .notes ? "stop.fill" : "play.fill")
                }
                .buttonStyle(.borderedProminent)
                recordingButton
            }
            if let e = player.error { MakingErrorLine(text: e) }
        }
        .padding(.vertical, 4)
    }

    private var recordingButton: some View {
        HStack(spacing: 8) {
            Button { Task { await toggleRecording() } } label: {
                Label(player.playing == .recording ? "Stop" : "Play the recording", systemImage: player.playing == .recording ? "stop.fill" : "waveform")
            }
            .buttonStyle(.bordered)
            .disabled(loadingRecording)
            if loadingRecording { ProgressView().controlSize(.small) }
        }
    }

    @ViewBuilder private var export: some View {
        Picker("Timing", selection: $grid) {
            Text("Snapped to the grid").tag(true)
            Text("As hummed").tag(false)
        }
        if let url = file {
            #if os(macOS)
            HStack(spacing: 12) {
                HumDragChip(url: url)
                Spacer()
                Button { save(url) } label: { Label("Save MIDI", systemImage: "square.and.arrow.down") }
            }
            #else
            ShareLink(item: url, preview: SharePreview(url.lastPathComponent)) {
                Label("Export MIDI", systemImage: "square.and.arrow.up")
            }
            #endif
        } else if let e = fileError {
            MakingErrorLine(text: e)
            Button("Try again") { fileTry += 1 }
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Making the MIDI file").foregroundStyle(.secondary)
            }
        }
    }

    private func loadFile() async {
        // New notes or another timing swap the file at once, so the old one is never dragged by mistake. A title
        // or tempo edit keeps the file it has and waits a moment, so the edit reaches the hub first.
        // A list row that scrolls back into view starts this again; the file it has is still right.
        if fileKeyDone == fileKey, file != nil { return }
        let key = fileKey
        let made = "\(idea.id)|\(grid)|\(idea.field_ts["midi"] ?? "")"
        let sameNotes = fileFor == made
        if !sameNotes { file = nil }
        fileError = nil
        if sameNotes, file != nil {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if Task.isCancelled { return }
        }
        guard let c = engine.client else { fileError = "Connect to the hub to get the MIDI file."; return }
        do {
            let m = try await c.humMIDI(idea.id, grid: grid)
            if Task.isCancelled { return }
            file = try Hum.write(m, ideaId: idea.id, grid: grid)
            fileFor = made
            fileKeyDone = key
        } catch {
            if !Task.isCancelled { fileError = Making.message(error) }
        }
    }

    private func toggleRecording() async {
        if player.playing == .recording { player.stop(); return }
        if recording == nil {
            guard let c = engine.client else { error = "Connect to the hub to play the recording."; return }
            loadingRecording = true
            defer { loadingRecording = false }
            do { recording = try await c.humRecording(idea.id) }
            catch { self.error = Making.message(error); return }
        }
        if let d = recording { player.playRecording(d) }
    }

    private func rehear(mode: HumMidi.Mode?, bpm: Double?) async {
        guard let c = engine.client else { error = "Connect to the hub to hear it again."; return }
        busy = true
        defer { busy = false }
        error = nil
        player.stop()
        do {
            let e = try await c.rehearHum(idea.id, mode: mode, bpm: bpm)
            await engine.absorb(e)
            tempo = ""
        } catch {
            self.error = Making.message(error)
        }
    }

    #if os(macOS)
    private func save(_ url: URL) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = url.lastPathComponent
        panel.allowedContentTypes = [.midi]
        panel.canCreateDirectories = true
        panel.begin { response in
            guard response == .OK, let dest = panel.url else { return }
            // Written in place: a sandboxed app may write only the file that was picked, not a temporary file beside it.
            do { try Data(contentsOf: url).write(to: dest) }
            catch { Task { @MainActor in fileError = "Could not save the MIDI file: \(error.localizedDescription)" } }
        }
    }
    #endif
}

#if os(macOS)
/// The .mid as a chip to drag straight onto a DAW track.
struct HumDragChip: View {
    var url: URL
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "pianokeys")
            Text(url.lastPathComponent).lineLimit(1).truncationMode(.middle)
        }
        .font(.callout)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
        .onDrag { Hum.dragProvider(url) }
        .help("Drag onto a MIDI track in your DAW")
        .accessibilityLabel("MIDI file \(url.lastPathComponent), drag onto a track")
    }
}
#endif
