import SwiftUI
import EACore

/// Settings, then Theme: the app's colors, the shapes a tap throws, the note it plays, the calendars' colors and the
/// phone's bottom bar.
struct ThemeSettingsView: View {
    @ObservedObject private var feel = FeelController.shared
    @State private var debugPage: SettingsPage?

    private var s: FeelSettings { feel.settings }

    private static let shared = "Shared with every device through the hub."

    /// The parts of the theme, each opening its screen: rows of the list, or cards in a wide window.
    @ViewBuilder private func links(card: Bool) -> some View {
        SettingsAreaLink(card: card) { AppColorsView() } label: {
            SettingsRow(title: "App colors", symbol: "circle.lefthalf.filled", summary: appSummary)
        }
        SettingsAreaLink(card: card) { TapEffectsView() } label: {
            SettingsRow(title: "Tap effects", symbol: "sparkles", summary: tapSummary)
        }
        SettingsAreaLink(card: card) { NoteSoundsView() } label: {
            SettingsRow(title: "Note sounds", symbol: "music.note", summary: soundSummary, warning: FeelSynth.blocked)
        }
        SettingsAreaLink(card: card) { CalendarColorsView() } label: {
            SettingsRow(title: "Calendar colors", symbol: "calendar", summary: CalendarColorsView.summary(s.calendars))
        }
        SettingsAreaLink(card: card) { BottomBarSettingsView() } label: {
            SettingsRow(title: "Bottom bar", symbol: "dock.rectangle", summary: BarText.summary(s.shownBar))
        }
    }

    var body: some View {
        // A wide window: the parts as cards side by side, as Settings itself shows its areas; the rows used to
        // be stretched across the window.
        WideReader { wide in
            if wide {
                WidePage {
                    CardGrid { links(card: true) }
                    Text(Self.shared).font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                List {
                    SwiftUI.Section {
                        links(card: false)
                    } footer: {
                        Text(Self.shared)
                    }
                    .themedRow()
                }
            }
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Theme")
        .pageDestination(item: $debugPage) { $0.view }
        .task { await feel.refresh() }
        .onAppear {
            #if DEBUG
            if let p = SettingsPage.launchArgument("EAThemePage") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { debugPage = p }
            }
            #endif
        }
    }

    private var appSummary: String {
        let name = AppTheme.name(s.app_theme, custom: s.app_themes)
        guard s.activeAppTheme == nil else { return name }
        switch s.appearance {
        case "light": return "\(name), light"
        case "dark": return "\(name), dark"
        default: return "\(name), follows the system"
        }
    }

    private var tapSummary: String {
        guard s.motion else { return "Shapes off" }
        let n = s.shapes.count + s.enabledImages.count
        return "\(FeelTheme.name(s.theme, palettes: s.palettes)), \(n) shape\(n == 1 ? "" : "s")"
    }

    private var soundSummary: String {
        if FeelSynth.blocked { return "Off on this device after a crash" }
        guard s.sound else { return "Notes off" }
        guard feel.soundHere else { return "Off on this Mac" }
        return "\(s.synth.capitalized), \(s.playKey) \(FeelMusic.scaleName(s.playScale).lowercased())"
    }
}

// MARK: Calendar colors

/// Theme, Calendar colors: each calendar events come from, in the color its calendar gives it (Apple Calendar or
/// iCloud, as an app or the hub's sync reported it), or in one chosen here, which every device then uses. The same
/// page as the web's.
struct CalendarColorsView: View {
    @ObservedObject private var feel = FeelController.shared

    private var calendars: [CalendarColorEntry] { feel.settings.calendars }

    /// The line under Calendar colors in Theme.
    static func summary(_ calendars: [CalendarColorEntry]) -> String {
        let n = calendars.count
        guard n > 0 else { return "None yet" }
        let mine = calendars.filter { $0.chosen != nil }.count
        return "\(n) \(n == 1 ? "calendar" : "calendars")" + (mine > 0 ? ", \(mine) in colors you chose" : ", as their calendars color them")
    }

    /// Accounts in the order they first appear, the calendars of each by name.
    private var groups: [(account: String, calendars: [CalendarColorEntry])] {
        var order: [String] = []
        for c in calendars where !order.contains(c.account ?? "") { order.append(c.account ?? "") }
        return order.map { a in
            (a, calendars.filter { ($0.account ?? "") == a }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending })
        }
    }

    var body: some View {
        Form {
            SwiftUI.Section {
                Text("Events are drawn in their calendar's color on every device: the color Apple Calendar or iCloud gives it, or one you choose here. Events made in Aeneas on no calendar use the theme's accent.")
                    .font(.footnote).foregroundStyle(.secondary)
                if calendars.isEmpty {
                    Text("No calendars yet. They appear once the iPhone, iPad or Mac app reads Apple Calendar, or the hub syncs iCloud calendars.")
                        .foregroundStyle(.secondary)
                }
                if let e = feel.calendarColorError {
                    Text(e).font(.footnote).foregroundStyle(.dangerText)
                }
            }
            .themedRow()
            ForEach(groups, id: \.account) { g in
                SwiftUI.Section {
                    ForEach(g.calendars) { c in row(c) }
                } header: {
                    if groups.count > 1 { Text(g.account.isEmpty ? "Other" : g.account) }
                }
                .themedRow()
            }
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Calendar colors")
        .task { await feel.refresh() }
    }

    private func row(_ c: CalendarColorEntry) -> some View {
        HStack(spacing: 12) {
            ColorPicker(selection: Binding(get: { FeelController.color(c.shown ?? "#888888") ?? .gray },
                                           set: { feel.chooseCalendarColor(key: c.key, color: FeelController.hex($0)) }),
                        supportsOpacity: false) { EmptyView() }
                .labelsHidden()
                .accessibilityLabel("Color for \(c.name)")
            Text(c.name)
            Spacer(minLength: 8)
            if c.chosen != nil {
                Button(c.color != nil ? "Use its own color" : "Clear") { feel.chooseCalendarColor(key: c.key, color: nil) }
                    .buttonStyle(.borderless)
                    .font(.subheadline)
            } else {
                Text(c.color != nil ? "Its own color" : "No color of its own").font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: App colors

/// Appearance for Classic, then every theme as a small live preview; tap one to use it.
struct AppColorsView: View {
    @ObservedObject private var feel = FeelController.shared
    @Environment(\.colorScheme) private var scheme
    @State private var editing: ThemeDraft?
    @State private var renaming: AppTheme?
    @State private var newName = ""
    @State private var deleting: AppTheme?

    private var s: FeelSettings { feel.settings }
    private let columns = [GridItem(.adaptive(minimum: 140), spacing: 12)]
    #if DEBUG
    static var debugEditorShown = false
    #endif

    var body: some View {
        Form {
            SwiftUI.Section {
                Picker("Appearance", selection: Binding(get: { s.appearance }, set: { feel.change(["appearance": .string($0)]) })) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
                .pickerStyle(.segmented)
            } header: {
                Text("Appearance")
            } footer: {
                Text(s.activeAppTheme.map { "Used by Classic. \($0.name) is always \($0.mode)." } ?? "Used by Classic.")
            }
            .themedRow()

            SwiftUI.Section("Themes") {
                LazyVGrid(columns: columns, spacing: 12) {
                    classicCard
                    ForEach(AppTheme.builtIns) { t in card(t, choice: t.id) }
                    ForEach(s.app_themes) { t in card(t, choice: "custom:\(t.id)") }
                }
                .padding(.vertical, 6)
            }
            .themedRow()

            SwiftUI.Section {
                if let t = s.activeAppTheme, s.app_themes.contains(where: { $0.id == t.id }) {
                    Button { editing = ThemeDraft(theme: t, isNew: false) } label: { Label("Edit \(t.name)", systemImage: "slider.horizontal.3") }
                    Button { newName = t.name; renaming = t } label: { Label("Rename", systemImage: "pencil") }
                    Button { duplicate(t) } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
                    Button(role: .destructive) { deleting = t } label: { Label("Delete", systemImage: "trash") }
                } else if let t = s.activeAppTheme {
                    Button { duplicate(t, edit: true) } label: { Label("Customize \(t.name)", systemImage: "slider.horizontal.3") }
                }
                Button { newTheme() } label: { Label("New theme", systemImage: "plus.circle") }
            } footer: {
                Text("A new theme starts from the one in use. Long press a theme for more.")
            }
            .themedRow()
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("App colors")
        .sheet(item: $editing) { d in AppThemeEditor(draft: d) }
        .onAppear {
            #if DEBUG
            // `-EAThemeEditor YES` (DebugHooks): the editor on the theme in use, once, for screenshots.
            if UserDefaults.standard.bool(forKey: "EAThemeEditor"), !Self.debugEditorShown {
                Self.debugEditorShown = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    if let t = s.activeAppTheme { duplicate(t, edit: true) } else { newTheme() }
                }
            }
            #endif
        }
        .alert("Rename theme", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Save") {
                if var t = renaming { t.name = FeelID.name(newName, fallback: t.name); feel.saveAppTheme(t) }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .confirmationDialog("Delete \(deleting?.name ?? "this theme")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) { if let t = deleting { feel.deleteAppTheme(t.id) }; deleting = nil }
        } message: {
            Text("Every device goes back to Classic if it was using it.")
        }
    }

    private var classicScheme: ColorScheme {
        switch s.appearance {
        case "light": return .light
        case "dark": return .dark
        default: return s.activeAppTheme == nil ? scheme : .light
        }
    }

    private var classicCard: some View {
        Button { feel.change(["app_theme": .string(AppTheme.classicId)]) } label: {
            ThemeCard(swatch: .classic, name: "Classic", selected: s.app_theme == AppTheme.classicId)
                .environment(\.colorScheme, classicScheme)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button { duplicate(FeelController.classicStart(dark: classicScheme == .dark), edit: true) } label: { Label("Customize", systemImage: "slider.horizontal.3") }
        }
        .accessibilityAddTraits(s.app_theme == AppTheme.classicId ? .isSelected : [])
    }

    private func card(_ t: AppTheme, choice: String) -> some View {
        let custom = choice.hasPrefix("custom:")
        return Button { feel.change(["app_theme": .string(choice)]) } label: {
            ThemeCard(swatch: ThemeSwatch(t), name: t.name, selected: s.app_theme == choice)
        }
        .buttonStyle(.plain)
        .contextMenu {
            if custom {
                Button { editing = ThemeDraft(theme: t, isNew: false) } label: { Label("Edit", systemImage: "slider.horizontal.3") }
                Button { newName = t.name; renaming = t } label: { Label("Rename", systemImage: "pencil") }
                Button { duplicate(t) } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
                Button(role: .destructive) { deleting = t } label: { Label("Delete", systemImage: "trash") }
            } else {
                Button { duplicate(t, edit: true) } label: { Label("Customize", systemImage: "slider.horizontal.3") }
            }
        }
        .accessibilityAddTraits(s.app_theme == choice ? .isSelected : [])
    }

    private func newTheme() {
        let base = s.activeAppTheme ?? FeelController.classicStart(dark: classicScheme == .dark)
        var t = base
        t.id = ""
        t.name = "My theme"
        editing = ThemeDraft(theme: t, isNew: true)
    }

    private func duplicate(_ t: AppTheme, edit: Bool = false) {
        let name = FeelID.copyName(t.name, taken: s.app_themes.map(\.name))
        if edit {
            var d = t
            d.id = ""
            d.name = name
            editing = ThemeDraft(theme: d, isNew: true)
        } else {
            feel.newAppTheme(from: t, name: name, select: true)
        }
    }
}

struct ThemeDraft: Identifiable {
    var theme: AppTheme
    var isNew: Bool
    var id: String { isNew ? "new" : theme.id }
}

/// Four colors in a small picture of a screen: background, a surface card with text, and an accent button.
struct ThemeSwatch {
    var background: Color
    var surface: Color
    var text: Color
    var accent: Color
    /// Fine, needs a look and problem as words, for the editor's preview.
    var status: [StatusTone: Color] = [:]
    /// Words on the accent, as the theme's buttons draw them.
    var onAccent: Color = .white

    init(_ t: AppTheme) {
        let c = ThemeColors(t)
        background = c.background; surface = c.surface; text = c.text; accent = c.accent; onAccent = c.onAccent
        let p = StatusPalette(theme: t)
        for tone in StatusTone.allCases { status[tone] = p.text[tone].flatMap(FeelController.color) }
    }

    init(background: Color, surface: Color, text: Color, accent: Color) {
        self.background = background; self.surface = surface; self.text = text; self.accent = accent
    }

    /// The system look, resolved for whatever color scheme the card is drawn in.
    static var classic: ThemeSwatch {
        #if os(iOS)
        ThemeSwatch(background: Color(uiColor: .systemGroupedBackground), surface: Color(uiColor: .secondarySystemGroupedBackground),
                    text: Color(uiColor: .label), accent: Color("AccentColor"))
        #else
        ThemeSwatch(background: Color(nsColor: .windowBackgroundColor), surface: Color(nsColor: .controlBackgroundColor),
                    text: Color(nsColor: .labelColor), accent: Color("AccentColor"))
        #endif
    }
}

struct ThemeCard: View {
    var swatch: ThemeSwatch
    var name: String
    var selected: Bool
    var large = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 12).fill(swatch.background)
                VStack(alignment: .leading, spacing: large ? 10 : 6) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Today").font(large ? .headline : .caption.weight(.semibold)).foregroundStyle(swatch.text)
                        Text("Water the plants").font(large ? .subheadline : .caption2).foregroundStyle(swatch.text.opacity(0.7))
                        if large, !swatch.status.isEmpty {
                            HStack(spacing: 12) {
                                ForEach(StatusTone.allCases, id: \.self) { tone in
                                    Text(tone.title).font(.subheadline.weight(.medium)).foregroundStyle(swatch.status[tone] ?? swatch.text)
                                }
                            }
                            .padding(.top, 2)
                        }
                    }
                    .padding(large ? 12 : 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(swatch.surface, in: RoundedRectangle(cornerRadius: 8))
                    Text("Done")
                        .font(large ? .subheadline.weight(.semibold) : .caption2.weight(.semibold))
                        .foregroundStyle(swatch.onAccent)
                        .padding(.horizontal, large ? 16 : 10).padding(.vertical, large ? 7 : 4)
                        .background(swatch.accent, in: Capsule())
                }
                .padding(large ? 14 : 10)
            }
            .frame(height: large ? (swatch.status.isEmpty ? 170 : 194) : 104)
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(selected ? AnyShapeStyle(.tint) : AnyShapeStyle(.primary.opacity(0.15)), lineWidth: selected ? 3 : 1))
            if !large {
                HStack(spacing: 4) {
                    Text(name).font(.subheadline).lineLimit(1)
                    if selected { Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint).font(.subheadline) }
                }
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name)
    }
}

/// Name, light or dark, four colors, and a live preview. Saving uses the theme at once.
struct AppThemeEditor: View {
    @ObservedObject private var feel = FeelController.shared
    @Environment(\.dismiss) private var dismiss
    @State private var t: AppTheme
    private let isNew: Bool

    init(draft: ThemeDraft) {
        _t = State(initialValue: draft.theme)
        isNew = draft.isNew
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
            Form {
                SwiftUI.Section {
                    ThemeCard(swatch: ThemeSwatch(t), name: t.name, selected: false, large: true)
                        .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
                    if !t.isReadable {
                        Label("Text may be hard to read on these colors.", systemImage: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(.warnText)
                    }
                }
                .themedRow()
                SwiftUI.Section {
                    TextField("Name", text: $t.name)
                    Picker("Mode", selection: $t.mode) {
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    .pickerStyle(.segmented)
                }
                .themedRow()
                SwiftUI.Section {
                    colorRow("Accent", \.accent).id("colors")
                    colorRow("Background", \.background)
                    colorRow("Surface", \.surface)
                    colorRow("Text", \.text)
                } footer: {
                    Text("Accent colors buttons and links. Surface is the cards and rows that sit on the background.")
                }
                .themedRow()
                SwiftUI.Section {
                    ForEach(StatusTone.allCases, id: \.self) { tone in statusRow(tone) }
                    if StatusTone.allCases.contains(where: t.hasOwnStatus) {
                        Button("Classic status colors") { t.ok = nil; t.warn = nil; t.danger = nil }
                    }
                } header: {
                    Text("Status colors")
                } footer: {
                    Text("Used for what is fine, what needs a look and what is a problem. As words they are darkened or lightened as far as needed to read on this theme.")
                }
                .themedRow()
            }
            .onAppear {
                #if DEBUG
                // `-EAScrollTo status` (DebugHooks): the colors and status colors in view, for screenshots.
                if UserDefaults.standard.string(forKey: "EAScrollTo") == "status" {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { proxy.scrollTo("colors", anchor: .top) }
                }
                #endif
            }
            }
            .formStyle(.grouped)
            .themedScreen()
            .navigationTitle(isNew ? "New theme" : "Edit theme")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() } }
            }
        }
        #if os(macOS)
        // Tall enough on the Mac for the preview, the four colors and the status colors without scrolling.
        .frame(minWidth: 420, minHeight: 680)
        #endif
    }

    private func colorRow(_ label: String, _ kp: WritableKeyPath<AppTheme, String>) -> some View {
        ColorPicker(label, selection: Binding(get: { FeelController.color(t[keyPath: kp]) ?? .gray }, set: { t[keyPath: kp] = FeelController.hex($0) }),
                    supportsOpacity: false)
    }

    /// One status color: the theme's own, or the classic one for its mode until one is chosen.
    private func statusRow(_ tone: StatusTone) -> some View {
        ColorPicker(selection: Binding(get: { FeelController.color(t.status(tone)) ?? .gray },
                                       set: { t = t.withStatus(tone, FeelController.hex($0)) }),
                    supportsOpacity: false) {
            HStack {
                Text(tone.title)
                Spacer()
                Text(t.hasOwnStatus(tone) ? t.status(tone) : "Classic").font(.caption.monospaced()).foregroundStyle(.secondary)
            }
        }
    }

    private func save() {
        t.name = FeelID.name(t.name, fallback: "My theme")
        if isNew {
            feel.newAppTheme(from: t, name: t.name, select: true)
        } else {
            feel.saveAppTheme(t, select: true)
        }
        dismiss()
    }
}
