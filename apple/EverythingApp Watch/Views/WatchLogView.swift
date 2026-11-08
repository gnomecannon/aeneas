import SwiftUI
import WatchKit
import EACore

/// Quick logs from the wrist: mood, a cup of caffeine, meds taken lately, and the pet (fed, walked, meds; its name from the hub's profile). Each tap is one log, sent through the
/// iPhone (and on to Apple Health from there).
struct WatchLogView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @State private var flash: String?

    private static let moods: [(Int, String, String)] = [(-2, "Very low", "cloud.rain"), (-1, "Low", "cloud"), (0, "Okay", "minus.circle"), (1, "Good", "sun.min"), (2, "Very good", "sun.max")]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("Mood").font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 4) {
                    ForEach(Self.moods, id: \.0) { m in
                        Button { log(.mood, .number(Double(m.0)), "Mood \(m.1.lowercased())") } label: {
                            Image(systemName: m.2).frame(maxWidth: .infinity, minHeight: 32)
                        }
                        .buttonStyle(.bordered)
                        .accessibilityLabel("Mood \(m.1)")
                    }
                }
                Button { log(.caffeine, .number(1), "Caffeine +1") } label: {
                    Label("Caffeine +1", systemImage: "cup.and.saucer").frame(maxWidth: .infinity)
                }
                .tint(.brown)
                let meds = engine.recentValues(type: .med, limit: 6)
                if !meds.isEmpty {
                    Text("Took").font(.caption).foregroundStyle(.secondary)
                    ForEach(meds, id: \.self) { m in
                        Button { log(.med, .string(m), "Took \(m)") } label: {
                            Label(m, systemImage: "pills").frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                if model.isOn(.pet) {
                    Text(pet).font(.caption).foregroundStyle(.secondary)
                    HStack(spacing: 4) {
                        ForEach(Self.pet, id: \.0) { p in
                            Button { logPet(p.1, note: p.2, said: p.0) } label: {
                                VStack(spacing: 2) { Image(systemName: p.3); Text(p.0).font(.caption2) }.frame(maxWidth: .infinity, minHeight: 40)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
                if let f = flash { Text(f).font(.caption2).foregroundStyle(.green) }
                OfflineDot()
            }
        }
        .navigationTitle("Log")
    }

    /// The pet's name, or "Pet" until the profile names one (the iPhone and web Pet pages do the same).
    private var pet: String { model.petName.isEmpty ? "Pet" : model.petName }

    /// Label, pet_event type, note, symbol.
    private static let pet: [(String, String, String?, String)] = [("Fed", "food", nil, "fork.knife"), ("Walk", "note", "walk", "figure.walk"), ("Meds", "med", nil, "pills")]

    private func logPet(_ type: String, note: String?, said: String) {
        Task {
            var f: [String: JSONValue] = ["pet": .string(pet), "type": .string(type), "at": .string(ISO.now())]
            if let n = note { f["note"] = .string(n) }
            _ = await engine.create(kind: .pet_event, fields: f)
            flash = "\(pet): \(said.lowercased())"
            WKHaptic.success()
        }
    }

    private func log(_ type: LogType, _ value: JSONValue, _ said: String) {
        Task {
            _ = await engine.log(type: type, value: value, source: .watch)
            flash = said
            WKHaptic.success()
        }
    }
}

/// A light tap on the wrist when something was logged.
enum WKHaptic {
    static func success() {
        #if os(watchOS)
        WKInterfaceDevice.current().play(.success)
        #endif
    }
    static func click() {
        #if os(watchOS)
        WKInterfaceDevice.current().play(.click)
        #endif
    }
    static func failure() {
        #if os(watchOS)
        WKInterfaceDevice.current().play(.failure)
        #endif
    }
}
