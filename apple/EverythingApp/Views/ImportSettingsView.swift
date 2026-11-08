import SwiftUI
import UniformTypeIdentifiers
import EACore

/// Settings, Bring your data in: upload what other apps hold (a ChatGPT export, a Google Takeout, a zipped notes
/// folder or Obsidian vault, Evernote notebooks, .txt, .ics, .vcf) or paste text, once. The hub files it into notes,
/// people and tasks and, when asked, learns facts about the owner from their own words.
struct ImportSettingsView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var jobs: [ImportJob] = []
    @State private var learn = true
    @State private var picking = false
    @State private var title = ""
    @State private var text = ""
    @State private var busy: String?
    @State private var message: (ok: Bool, text: String)?

    var body: some View {
        Form {
            SwiftUI.Section {
                Toggle("Learn about me from it", isOn: $learn)
                Button(busy ?? "Choose files to bring in") { picking = true }.disabled(busy != nil || engine.client == nil)
                if let m = message { Text(m.text).font(.footnote).foregroundStyle(m.ok ? Color.secondary : Color.red) }
            } header: {
                Text("Bring your data in")
            } footer: {
                Text("ChatGPT: Settings, Data controls, Export data, then the .zip from the email. Google: takeout.google.com with Keep, Calendar, Contacts and Tasks. Notes: an Obsidian vault or any folder of notes, zipped, or Evernote .enex. Nothing already here is overwritten or doubled. Learning reads your own words with the model and keeps new facts in Memory; it can take a while, pauses for chats and while a game uses the graphics card.")
            }
            .themedRow()
            SwiftUI.Section("Paste text") {
                TextField("Title (optional)", text: $title)
                TextEditor(text: $text).frame(minHeight: 120)
                Button("Save and sort") {
                    let t = title, x = text, l = learn
                    run("Sending") { try await $0.importText(title: t, text: x, learn: l); text = ""; title = ""; return "Saved. The hub is sorting it." }
                }
                .disabled(busy != nil || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .themedRow()
            if !jobs.isEmpty {
                SwiftUI.Section("Imports") {
                    ForEach(jobs) { j in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(j.name).font(.callout.weight(.semibold)).lineLimit(1)
                                Spacer()
                                if j.active { Button("Stop") { let id = j.id; run(nil) { try await $0.stopImport(id: id); return "" } }.buttonStyle(.borderless).font(.footnote) }
                            }
                            Text(summary(j)).font(.footnote)
                            Text(j.state == "failed" ? (j.error ?? "Failed") : j.active || j.state == "stopped" ? j.detail : "Done")
                                .font(.caption).foregroundStyle(j.state == "failed" ? Color.red : Color.secondary)
                            if j.state == "learning", j.learned.total > 0 { ProgressView(value: Double(j.learned.done), total: Double(j.learned.total)) }
                        }
                    }
                }
                .themedRow()
            }
        }
        .navigationTitle("Bring your data in")
        .fileImporter(isPresented: $picking, allowedContentTypes: [.zip, .json, .plainText, .text, .data], allowsMultipleSelection: true) { r in
            guard case .success(let urls) = r else { return }
            let l = learn
            run("Uploading") { c in
                for u in urls {
                    // A copy the upload can read for as long as it takes (the picked file's access ends with this scope).
                    let scoped = u.startAccessingSecurityScopedResource()
                    let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
                    try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
                    // Complete unless open: a long upload keeps reading the copy if the phone locks meanwhile.
                    DataProtection.protect(tmp, .completeUnlessOpen)
                    let copy = tmp.appendingPathComponent(u.lastPathComponent)
                    defer { try? FileManager.default.removeItem(at: tmp) }
                    do { try FileManager.default.copyItem(at: u, to: copy) } catch { if scoped { u.stopAccessingSecurityScopedResource() }; throw error }
                    if scoped { u.stopAccessingSecurityScopedResource() }
                    _ = try await c.uploadImport(fileURL: copy, learn: l)
                }
                return "Uploaded. The hub is sorting it; you can leave this page."
            }
        }
        .task {
            // Follow the imports while one runs.
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(jobs.contains(where: \.active) ? 3 : 30))
            }
        }
    }

    private func summary(_ j: ImportJob) -> String {
        let c = j.counts
        var parts: [String] = []
        if c.notes > 0 { parts.append("\(c.notes) note\(c.notes == 1 ? "" : "s")") }
        if c.people > 0 { parts.append("\(c.people) \(c.people == 1 ? "person" : "people")") }
        if c.tasks > 0 { parts.append("\(c.tasks) task\(c.tasks == 1 ? "" : "s")") }
        if c.facts > 0 { parts.append("\(c.facts) fact\(c.facts == 1 ? "" : "s") learned") }
        if c.skipped > 0 { parts.append("\(c.skipped) already here") }
        let what = parts.isEmpty ? "nothing yet" : parts.joined(separator: ", ")
        return j.kinds.isEmpty ? what : "\(j.kinds.joined(separator: ", ")): \(what)"
    }

    private func load() async {
        if let c = engine.client, let j = try? await c.importJobs() { jobs = j }
    }

    private func run(_ label: String?, _ f: @escaping (HubClient) async throws -> String) {
        guard let c = engine.client else { return }
        busy = label.map { "\($0)..." }
        message = nil
        Task {
            do { let t = try await f(c); if !t.isEmpty { message = (true, t) } } catch { message = (false, error.localizedDescription) }
            busy = nil
            await load()
        }
    }
}
