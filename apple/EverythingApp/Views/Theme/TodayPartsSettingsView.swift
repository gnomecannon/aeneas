import SwiftUI
import EACore

/// Theme, Today: what Today shows and in what order. The line at the top with its switch, then the cards in their
/// order, each with a switch, a handle to drag it by (on the iPhone and iPad the list is always in edit mode, so the
/// handles show; on the Mac a row is dragged as it is) and a line under it saying what it holds; VoiceOver has Move up
/// and Move down on each card. The same page and words as the web's (EACore `TodayText`). Saved to the feel setting at
/// once, so every device follows.
struct TodayPartsSettingsView: View {
    @ObservedObject private var feel = FeelController.shared
    @State private var asksReset = false

    private var setting: TodaySetting { feel.settings.shownToday }

    var body: some View {
        List {
            SwiftUI.Section {
                Text(TodayText.intro).font(.footnote).foregroundStyle(.secondary)
            }
            .themedRow()
            SwiftUI.Section {
                row(.now)
            } header: {
                Text(TodayText.top)
            } footer: {
                Text(TodayText.topNote)
            }
            .themedRow()
            SwiftUI.Section {
                ForEach(Array(setting.cardOrder.enumerated()), id: \.element) { i, p in
                    row(p)
                        .accessibilityAction(named: TodayText.moveUp) { if i > 0 { feel.setToday(setting.moving(p, to: i - 1)) } }
                        .accessibilityAction(named: TodayText.moveDown) { feel.setToday(setting.moving(p, to: i + 1)) }
                }
                .onMove { from, to in feel.setToday(setting.moving(fromOffsets: from, toOffset: to)) }
            } header: {
                Text(TodayText.cards)
            } footer: {
                Text("\(TodayText.drag) \(TodayText.wide)")
            }
            .themedRow()
            SwiftUI.Section {
                Button(TodayText.reset) { asksReset = true }
                    .disabled(setting.isStandard)
            }
            .themedRow()
        }
        #if os(iOS)
        .environment(\.editMode, .constant(.active))
        #endif
        .themedScreen()
        .navigationTitle("Today")
        .alert(TodayText.resetAsk, isPresented: $asksReset) {
            Button(TodayText.reset) { feel.setToday(.standard) }
            Button("Cancel", role: .cancel) {}
        }
        .task { await feel.refresh() }
    }

    /// A part: its switch, its name and what it holds.
    private func row(_ p: TodayPart) -> some View {
        Toggle(isOn: Binding(get: { !setting.hidden.contains(p.rawValue) }, set: { feel.setToday(setting.showing(p, $0)) })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(TodayText.name(p))
                Text(TodayText.holds(p)).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        #if os(macOS)
        .toggleStyle(.switch)
        #endif
    }
}

#if DEBUG
/// `-EATodayOrder <ids, comma separated, or default>` and `-EATodayHidden <ids>` (DebugHooks, DebugHooksMac): Today's
/// order and hidden parts, as Theme, Today sets them, for screenshots. `default` is the default order; with no
/// `-EATodayHidden`, every part shows.
enum TodayDebug {
    @MainActor static func apply() {
        let d = UserDefaults.standard
        let order = d.string(forKey: "EATodayOrder"), hidden = d.string(forKey: "EATodayHidden")
        guard order != nil || hidden != nil else { return }
        func ids(_ s: String?) -> [String] {
            (s ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        let feel = FeelController.shared
        let base = order == "default" ? TodaySetting.standard.order : order.map { ids($0) } ?? feel.settings.shownToday.order
        let next = TodaySetting(order: base, hidden: ids(hidden))
        if next != feel.settings.shownToday { feel.setToday(next) }
    }
}
#endif
