import SwiftUI
import EACore

/// The note a tap plays: on or off, how loud, which synth and key, holding and bending, and a pad to try it.
struct NoteSoundsView: View {
    @ObservedObject private var feel = FeelController.shared
    @State private var padActive = false
    @AppStorage(FeelController.macSoundKey) private var soundOnThisMac = false

    private var s: FeelSettings { feel.settings }

    var body: some View {
        Form {
            SwiftUI.Section {
                Toggle("Play a note on every tap", isOn: Binding(get: { s.sound && !FeelSynth.blocked }, set: { on in
                    if on { FeelSynth.unblock() }
                    feel.change(["sound": .bool(on)])
                }))
                #if os(macOS)
                Toggle("Also on this Mac", isOn: $soundOnThisMac).disabled(!s.sound)
                Text("Computers stay quiet until this is on. The switch above is for every device.")
                    .font(.footnote).foregroundStyle(.secondary)
                #endif
                if FeelSynth.blocked {
                    Text("Sound was turned off on this device because the app stopped while starting audio. Switch it on to try again.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                HStack {
                    Image(systemName: "speaker.fill").foregroundStyle(.secondary)
                    Slider(value: Binding(get: { s.volume }, set: { feel.change(["volume": .number(($0 * 100).rounded() / 100)], debounce: true) }),
                           in: 0...1) { editing in if !editing { feel.preview() } }
                    Image(systemName: "speaker.wave.3.fill").foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Volume")
            }
            .themedRow()

            SwiftUI.Section("Sound") {
                Picker("Synth", selection: string(\.synth, "synth", preview: true)) {
                    ForEach(FeelMusic.synths, id: \.self) { Text($0.capitalized).tag($0) }
                }
                Picker("Key", selection: string(\.key, "key", preview: true)) {
                    ForEach(FeelMusic.keys, id: \.self) { Text($0).tag($0) }
                }
                Picker("Scale", selection: string(\.scale, "scale", preview: true)) {
                    ForEach(FeelMusic.scaleOrder, id: \.self) { Text(FeelMusic.scaleName($0)).tag($0) }
                }
                Picker("Octave", selection: Binding(get: { s.octave }, set: { feel.change(["octave": .number(Double($0))]); feel.preview() })) {
                    ForEach(2...6, id: \.self) { Text(String($0)).tag($0) }
                }
                Toggle("Follow my music", isOn: bool(\.follow_music, "follow_music"))
                Text(followCaption).font(.caption).foregroundStyle(.secondary)
            }
            .themedRow()

            SwiftUI.Section("Holding") {
                Toggle("Hold notes", isOn: bool(\.hold, "hold"))
                Text("Keep a finger down to hold the note. A quick tap plays a short note.").font(.caption).foregroundStyle(.secondary)
                Toggle("Bend while dragging", isOn: bool(\.drag_bend, "drag_bend"))
                Text("Drag up or down to move through the scale, left or right to darken or brighten the sound.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .themedRow()

            SwiftUI.Section {
                TryPad(active: $padActive)
                Button { feel.tryIt() } label: { Label("Play the new thing chord", systemImage: "sparkles") }
            } header: {
                Text("Try it")
            } footer: {
                Text("Press, hold and drag in the square. It follows the settings above.")
            }
            .themedRow()
        }
        .formStyle(.grouped)
        .themedScreen()
        .scrollDisabled(padActive)
        .navigationTitle("Note sounds")
    }

    private var followCaption: String {
        let key = s.playKey
        let scale = FeelMusic.scaleName(s.playScale).lowercased()
        guard s.follow_music else { return "Taps play \(key) \(scale). Turn on to use the key of your newest music idea." }
        if let from = s.effective?.from {
            let title = from.title.isEmpty ? "your newest idea" : "\u{201C}\(StyleGuard.dashes(from.title))\u{201D}"
            return "Playing \(key) \(scale) from \(title)"
        }
        return "No music idea has a key yet, so taps play \(key) \(scale)."
    }

    private func bool(_ kp: KeyPath<FeelSettings, Bool>, _ field: String) -> Binding<Bool> {
        Binding(get: { s[keyPath: kp] }, set: { feel.change([field: .bool($0)]) })
    }

    private func string(_ kp: KeyPath<FeelSettings, String>, _ field: String, preview: Bool = false) -> Binding<String> {
        Binding(get: { s[keyPath: kp] }, set: {
            feel.change([field: .string($0)])
            if preview { feel.preview() }
        })
    }
}

/// A square to press, hold and drag in. The sound and shapes come from the app-wide touch tracking, so the pad
/// behaves exactly like any other place in the app; it only keeps the screen from scrolling and shows the note.
struct TryPad: View {
    @Binding var active: Bool
    @State private var finger: CGPoint?
    private var live: FeelLive { FeelController.shared.live }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                RoundedRectangle(cornerRadius: 16).fill(.tint.opacity(0.1))
                RoundedRectangle(cornerRadius: 16).strokeBorder(.tint.opacity(0.4), lineWidth: 1)
                Path { p in
                    p.move(to: CGPoint(x: geo.size.width / 2, y: 12)); p.addLine(to: CGPoint(x: geo.size.width / 2, y: geo.size.height - 12))
                    p.move(to: CGPoint(x: 12, y: geo.size.height / 2)); p.addLine(to: CGPoint(x: geo.size.width - 12, y: geo.size.height / 2))
                }
                .stroke(.secondary.opacity(0.25), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                VStack(spacing: 4) {
                    if let n = live.note, finger != nil {
                        Text(FeelLive.name(n)).font(.system(size: 34, weight: .semibold, design: .rounded)).monospacedDigit()
                        Text(filterLabel).font(.caption).foregroundStyle(.secondary)
                    } else {
                        Image(systemName: "hand.point.up.left").font(.title2).foregroundStyle(.secondary)
                        Text("Press, hold and drag").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .allowsHitTesting(false)
                if let f = finger {
                    Circle().fill(.tint.opacity(0.35)).frame(width: 44, height: 44).position(f).allowsHitTesting(false)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 16))
            .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .local)
                .onChanged { v in
                    if !active { active = true }
                    finger = CGPoint(x: min(max(v.location.x, 0), geo.size.width), y: min(max(v.location.y, 0), geo.size.height))
                }
                .onEnded { _ in
                    active = false
                    finger = nil
                })
        }
        .aspectRatio(1, contentMode: .fit)
        .frame(maxWidth: 360)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .accessibilityElement()
        .accessibilityLabel("Try it pad")
        .accessibilityHint("Press and hold to hear a note")
    }

    private var filterLabel: String {
        guard let c = live.cutoff else { return "Filter open" }
        return c >= 1000 ? String(format: "Filter %.1f kHz", c / 1000) : "Filter \(Int(c)) Hz"
    }
}
