import SwiftUI
import PhotosUI
import EACore

/// Capture: text, tap-to-talk dictation that waits and never auto-submits, optional photo. With Music on, a hummed
/// melody or tapped rhythm goes straight to Music as MIDI.
struct CaptureView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @StateObject private var dictation = DictationController()
    @StateObject private var hum = HumRecorder()
    @State private var humMode: HumMidi.Mode = .melody
    @State private var humSending = false
    /// Where the last hum went, said under the buttons; tapping it opens the idea.
    @State private var humMessage: String?
    @State private var humIdeaId: String?
    @State private var humError: String?
    /// A take the hub did not get, kept so it can be sent again.
    @State private var humUnsent: HumTake?
    @State private var text = ""
    @State private var photoItem: PhotosPickerItem?
    @State private var attachment: Attachment?
    /// Set when dictation put text in the field, so the capture is tagged as voice.
    @State private var usedVoice = false
    @State private var saving = false
    @State private var message: String?
    /// The capture whose filing the message reports; tapping the message opens it and where it went.
    @State private var lastCaptureId: String?
    @FocusState private var focused: Bool

    private var suggestion: SuggestedKind { Classifier.classify(text).kind }

    var body: some View {
        // The form scrolls and the Save buttons stay pinned below it, so with the keyboard up nothing is pushed
        // off screen and Save sits just above the keyboard.
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                StatusBanner()
                TextField("What is on your mind", text: $text, axis: .vertical)
                    .font(.title2)
                    .lineLimit(4...12)
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .submitLabel(.return)

                HStack {
                    if !text.isEmpty {
                        Text(suggestion == .none ? "Will be sorted later" : "Looks like a \(suggestion.rawValue)")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let a = attachment {
                        Label(a.name, systemImage: "photo").font(.subheadline).lineLimit(1)
                        Button { attachment = nil; photoItem = nil } label: { Image(systemName: "xmark.circle") }.buttonStyle(.borderless)
                    } else {
                        PhotosPicker(selection: $photoItem, matching: .images) { Label("Photo", systemImage: "photo") }
                            .buttonStyle(.bordered)
                    }
                }

                HStack(alignment: .top, spacing: 10) {
                    // Voice off (Settings, Modules): no microphone button for dictation.
                    if model.isOn(.voice) { talk }
                    if model.isOn(.music) { humButton }
                }
                if hum.recording { HumRecordingPanel(recorder: hum, mode: $humMode) }
                humStatus

                if let e = dictation.error { Text(e).font(.footnote).foregroundStyle(.red) }
                if let n = dictation.notice { Text(n).font(.footnote).foregroundStyle(.orange) }
                if let m = message {
                    if let id = lastCaptureId, m.hasPrefix("Filed:") {
                        Button { model.open(itemId: id) } label: {
                            Label(m, systemImage: "arrow.up.forward.square").font(.subheadline).multilineTextAlignment(.leading)
                        }
                        .buttonStyle(.borderless)
                        // The chat that filed it: tell the assistant what it got wrong there.
                        if let thread = engine.get(id)?.string("thread") {
                            Button("Fix the filing", systemImage: "bubble.left.and.text.bubble.right") { model.openChat(thread) }
                                .font(.subheadline).buttonStyle(.borderless)
                        }
                    } else {
                        Text(m).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
            .padding()
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 10) {
                BigButton(title: "Save", symbol: "wand.and.stars", prominent: true) { save() }
            }
            .disabled(saving || text.trimmingCharacters(in: .whitespaces).isEmpty)
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(.bar)
        }
        .navigationTitle("Capture")
        .onAppear { consumePrefill() }
        .onChange(of: model.captureRequested) { _, _ in consumePrefill() }
        .onChange(of: photoItem) { _, item in loadPhoto(item) }
        // Read only: the first tap on the mic asks (release rule 2), never the screen appearing.
        .onAppear { dictation.refreshAuthorization() }
        .onChange(of: hum.finished) { _, take in
            guard let take else { return }
            hum.finished = nil
            Task { await sendHum(take) }
        }
        .onDisappear {
            // Leaving while dictating used to stop without placing the words, and the next start cleared them.
            if dictation.listening { dictation.stop(); placeTranscript() }
            hum.cancel()
        }
    }

    /// Tap to start, tap to stop: no holding and no time limit, so a long thought is not cut off.
    private var talk: some View {
        VStack(spacing: 6) {
            Button {
                if dictation.listening {
                    dictation.stop()
                    placeTranscript()
                } else {
                    focused = false
                    Task { await dictation.startAsking() }
                }
            } label: {
                VStack(spacing: 4) {
                    Image(systemName: dictation.listening ? "stop.circle.fill" : "mic.fill").font(.system(size: 34))
                    Text(dictation.listening ? "Listening. Tap when done." : "Tap to dictate").font(.subheadline)
                }
                .frame(maxWidth: .infinity, minHeight: 84)
                .background(dictation.listening ? Color.accentColor.opacity(0.35) : Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 16))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(hum.recording)
            .accessibilityLabel(dictation.listening ? "Stop dictation" : "Start dictation")
            if dictation.listening, !dictation.transcript.isEmpty {
                Text(dictation.transcript).font(.body).foregroundStyle(.secondary).lineLimit(3)
            }
        }
        .disabled(!dictation.authorized && dictation.error != nil)
    }

    /// Tap to record, tap again (or Stop) to send it to Music. The microphone is shared, so dictation stops first.
    private var humButton: some View {
        Button {
            if hum.recording {
                hum.stop()
            } else {
                if dictation.listening { dictation.stop(); placeTranscript() }
                focused = false
                Task { await hum.start() }
            }
        } label: {
            VStack(spacing: 4) {
                if humSending {
                    ProgressView().frame(height: 40)
                } else {
                    Image(systemName: hum.recording ? "stop.circle.fill" : "music.mic").font(.system(size: 34))
                }
                Text(hum.recording ? "Stop" : "Hum").font(.subheadline)
            }
            .frame(width: 96)
            .frame(minHeight: 84)
            .background(hum.recording ? Color.red.opacity(0.3) : Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 16))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(humSending)
        .accessibilityLabel(hum.recording ? "Stop and send the hum to Music" : "Hum a melody or tap a rhythm for Music")
    }

    @ViewBuilder private var humStatus: some View {
        if let e = hum.error ?? humError {
            Text(e).font(.footnote).foregroundStyle(.red)
        }
        if let take = humUnsent, !hum.recording, !humSending {
            HStack {
                Button("Send the hum again") { Task { await sendHum(take) } }.buttonStyle(.bordered)
                Spacer()
                Button("Discard", role: .destructive) {
                    try? FileManager.default.removeItem(at: take.url)
                    humUnsent = nil
                    humError = nil
                }
                .buttonStyle(.borderless)
            }
            .font(.subheadline)
        }
        if let m = humMessage {
            if let id = humIdeaId {
                Button { model.open(itemId: id) } label: {
                    Label(m, systemImage: "music.note").font(.subheadline).multilineTextAlignment(.leading)
                }
                .buttonStyle(.borderless)
            } else {
                Text(m).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }

    /// Sends the take with `from=capture` (the hub adds a diary line) and says where it went, staying on Capture.
    /// Once the hub has heard it, the line names it the way Music does.
    private func sendHum(_ take: HumTake) async {
        humSending = true
        humError = nil
        humMessage = nil
        humIdeaId = nil
        let mode = humMode
        do {
            let e = try await Hum.send(take, mode: mode, bpm: nil, fromCapture: true, engine: engine)
            humSending = false
            humUnsent = nil
            humIdeaId = e.id
            let first = "\(e.humMidi?.kindName ?? HumMidi(mode: mode, state: .listening).kindName): in Music"
            humMessage = first
            for _ in 0..<60 {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard humIdeaId == e.id, let now = engine.get(e.id), let m = now.humMidi else { return }
                if m.state == .done { humMessage = "\(StyleGuard.dashes(now.str("title"))): in Music"; return }
                if m.state == .failed { humMessage = "\(first). \(Hum.sentence(m.error) ?? "The hub could not hear it.")"; return }
            }
        } catch {
            humSending = false
            humUnsent = take
            humError = "The hum was not sent. \(Making.message(error))"
        }
    }

    private func placeTranscript() {
        // The recognizer may deliver its last partial after release; read it shortly after.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 800_000_000)
            let t = dictation.transcript.trimmingCharacters(in: .whitespaces)
            guard !t.isEmpty else { return }
            text = text.isEmpty ? t : text + (text.hasSuffix(" ") || text.hasSuffix("\n") ? "" : " ") + t
            usedVoice = true
            dictation.transcript = ""
        }
    }

    private func consumePrefill() {
        guard model.captureRequested else { return }
        if !model.capturePrefill.isEmpty { text = model.capturePrefill }
        model.capturePrefill = ""
        model.captureRequested = false
        focused = true
    }

    private func loadPhoto(_ item: PhotosPickerItem?) {
        guard let item = item else { return }
        Task {
            guard let data = try? await item.loadTransferable(type: Data.self) else { return }
            guard let jpeg = ImageShrinker.jpeg(from: data) else { message = "Could not shrink that image under 2 MB"; return }
            attachment = Attachment(name: "photo-\(Int(Date().timeIntervalSince1970)).jpg", mime: "image/jpeg", bytes_b64: jpeg.base64EncodedString())
        }
    }

    /// Every capture is sorted: into the day's diary, then filed by the assistant. Nothing waits to be sorted by hand.
    private func save() {
        if dictation.listening { dictation.stop(); placeTranscript(); return }
        guard !saving else { return }
        let t = text
        let sentAttachment = attachment
        saving = true
        Task {
            let e = await engine.capture(t, attachments: sentAttachment.map { [$0] }, source: usedVoice ? .voice : nil)
            saving = false
            if e != nil {
                // Only what was sent is cleared: words typed or a photo picked while it saved used to be wiped too.
                let (left, sameText) = CaptureDraft.remainder(after: t, now: text)
                text = left
                if sameText { usedVoice = false }
                if attachment == sentAttachment { attachment = nil; photoItem = nil }
                message = engine.status == .online ? "Saved" : "Saved offline; it is sorted when the hub is back"
                // The assistant files what the rules cannot place; say what it did once it is done.
                lastCaptureId = e?.id
                if let id = e?.id, e?.str("filing") == "pending" {
                    message = "Saved to your diary. Filing it now"
                    for _ in 0..<30 {
                        try? await Task.sleep(nanoseconds: 3_000_000_000)
                        if let c = engine.get(id), c.str("filing") != "pending" {
                            message = c.str("filing") == "done" ? "Filed: \(c.str("filed"))" : "Saved to your diary; it will be filed when the assistant is back"
                            break
                        }
                    }
                }
            } else {
                message = "Nothing saved"
            }
        }
    }
}
