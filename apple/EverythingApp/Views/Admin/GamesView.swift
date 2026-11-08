import SwiftUI
import EACore

/// One pick at a time for the group: choose who is playing, tap Pick. The game list underneath is for upkeep.
struct GamesView: View {
    @EnvironmentObject var engine: SyncEngine
    @AppStorage(AdminGames.ownerKey) private var ownerName = ""
    /// Who plays: the owner until names are tapped.
    @State private var chosenPlayers: Set<String>?
    private var players: Set<String> { chosenPlayers ?? [AdminGames.me(ownerName)] }
    @State private var hours: Double?
    @State private var coop = false
    @State private var pick: GamePick?
    @State private var excluded: [String] = []
    @State private var played: String?
    @State private var busy = false
    @State private var error: String?
    @State private var editing: Entity?
    @State private var creating = false
    @State private var deleting: Entity?
    @State private var sort: GameSort?
    @State private var query = ""
    @State private var showPicker = false

    enum GameSort: String, CaseIterable, Identifiable {
        case playtime = "Most played", twoWeeks = "Last 2 weeks", recent = "Recent", name = "A to Z"
        var id: String { rawValue }
    }

    private var games: [Entity] { engine.list(.game) }

    /// The library in the chosen order: most played once Steam is linked, by name before.
    private func sorted(_ all: [Entity], _ s: GameSort) -> [Entity] {
        let q = query.trimmingCharacters(in: .whitespaces)
        let shown = q.isEmpty ? all : all.filter { $0.str("name").localizedCaseInsensitiveContains(q) }
        let byName: (Entity, Entity) -> Bool = { $0.str("name").localizedCaseInsensitiveCompare($1.str("name")) == .orderedAscending }
        let mins = { (e: Entity, k: String) in e.number(k) ?? 0 }
        switch s {
        case .playtime: return shown.sorted { mins($0, "playtime_min") != mins($1, "playtime_min") ? mins($0, "playtime_min") > mins($1, "playtime_min") : byName($0, $1) }
        case .twoWeeks: return shown.sorted { mins($0, "playtime_2w_min") != mins($1, "playtime_2w_min") ? mins($0, "playtime_2w_min") > mins($1, "playtime_2w_min") : mins($0, "playtime_min") > mins($1, "playtime_min") }
        case .recent: return shown.sorted { $0.str("last_played") > $1.str("last_played") }
        case .name: return shown.sorted(by: byName)
        }
    }

    var body: some View {
        let all = self.games
        let friends = AdminGames.friends(all, me: AdminGames.me(ownerName))
        let fromSteam = all.filter { $0.number("steam_appid") != nil }
        let order = sort ?? (fromSteam.isEmpty ? .name : .playtime)
        let library = sorted(all, order)
        let games = all
        List {
            SwiftUI.Section {
                Picker("Order", selection: Binding(get: { order }, set: { sort = $0 })) {
                    ForEach(GameSort.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                ForEach(library) { g in
                    AdminGameRow(game: g)
                        .contentShape(Rectangle())
                        .onTapGesture { editing = g }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { deleting = g } label: { Label("Delete", systemImage: "trash") }
                            Button { editing = g } label: { Label("Edit", systemImage: "pencil") }
                        }
                        .contextMenu {
                            Button { editing = g } label: { Label("Edit", systemImage: "pencil") }
                            Button(role: .destructive) { deleting = g } label: { Label("Delete", systemImage: "trash") }
                        }
                }
                if all.isEmpty { Text("No games yet. Link Steam in Settings, Connections, or tap + to add one.").foregroundStyle(.secondary) }
            } header: {
                Text("Library, \(all.count)")
            } footer: {
                if !fromSteam.isEmpty {
                    Text("\(fromSteam.count) from Steam, \(Int((fromSteam.reduce(0) { $0 + ($1.number("playtime_min") ?? 0) } / 60).rounded())) hours played. Steam is read every 6 hours.")
                }
            }

            SwiftUI.Section {
                DisclosureGroup("Pick a game for a group", isExpanded: $showPicker) {
                    FlowLayout(spacing: 8) {
                        // A selected player who no longer owns any game had no chip, so they stayed in every pick
                        // and could not be cleared. Their chip stays until they are tapped off.
                        ForEach(friends + players.filter { !friends.contains($0) }.sorted(), id: \.self) { f in
                            AdminToggleChip(text: f, on: players.contains(f)) {
                                var now = players
                                if now.contains(f) { now.remove(f) } else { now.insert(f) }
                                chosenPlayers = now
                            }
                        }
                    }
                    .padding(.vertical, 4)
                    Picker("Time", selection: $hours) {
                        Text("Any").tag(Double?.none)
                        ForEach([2.0, 4.0, 6.0], id: \.self) { h in Text("\(Int(h)) h").tag(Double?.some(h)) }
                    }
                    .pickerStyle(.segmented)
                    Toggle("Co-op only", isOn: $coop)
                    Button {
                        ask(exclude: [])
                    } label: {
                        HStack {
                            if busy && pick == nil { ProgressView().controlSize(.small) }
                            Label("Pick a game", systemImage: "dice")
                        }
                        .font(.title3.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || players.isEmpty || games.isEmpty)
                    if let err = error { AdminMessage(tone: .error, text: err) }
                    else if games.isEmpty { Text("Add a game below first, with who owns it.").foregroundStyle(.secondary) }
                    else if players.isEmpty { Text("Tap at least one name.").foregroundStyle(.secondary) }
                    Text("Picks a game every player owns that fits the group, least recently played first.").font(.caption).foregroundStyle(.secondary)
                }
            }

            if let p = pick { result(p) }
        }
        .searchable(text: $query, prompt: "Filter games")
        .navigationTitle("Games")
        .toolbar { ToolbarItem(placement: .automatic) { CSVExportButton(kind: .game) } }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: { Label("Add game", systemImage: "plus") }
            }
        }
        .sheet(item: $editing) { g in AdminGameEditor(game: g, friends: friends) }
        .sheet(isPresented: $creating) { AdminGameEditor(game: nil, friends: friends) }
        .confirmationDialog("Delete \(deleting?.str("name") ?? "game")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let d = deleting { Task { await engine.softDelete(d.id) } }
                deleting = nil
            }
        }
        .refreshable { await engine.sync() }
    }

    @ViewBuilder
    private func result(_ p: GamePick) -> some View {
        SwiftUI.Section("The pick") {
            if let name = played {
                Label("\(name) marked played.", systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.title3)
            } else if let g = p.pick {
                VStack(alignment: .leading, spacing: 6) {
                    Text(StyleGuard.dashes(g.str("name"))).font(.largeTitle.weight(.bold))
                    if !p.why.isEmpty { Text(StyleGuard.dashes(p.why)).foregroundStyle(.secondary) }
                    Text(AdminGames.players(g) + (g.number("session_hours").map { ", about \(JSONValue.number($0).displayString) h" } ?? ""))
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
                HStack(spacing: 12) {
                    Button { markPlayed(g) } label: { Label("Played", systemImage: "checkmark").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent)
                    Button { ask(exclude: excluded + [g.id]) } label: { Label("Another", systemImage: "arrow.triangle.2.circlepath").frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered)
                }
                .controlSize(.large)
                .disabled(busy)
                if let ru = p.runner_up { Text("Runner-up: \(StyleGuard.dashes(ru.str("name")))").font(.caption).foregroundStyle(.secondary) }
            } else {
                Text(p.why.isEmpty ? "Nothing fits. Change the players or add a game below." : StyleGuard.dashes(p.why)).foregroundStyle(.secondary)
                if !excluded.isEmpty {
                    Button("Start over") { ask(exclude: []) }.disabled(busy)
                }
            }
        }
    }

    private func ask(exclude: [String]) {
        guard let c = engine.client else {
            error = "Picking needs the hub. Set it up in Settings."
            return
        }
        busy = true
        error = nil
        played = nil
        let friends = AdminGames.friends(games, me: AdminGames.me(ownerName))
        let who = friends.filter { players.contains($0) } + players.filter { !friends.contains($0) }.sorted()
        Task {
            do {
                pick = try await c.gamePick(players: who, hours: hours, coop: coop, exclude: exclude)
                excluded = exclude
            } catch let h as HubError {
                if case .transport = h { error = "Hub unreachable. Picking needs the hub." } else { error = h.errorDescription }
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    private func markPlayed(_ g: Entity) {
        busy = true
        Task {
            if let c = engine.client, engine.status == .online, let e = try? await c.gamePlayed(g.id) {
                await engine.absorb(e)
            } else {
                // POST /games/:id/played only sets last_played, so the same write can go through the outbox.
                _ = await engine.update(g.id, fields: ["last_played": .string(ISO.now())])
            }
            played = g.str("name")
            busy = false
        }
    }
}

/// A selectable name chip that shows a checkmark when on, so selection is not color alone.
struct AdminToggleChip: View {
    var text: String
    var on: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                Text(text)
            }
            .font(.body.weight(.medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(on ? Color.accentColor.opacity(0.22) : Color.secondary.opacity(0.12), in: Capsule())
            .foregroundStyle(on ? Color.accentColor : Color.primary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(text)
        .accessibilityValue(on ? "selected" : "not selected")
    }
}

struct AdminGameRow: View {
    var game: Entity

    static func hours(_ minutes: Double) -> String {
        minutes < 60 ? "\(Int(minutes)) min" : "\(JSONValue.number((minutes / 6).rounded() / 10).displayString) h"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                // The picture comes through the hub, never straight from Steam.
                if let app = game.number("steam_appid") {
                    SteamArtThumb(appid: Int(app), size: CGSize(width: 74, height: 35)).accessibilityHidden(true)
                }
                Text(StyleGuard.dashes(game.str("name"))).font(.body)
                Spacer()
                if let m = game.number("playtime_min") { Text(Self.hours(m)).font(.callout.monospacedDigit()) }
                if let r = game.number("rating") { Text("\(Int(r)) of 5").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
            }
            if game.str("source") != "steam" { Text(AdminGames.players(game)).font(.caption).foregroundStyle(.secondary) }
            HStack(spacing: 8) {
                if let w = game.number("playtime_2w_min"), w > 0 { Text("\(Self.hours(w)) in 2 weeks") }
                let owners = game.stringArray("owned_by")
                if !owners.isEmpty { Label(owners.joined(separator: ", "), systemImage: "person.2").lineLimit(1) }
                if let d = game.date("last_played") { Text("Played \(adminDaysLabel(d))") } else { Text("Never played") }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

struct AdminGameEditor: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var game: Entity?
    var friends: [String]

    @State private var name = ""
    @State private var minPlayers = 1
    @State private var maxPlayers = 4
    @State private var coop = true
    @State private var genres = ""
    /// A new game starts owned by the owner (set in load).
    @State private var owned: [String] = []
    @State private var hours = ""
    @State private var rating = 0
    @State private var notes = ""
    @State private var other = ""
    @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name).font(.title3)
                SwiftUI.Section("Players") {
                    Stepper("At least \(minPlayers)", value: $minPlayers, in: 1...20)
                        .onChange(of: minPlayers) { _, v in if maxPlayers < v { maxPlayers = v } }
                    Stepper("At most \(maxPlayers)", value: $maxPlayers, in: 1...40)
                        .onChange(of: maxPlayers) { _, v in if minPlayers > v { minPlayers = v } }
                    Toggle("Co-op", isOn: $coop)
                }
                SwiftUI.Section {
                    FlowLayout(spacing: 8) {
                        let me = AdminGames.me()
                        ForEach(Array(Set(friends + owned)).sorted { a, b in a == me || (b != me && a.localizedCaseInsensitiveCompare(b) == .orderedAscending) }, id: \.self) { p in
                            AdminToggleChip(text: p, on: owned.contains(p)) {
                                if let i = owned.firstIndex(of: p) { owned.remove(at: i) } else { owned.append(p) }
                            }
                        }
                    }
                    .padding(.vertical, 4)
                    HStack {
                        TextField("Add a name", text: $other).onSubmit(addOwner)
                        Button("Add", action: addOwner).disabled(other.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                } header: {
                    Text("Owned by")
                } footer: {
                    Text("The picker only offers games every player owns.")
                }
                SwiftUI.Section("Details") {
                    HStack {
                        Text("Session hours")
                        Spacer()
                        TextField("Optional", text: $hours).numericKeyboard().multilineTextAlignment(.trailing).frame(maxWidth: 120)
                    }
                    Picker("Rating", selection: $rating) {
                        Text("None").tag(0)
                        ForEach(1...5, id: \.self) { r in Text("\(r) of 5").tag(r) }
                    }
                    TextField("Genres, comma separated", text: $genres)
                    TextField("Notes", text: $notes, axis: .vertical).lineLimit(2...6)
                }
                if game != nil {
                    SwiftUI.Section {
                        Button("Delete game", role: .destructive) { confirmDelete = true }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(game == nil ? "New game" : "Edit game")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(game == nil ? "Add" : "Save") { save() }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty) }
            }
            .confirmationDialog("Delete \(name)?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    if let g = game { Task { await engine.softDelete(g.id) } }
                    dismiss()
                }
            }
            .onAppear(perform: load)
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 560)
        #endif
    }

    private func addOwner() {
        let t = other.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        if !owned.contains(t) { owned.append(t) }
        other = ""
    }

    private func load() {
        guard let g = game else { owned = [AdminGames.me()]; return }
        name = g.str("name")
        minPlayers = max(1, Int(g.number("min_players") ?? 1))
        maxPlayers = max(minPlayers, Int(g.number("max_players") ?? 4))
        coop = g.bool("coop") ?? true
        genres = g.stringArray("genres").joined(separator: ", ")
        owned = g.stringArray("owned_by")
        hours = g.number("session_hours").map { JSONValue.number($0).displayString } ?? ""
        rating = Int(g.number("rating") ?? 0)
        notes = g.str("notes")
    }

    private func save() {
        let h = Calc.parse(hours)
        let n = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        var f: [String: JSONValue] = [
            "name": .string(name.trimmingCharacters(in: .whitespaces)),
            "min_players": .number(Double(minPlayers)),
            "max_players": .number(Double(maxPlayers)),
            "coop": .bool(coop),
            "genres": .array(genres.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.map { .string($0) }),
            "owned_by": .array(owned.map { .string($0) }),
            "session_hours": h.map { .number($0) } ?? .null,
            "rating": rating > 0 ? .number(Double(rating)) : .null,
            "notes": n.isEmpty ? .null : .string(n),
        ]
        Task {
            if let g = game {
                _ = await engine.update(g.id, fields: f)
            } else {
                f = f.filter { !$0.value.isNull }
                _ = await engine.create(kind: .game, fields: f)
            }
        }
        dismiss()
    }
}
