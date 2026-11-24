import SwiftUI
import UniformTypeIdentifiers
import EACore
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// A file held in memory for the save dialog: an attachment the owner asked to download. Saved where the owner picks
/// (Files on the iPhone and iPad, a save panel on the Mac), never opened by the app.
struct MailFileDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

/// An open mail's attachments, as the web's: read from the mailbox by the hub when the mail opens (the list kept with
/// the mail says whether there are any). Pictures show as previews (real pictures only, checked by the hub and here);
/// each file has Download, which saves it where the owner picks (never opened here), after a warning for a kind of
/// file that can run a program or hide one. A long name is shortened by the system with an ellipsis, never cut here.
struct MailAttachmentsView: View {
    @ObservedObject var store: MailStore
    var mail: MailSummary
    @State private var list: [MailAttachment]?
    @State private var error: String?
    @State private var busy: String?
    @State private var risky: MailAttachment?
    @State private var file: MailFileDocument?
    @State private var fileName = ""

    var body: some View {
        Group {
            if let list, !list.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    let pics = list.compactMap { a in Mail.previewData(a.preview).flatMap(Self.image).map { (a, $0) } }
                    if !pics.isEmpty {
                        ScrollView(.horizontal) {
                            HStack(spacing: 8) {
                                ForEach(pics, id: \.0.part) { a, img in
                                    Button { download(a) } label: {
                                        img.resizable().scaledToFill().frame(width: 96, height: 96).clipShape(RoundedRectangle(cornerRadius: 8))
                                    }
                                    .buttonStyle(.plain)
                                    .help("Download \(a.name)")
                                    .accessibilityLabel("Download \(a.name)")
                                }
                            }
                        }
                    }
                    ForEach(list) { a in
                        HStack(spacing: 6) {
                            Image(systemName: "paperclip").foregroundStyle(.secondary).accessibilityHidden(true)
                            Text(verbatim: a.name).lineLimit(1).truncationMode(.middle)
                            Text(verbatim: Mail.fileSize(a.size)).font(.footnote).foregroundStyle(.secondary)
                            if Mail.riskyFile(a.name) { Text("Can run or hide a program").font(.footnote).foregroundStyle(.warnText) }
                            Spacer(minLength: 4)
                            Button(busy == a.part ? "Downloading" : "Download") { download(a) }
                                .buttonStyle(.bordered).controlSize(.small)
                                .disabled(busy != nil)
                        }
                    }
                }
            } else if list == nil, error == nil, mail.asksForAttachments {
                Text(mail.attachments.map { $0 == 1 ? "Loading the attachment" : "Loading \($0) attachments" } ?? "Loading the attachments")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let error { Text(verbatim: error).font(.footnote).foregroundStyle(.dangerText) }
        }
        .task(id: mail.id) {
            guard mail.asksForAttachments else { return }
            do { list = try await store.attachments(mail.id) } catch { self.error = error.localizedDescription }
        }
        .confirmationDialog(risky.map { "\($0.name) is a kind of file that can run a program on your computer, or hide one." } ?? "",
                            isPresented: Binding(get: { risky != nil }, set: { if !$0 { risky = nil } }), titleVisibility: .visible) {
            Button("Download") { if let a = risky { risky = nil; Task { await fetch(a) } } }
        } message: {
            Text(verbatim: "Download it only if you expected it from \(mail.from.address).")
        }
        .fileExporter(isPresented: Binding(get: { file != nil }, set: { if !$0 { file = nil } }), document: file, contentType: .data, defaultFilename: fileName) { _ in file = nil }
    }

    private func download(_ a: MailAttachment) {
        if Mail.riskyFile(a.name) { risky = a } else { Task { await fetch(a) } }
    }

    /// The file's bytes from the hub (read from the mailbox now), then the save dialog. Held in memory only until saved.
    private func fetch(_ a: MailAttachment) async {
        busy = a.part
        error = nil
        defer { busy = nil }
        do {
            let data = try await store.attachment(mail.id, part: a.part)
            fileName = a.name
            file = MailFileDocument(data: data)
        } catch { self.error = error.localizedDescription }
    }

    /// A preview drawn by the system's image decoder from the hub's checked bytes, or nil.
    private static func image(_ data: Data) -> Image? {
        #if os(iOS)
        return UIImage(data: data).map { Image(uiImage: $0) }
        #else
        return NSImage(data: data).map { Image(nsImage: $0) }
        #endif
    }
}
