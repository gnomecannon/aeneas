import SwiftUI
import EACore

/// Theme, Bottom bar: how many screens the phone's bar shows across (3, 4 or 5), a picture of both rows, and a place
/// chosen to pick its screen from the screens that are on. The same page and words as the web's (EACore `BarText`).
/// Saved to the feel setting at once, so every device follows; the iPad and Mac edit the phone's bar here too.
struct BottomBarSettingsView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var feel = FeelController.shared
    /// The place whose screen is being chosen.
    @State private var choosing: BarPlace?
    /// The bar before this run of count changes, so going back to more across brings back what fewer cut.
    @State private var before: BarSetting?
    @State private var asksReset = false

    /// The bar as it is drawn: a setting that leaves Library out has it in the last place of the first row.
    private var bar: BarSetting { feel.settings.shownBar.withLibrary }

    private var count: Binding<Int> {
        Binding(get: { bar.count }, set: { n in
            let b = bar, base = before ?? b
            if before == nil { before = b }
            feel.setBar(b.countChange(n, before: base))
        })
    }

    var body: some View {
        Form {
            SwiftUI.Section {
                Text("\(BarText.intro) \(BarText.whereShown)").font(.footnote).foregroundStyle(.secondary)
            }
            .themedRow()
            SwiftUI.Section {
                Picker(BarText.across, selection: count) {
                    ForEach(BarSetting.counts, id: \.self) { Text("\($0)").tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            } header: {
                Text(BarText.across)
            } footer: {
                Text(BarText.acrossNote)
            }
            .themedRow()
            SwiftUI.Section {
                BarPreview(bar: bar, on: model.barScreensOn) { choosing = $0 }
            } header: {
                Text(BarText.preview)
            } footer: {
                Text("\(BarText.tap) \(BarText.secondNote)")
            }
            .themedRow()
            SwiftUI.Section {
                Button(BarText.reset) { asksReset = true }
                    .disabled(feel.settings.shownBar == .standard)
            }
            .themedRow()
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Bottom bar")
        .pageDestination(item: $choosing) { place in
            BarPlaceChooser(place: place) { next in
                edit(next)
                choosing = nil
            }
        }
        .alert(BarText.resetAsk, isPresented: $asksReset) {
            Button(BarText.reset) { edit(.standard) }
            Button(BarText.cancel, role: .cancel) {}
        }
        .task { await feel.refresh() }
    }

    private func edit(_ next: BarSetting) {
        before = nil
        feel.setBar(next)
    }
}

/// Both rows of the bar as the phone draws them, at the size the count gives, the second row above the first. Each
/// place is a button that opens the list of screens for it; a free place shows a plus, and a screen that is off on
/// this device is drawn faint with "(off)".
private struct BarPreview: View {
    var bar: BarSetting
    /// The screens this device can show now.
    var on: Set<String>
    var choose: (BarPlace) -> Void

    var body: some View {
        let size = BarSize.of(count: bar.count)
        VStack(spacing: 4) {
            Capsule().fill(.secondary.opacity(0.5)).frame(width: 36, height: 5).accessibilityHidden(true)
            name(BarText.second)
            row(.second, size: size)
            name(BarText.first)
            row(.first, size: size)
        }
        .padding(.vertical, 6)
    }

    private func name(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).accessibilityHidden(true)
    }

    private func row(_ r: BarRow, size: BarSize) -> some View {
        HStack(alignment: .top, spacing: 2) {
            ForEach(0..<bar.count, id: \.self) { i in place(BarPlace(r, i), size: size) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(BarText.name(r))
    }

    private func place(_ p: BarPlace, size: BarSize) -> some View {
        let id = bar.screen(at: p)
        let section = id.flatMap(Section.init(rawValue:))
        let shows = id.map { $0 == BarScreen.library || on.contains($0) } ?? false
        let name = id == nil ? BarText.free : (section?.title ?? id ?? "")
        let off = id != nil && !shows
        // Several buttons in one row of a form: borderless, so each takes only its own taps.
        return Button { choose(p) } label: {
            BarItemLabel(title: off ? "\(name) (\(BarText.off))" : name, symbol: id == nil ? "plus" : (section?.symbol ?? "square"), size: size)
                .overlay {
                    if id == nil {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                            .foregroundStyle(.secondary)
                    }
                }
                .opacity(off ? 0.5 : 1)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(id == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tint))
        .accessibilityLabel("\(BarText.place(p)): \(name)" + (off ? ", \(BarText.off)" : ""))
    }
}

/// The screens a place can take, by group (the main ones, then the Library's areas, each only while its module is
/// on), each with where it has its place now. One that cannot go there (a screen with no place, for Library's place)
/// is dimmed. A place of the second row can also be emptied.
private struct BarPlaceChooser: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var feel = FeelController.shared
    var place: BarPlace
    var done: (BarSetting) -> Void

    private var bar: BarSetting { feel.settings.shownBar.withLibrary }

    var body: some View {
        let there = bar.screen(at: place)
        List {
            SwiftUI.Section {
                Text(there == BarScreen.library ? BarText.library : BarText.swap).font(.footnote).foregroundStyle(.secondary)
                if bar.canEmpty(place) {
                    Button(BarText.empty) { done(bar.emptying(place.index)) }
                }
            }
            .themedRow()
            ForEach(model.barChoices) { group in
                SwiftUI.Section(group.title) {
                    ForEach(group.sections) { s in choice(s, there: there) }
                }
                .themedRow()
            }
        }
        .navigationTitle(BarText.place(place))
    }

    private func choice(_ s: Section, there: String?) -> some View {
        let id = s.rawValue
        let can = bar.canPick(id, for: place)
        return Button { done(bar.picking(id, for: place)) } label: {
            HStack(spacing: 12) {
                Image(systemName: s.symbol)
                    .font(.body.weight(.medium))
                    .foregroundStyle(.tint)
                    .frame(width: 28)
                // Plain colors: inside a button the hierarchical .primary and .secondary would take the tint.
                Text(s.title).foregroundStyle(Color.primary)
                Spacer(minLength: 8)
                if let now = whereNow(id) {
                    Text(now).font(.caption).foregroundStyle(Color.secondary)
                }
                if id == there {
                    Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityHidden(true)
                }
            }
            .opacity(can ? 1 : 0.4)
            .contentShape(Rectangle())
        }
        .disabled(!can)
        .accessibilityAddTraits(id == there ? .isSelected : [])
    }

    /// Where a screen has its place now: "Here", or the row it is in.
    private func whereNow(_ id: String) -> String? {
        guard let p = bar.position(of: id) else { return nil }
        return p == place ? BarText.here : BarText.name(p.row)
    }
}
