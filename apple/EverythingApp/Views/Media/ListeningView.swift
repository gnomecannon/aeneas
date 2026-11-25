import SwiftUI
import EACore

/// Music (Library, Media; module `apple_music`): the owner's Apple Music taste, as the last iPhone, iPad or Mac read it
/// (one synced item, `MusicTaste.profileId`). This device reads its own library with Read Apple Music now, or by itself
/// at launch and on return to the app when the profile is more than 12 hours old (`MusicTasteReader`).
struct ListeningView: View {
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject private var reader = MusicTasteReader.shared
    @State private var expanded: Set<String> = []

    /// How many lines a list shows before Show all.
    private static let shortList = 10

    private var profile: MusicTaste.Profile? { MusicTaste.Profile(entity: engine.get(MusicTaste.profileId)) }

    var body: some View {
        let p = profile
        WideReader { wide in
            if wide { cards(p) } else { list(p) }
        }
        .navigationTitle("Music")
        .onAppear { reader.refreshAccess() }
    }

    // MARK: layouts

    private func list(_ p: MusicTaste.Profile?) -> some View {
        List {
            SwiftUI.Section { status(p) }
            if let p {
                ForEach(sections(p), id: \.title) { s in
                    SwiftUI.Section(s.title) { lines(s) }
                }
            }
        }
    }

    /// A wide window: where it stands across the top, then each list as a card, side by side as they fit.
    private func cards(_ p: MusicTaste.Profile?) -> some View {
        WidePage {
            status(p).frame(maxWidth: 640, alignment: .leading)
            if let p {
                AdaptiveColumns(minWidth: 300, maxColumns: 3, spacing: WideLayout.gap) {
                    ForEach(sections(p), id: \.title) { s in
                        WideSection(s.title) { lines(s) }.gridCard()
                    }
                }
            }
        }
    }

    // MARK: where it stands

    /// Where the profile came from and when, and what this device can do: read now, allow Apple Music, or why not.
    @ViewBuilder private func status(_ p: MusicTaste.Profile?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let p {
                Text(MusicTaste.readLine(p))
                Text(MusicTaste.countsLine(p)).font(.footnote).foregroundStyle(.secondary)
                if p.subscription == false { Text(MusicTaste.noSubscription).font(.footnote).foregroundStyle(.secondary) }
                if p.topArtists.isEmpty && p.playlists.isEmpty { Text("Nothing was in Apple Music on \(p.device.isEmpty ? "that device" : p.device).").font(.footnote).foregroundStyle(.secondary) }
            } else {
                Text("Not read yet. Read Apple Music to bring your most played artists and songs, your playlists and your genres here, for you and the assistant.")
            }
            here
            if let problem = reader.problem { Text(problem).font(.footnote).foregroundStyle(.dangerText) }
            if let note = reader.note { Text(note).font(.footnote).foregroundStyle(.secondary) }
        }
        .padding(.vertical, 2)
    }

    /// What this device can do now.
    @ViewBuilder private var here: some View {
        let word = MusicTasteReader.deviceWord
        if engine.config.sampleMode {
            Text("This is sample data. Reading Apple Music works once your own hub is set up.").font(.footnote).foregroundStyle(.secondary)
        } else if !engine.hasHubCopy {
            Text("Apple Music is read once this \(word) has your hub's items.").font(.footnote).foregroundStyle(.secondary)
        } else {
            switch reader.access {
            case .allowed:
                HStack(spacing: 10) {
                    Button(reader.reading ? "Reading Apple Music" : "Read Apple Music now") { Task { await reader.readNow(engine: engine) } }
                        .buttonStyle(.themedProminent)
                        .disabled(reader.reading)
                    if reader.reading { ProgressView().controlSize(.small) }
                }
            case .notAsked:
                Text("Aeneas has not asked for Apple Music on this \(word) yet. It reads your library, playlists and play counts, and changes nothing in Apple Music.").font(.footnote).foregroundStyle(.secondary)
                Button("Allow Apple Music") { Task { await reader.requestAccess(engine: engine) } }
                    .buttonStyle(.themedProminent)
            case .denied:
                Text("Apple Music is not allowed for Aeneas on this \(word). Allow it in \(MusicTasteReader.settingsPlace).").font(.footnote).foregroundStyle(.secondary)
                Button(systemSettingsName) { openPrivacySettings("Privacy_Media") }.buttonStyle(.borderless)
            case .restricted:
                Text("Apple Music is restricted on this \(word), by Screen Time or a profile, so Aeneas cannot read it here.").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    // MARK: the lists

    private struct Part {
        var title: String
        var rows: [(String, String?)]
    }

    private func sections(_ p: MusicTaste.Profile) -> [Part] {
        func plays(_ n: Int) -> String { n == 1 ? "1 play" : "\(n) plays" }
        func songs(_ n: Int) -> String { n == 1 ? "1 song" : "\(n) songs" }
        var out: [Part] = []
        if !p.topArtists.isEmpty { out.append(Part(title: "Top artists", rows: p.topArtists.map { ($0.name, plays($0.count)) })) }
        if !p.topSongs.isEmpty { out.append(Part(title: "Top songs", rows: p.topSongs.map { ("\($0.title), \($0.artist)", plays($0.plays)) })) }
        if !p.playlists.isEmpty { out.append(Part(title: "Playlists", rows: p.playlists.map { ($0.name, $0.own ? songs($0.songs) : "\(songs($0.songs)), from Apple Music") })) }
        if !p.recent.isEmpty { out.append(Part(title: "Recently played", rows: p.recent.map { ("\($0.title), \($0.artist)", nil) })) }
        if !p.genres.isEmpty { out.append(Part(title: "Genres", rows: p.genres.map { ($0.name, songs($0.count)) })) }
        return out
    }

    @ViewBuilder private func lines(_ s: Part) -> some View {
        let open = expanded.contains(s.title)
        let shown = open ? s.rows : Array(s.rows.prefix(Self.shortList))
        ForEach(Array(shown.enumerated()), id: \.offset) { _, row in
            HStack(alignment: .firstTextBaseline) {
                Text(row.0)
                Spacer(minLength: 8)
                if let detail = row.1 { Text(detail).font(.footnote).foregroundStyle(.secondary).monospacedDigit() }
            }
            .accessibilityElement(children: .combine)
        }
        if s.rows.count > Self.shortList {
            Button(open ? "Show fewer" : "Show all \(s.rows.count)") {
                withAnimation { if open { expanded.remove(s.title) } else { expanded.insert(s.title) } }
            }
            .buttonStyle(.borderless)
        }
    }
}
