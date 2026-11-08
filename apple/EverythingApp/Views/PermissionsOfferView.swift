import SwiftUI
import EACore

/// Right after pairing, or when a module is switched on: what the modules that are on need from this device, each in
/// plain words with the modules it is for and what they read. Continue asks for each in turn; Not now asks for
/// nothing (each feature asks again from its own screen when it is used).
struct PermissionsOfferView: View {
    @EnvironmentObject var model: AppModel
    let offer: PermissionOffer
    @State private var asking = false

    var body: some View {
        NavigationStack {
            List {
                SwiftUI.Section {
                    Text("The modules you use need these on this device. You can change each one later in the system's Settings.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                ForEach(offer.needs) { n in
                    SwiftUI.Section {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: n.permission.symbol).font(.title3).foregroundStyle(.tint).frame(width: 28)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(n.permission.title).font(.headline)
                                Text(n.permission.purpose).font(.callout)
                                Text(n.forLine).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                ForEach(n.modules.filter { ($0.reads ?? "").isEmpty == false && firstCard(for: $0) == n.id }) { m in
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text("What \(m.title) reads").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                        Text(m.reads ?? "").font(.caption).foregroundStyle(.secondary)
                                    }
                                    .padding(.top, 2)
                                }
                            }
                        }
                        .padding(.vertical, 4)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            .navigationTitle("What your modules need")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 10) {
                    BigButton(title: asking ? "Asking" : "Continue", symbol: "checkmark", prominent: true) {
                        asking = true
                        Task { await model.grantOffered(offer) }
                    }
                    .disabled(asking)
                    .accessibilityIdentifier("permissions.continue")
                    Button("Not now") { model.permissionOffer = nil }
                        .disabled(asking)
                        .accessibilityIdentifier("permissions.notNow")
                }
                .padding()
                .background(.bar)
            }
        }
        .interactiveDismissDisabled(asking)
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 520)
        #endif
    }

    /// A module's "what it reads" is said once, on the first permission it needs.
    private func firstCard(for m: ModuleInfo) -> String? {
        offer.needs.first { $0.modules.contains { $0.id == m.id } }?.id
    }
}
