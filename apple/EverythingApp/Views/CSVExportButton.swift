import SwiftUI
import UniformTypeIdentifiers
import EACore

/// A CSV file held in memory for the save dialog.
struct CSVFile: FileDocument {
    static var readableContentTypes: [UTType] { [.commaSeparatedText] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

/// Toolbar button: downloads every item of one kind from the hub as a CSV file and offers to save it
/// (Files on the iPhone, a save panel on the Mac).
struct CSVExportButton: View {
    @EnvironmentObject var engine: SyncEngine
    var kind: Kind
    var filter: [String: String] = [:]
    @State private var file: CSVFile?
    @State private var showing = false
    @State private var busy = false
    @State private var error: String?

    private var filename: String {
        // The local day: the UTC day named an evening export after tomorrow.
        let day = ISO.localDay()
        return "\(filter.values.first ?? kind.rawValue)-\(day).csv"
    }

    var body: some View {
        Button {
            Task { await fetch() }
        } label: {
            if busy { ProgressView() } else { Label("Export CSV", systemImage: "tablecells") }
        }
        .disabled(busy || engine.client == nil)
        .help("Save all of them as a spreadsheet file (CSV)")
        .fileExporter(isPresented: $showing, document: file, contentType: .commaSeparatedText, defaultFilename: filename) { _ in file = nil }
        .alert("Export failed", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
    }

    private func fetch() async {
        guard let c = engine.client else { return }
        busy = true
        defer { busy = false }
        do {
            file = CSVFile(data: try await c.exportCSV(kind: kind, filter: filter))
            showing = true
        } catch {
            self.error = (error as? HubError)?.errorDescription ?? error.localizedDescription
        }
    }
}
