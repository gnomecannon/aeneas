import SwiftUI
import EACore

extension Entity {
    /// The name an item goes by, whatever its kind.
    var displayTitle: String {
        if kind == .application { return "\(str("company")) \(str("role"))".trimmingCharacters(in: .whitespaces) }
        if kind == .pet_event { return [str("type"), str("note")].filter { !$0.isEmpty }.joined(separator: ", ") }
        for k in ["title", "name", "text", "value"] where !str(k).isEmpty { return str(k) }
        return SearchView.section(for: kind).title
    }
}

/// "Renewals: Domain" as a button that opens the item a reminder (or a task's project) points at.
/// Nothing when the item is gone.
struct LinkedItem: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    var id: String?
    var showsScreen = true

    var body: some View {
        if let id, let e = engine.get(id), !e.isDeleted {
            Button {
                model.open(itemId: e.id)
            } label: {
                Text(showsScreen ? "\(SearchView.section(for: e.kind).title): \(StyleGuard.dashes(e.displayTitle))" : StyleGuard.dashes(e.displayTitle))
                    .lineLimit(1)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.tint)
            .help("Open it")
        }
    }
}
