import SwiftUI
import EACore

/// App keys (called Keys until 2026-11-24): the hub's own registrations a service needs before anyone can sign in
/// (Google app for the older Google sign-in, while a mailbox still uses it; Atlassian app for Confluence; Steam key),
/// each made once with its guide. Apart from the accounts and services, at the end, since they are made once and then
/// rarely looked at; each shows only while its module is on. Each row says what it is for and whether the hub has it,
/// as a status, and opens its own page (a saved key was drawn as "Set", which read like a button and did nothing when
/// tapped).
struct AppKeysSection: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var store: ConnectionsStore
    let reload: () async -> Void

    private var keys: [AppKey.Shown] { store.c.map { c in AppKey.shown(in: c) { model.isOn($0) } } ?? [] }

    var body: some View {
        if !keys.isEmpty {
            SwiftUI.Section {
                // Why these are asked for, before the rows: optional, and each only for the feature it names.
                Text(AppKey.intro).font(.footnote).foregroundStyle(.secondary)
                ForEach(keys) { k in
                    PageLink { AppKeyView(key: k.key, store: store, reload: reload) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(k.key.name)
                                Spacer()
                                AppKeyStatus(added: k.added).font(.callout)
                            }
                            Text(k.key.purpose).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                Text("App keys")
            }
            .themedRow()
        }
    }
}

/// One app key's own page: whether the hub has it, what it is, why the service asks for it, what in Aeneas uses it and
/// what works without it, and one action that opens the guide: Set it up, or Replace with a new key (the guide's last
/// step saves the new one in place of the old).
struct AppKeyView: View {
    @EnvironmentObject var model: AppModel
    let key: AppKey
    @ObservedObject var store: ConnectionsStore
    let reload: () async -> Void

    /// From the hub's latest answer, so the page says Added as soon as the guide has saved the key.
    private var added: Bool { store.c.flatMap { c in key.added(in: c) { model.isOn($0) } } ?? false }

    var body: some View {
        Form {
            SwiftUI.Section {
                LabeledContent("Status") { AppKeyStatus(added: added) }
            } footer: {
                Text(key.purpose)
            }
            .themedRow()
            explained("What it is", key.what)
            explained("Why \(key.by) asks for it", key.why)
            explained("What uses it", key.uses)
            explained("Without it", key.without)
            SwiftUI.Section {
                PageLink { OwnKeyGuideView(service: key.service) { Task { await reload() } } } label: {
                    Label(added ? "Replace with a new key" : "Set it up", systemImage: added ? "arrow.triangle.2.circlepath" : "key")
                }
            } footer: {
                if added { Text(key.replacing) }
            }
            .themedRow()
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle(key.name)
    }

    private func explained(_ title: String, _ text: String) -> some View {
        SwiftUI.Section { Text(text) } header: { Text(title) }
            .themedRow()
    }
}

/// An app key's state as a status, not a verb: Added, with a checkmark in the theme's ok color, or Not added.
struct AppKeyStatus: View {
    let added: Bool

    var body: some View {
        if added {
            Label("Added", systemImage: "checkmark.circle.fill").foregroundStyle(.okText)
        } else {
            Text("Not added").foregroundStyle(.secondary)
        }
    }
}
