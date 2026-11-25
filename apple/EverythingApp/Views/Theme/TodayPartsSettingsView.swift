import SwiftUI
import EACore

/// Theme, Today: what Today shows and in what order. The line at the top with its switch, then the cards in their
/// order, each with a switch, a handle to drag it by (on the iPhone and iPad the list is always in edit mode, so the
/// handles show; on the Mac a row is dragged as it is) and a line under it saying what it holds; VoiceOver has Move up
/// and Move down on each card. Then Lists in To do, which opens its own page. The same page and words as the web's
/// (EACore `TodayText`). Saved to the feel setting at once, so every device follows.
struct TodayPartsSettingsView: View {
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject private var feel = FeelController.shared
    @State private var asksReset = false
    /// Lists in To do is open. A button, not a link: a link in a list that is always in edit mode does not open.
    @State private var showsLists = false

    private var setting: TodaySetting { feel.settings.shownToday }

    var body: some View {
        ScrollViewReader { reader in
            parts
            #if DEBUG
            // `-EAScrollTo todoLists` (DebugHooks): Lists in To do in view, for screenshots.
            .task {
                guard UserDefaults.standard.string(forKey: "EAScrollTo") == "todoLists" else { return }
                try? await Task.sleep(for: .seconds(1))
                reader.scrollTo("todoLists", anchor: .center)
            }
            #endif
        }
    }

    private var parts: some View {
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
                Button { showsLists = true } label: {
                    HStack {
                        Text(TodayText.todoLists).foregroundStyle(.primary)
                        Spacer()
                        Text(TodayText.todoListsSummary(setting, lists: engine.sources?.lists ?? [])).foregroundStyle(.secondary)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .id("todoLists")
            } footer: {
                Text(TodayText.todoListsNote)
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
        .pageDestination(isPresented: $showsLists) { TodoListsSettingsView() }
        .alert(TodayText.resetAsk, isPresented: $asksReset) {
            // The parts and their order: which lists fill To do is a choice of its own, and stays.
            Button(TodayText.reset) { feel.setToday(TodaySetting.standard.withTodoLists(setting.todoLists)) }
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

/// Lists in To do (gnomecannon/aeneas#28): All lists, or Only these lists with a switch for each list that is on and one
/// for the tasks in no list. Entries for lists not shown here (switched off, or forgotten) stay in the choice. The same
/// page and words as the web's.
struct TodoListsSettingsView: View {
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject private var feel = FeelController.shared

    private var setting: TodaySetting { feel.settings.shownToday }
    private var lists: [SourcesSetting.ReminderList] { TodayText.choosable(engine.sources?.lists ?? []) }

    var body: some View {
        List {
            SwiftUI.Section {
                Text(TodayText.todoListsNote).font(.footnote).foregroundStyle(.secondary)
            }
            .themedRow()
            SwiftUI.Section {
                choice(TodayText.allLists, selected: setting.todoLists == nil) { feel.setToday(setting.withTodoLists(nil)) }
                choice(TodayText.chosenLists, selected: setting.todoLists != nil) { feel.setToday(setting.withTodoLists(setting.todoLists ?? [])) }
            }
            .themedRow()
            if let chosen = setting.todoLists {
                SwiftUI.Section {
                    ForEach(lists) { l in
                        Toggle(isOn: Binding(get: { ListChoices.contains(chosen, l) }, set: { on in change { ListChoices.with($0, l, on) } })) {
                            label(l.title, TodayText.accountName(l.account, kind: l.kind) + (l.space == .work ? ", \(TodayText.work)" : ""))
                        }
                    }
                    Toggle(isOn: Binding(get: { chosen.contains(ListChoices.noList) }, set: { on in change { ListChoices.withNoList($0, on) } })) {
                        label(TodayText.noList, TodayText.noListNote)
                    }
                } footer: {
                    if lists.isEmpty { Text(TodayText.noListsYet) }
                }
                .themedRow()
            }
        }
        #if os(macOS)
        .toggleStyle(.switch)
        #endif
        .themedScreen()
        .navigationTitle(TodayText.todoLists)
        .task { await engine.refreshSources() }
    }

    /// One of All lists and Only these lists, with a check by the one chosen.
    private func choice(_ title: String, selected: Bool, pick: @escaping () -> Void) -> some View {
        Button(action: pick) {
            HStack {
                Text(title).foregroundStyle(.primary)
                Spacer()
                if selected { Image(systemName: "checkmark").foregroundStyle(.tint).fontWeight(.semibold) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func label(_ title: String, _ note: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(StyleGuard.dashes(title))
            Text(note).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The choice as it is now, changed: read when the switch moves, not when the row was drawn.
    private func change(_ edit: ([String]) -> [String]) {
        feel.setToday(setting.withTodoLists(edit(setting.todoLists ?? [])))
    }
}

#if DEBUG
/// `-EATodayOrder <ids, comma separated, or default>` and `-EATodayHidden <ids>` (DebugHooks, DebugHooksMac): Today's
/// order and hidden parts, as Theme, Today sets them, for screenshots. `default` is the default order; with no
/// `-EATodayHidden`, every part shows. `-EATodoLists <keys, comma separated, none for tasks in no list, or all>`: the
/// lists that fill To do, as Lists in To do chooses them.
enum TodayDebug {
    @MainActor static func apply() {
        let d = UserDefaults.standard
        let order = d.string(forKey: "EATodayOrder"), hidden = d.string(forKey: "EATodayHidden"), lists = d.string(forKey: "EATodoLists")
        guard order != nil || hidden != nil || lists != nil else { return }
        func ids(_ s: String?) -> [String] {
            (s ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        let feel = FeelController.shared
        let now = feel.settings.shownToday
        let base = order == "default" ? TodaySetting.standard.order : order.map { ids($0) } ?? now.order
        let chosen = lists.map { $0 == "all" ? nil : ids($0) } ?? now.todoLists
        let next = TodaySetting(order: base, hidden: hidden.map { ids($0) } ?? (order == nil ? now.hidden : []), todoLists: chosen)
        if next != now, next.isValid { feel.setToday(next) }
    }
}
#endif
