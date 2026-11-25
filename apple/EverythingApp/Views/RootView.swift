import SwiftUI
import EACore

struct RootView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    var body: some View {
        Group {
            if model.deviceRemoved {
                RemovedDeviceView()
            } else if !model.isConfigured {
                SetupView()
            } else {
                Group {
                    #if os(iOS)
                    if sizeClass == .compact { PhoneRoot() } else { SplitRoot() }
                    #else
                    SplitRoot()
                    #endif
                }
                // Someone offered to help with this person's devices: the one question, at the top until answered.
                .safeAreaInset(edge: .top, spacing: 0) { HelperOfferInset() }
            }
        }
        // Who helps this person: when the app opens or comes back, and every two minutes (HelpersViews.swift).
        .task(id: model.isConfigured) {
            while model.isConfigured, !Task.isCancelled {
                await HelpersStore.shared.refresh(engine, force: false)
                try? await Task.sleep(nanoseconds: 120_000_000_000)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, model.isConfigured { Task { await HelpersStore.shared.refresh(engine, force: false) } }
        }
        // Pairing links and join codes: switch hubs, pair again, how it went, and a phone's Add (JoinViews.swift). On the
        // iPhone, while the Settings sheet is up, that sheet shows them instead.
        .pairingPrompts(active: !model.showingSettings)
        .sheet(item: Binding(get: { model.pendingSnoozeReminderId.map { PendingSnooze(id: $0) } }, set: { model.pendingSnoozeReminderId = $0?.id })) { p in
            SnoozeReasonSheet(reminderId: p.id)
        }
        // After pairing, or a module switched on: what the modules need, asked only after Continue.
        // While the iPhone's Settings sheet is up, that sheet shows it instead.
        .sheet(item: Binding(get: { model.isConfigured && !model.showingSettings ? model.permissionOffer : nil }, set: { if $0 == nil, !model.showingSettings { model.permissionOffer = nil } })) { offer in
            PermissionsOfferView(offer: offer).environmentObject(model)
        }
        // Machines switched on here: Set up Machines, once the permission screen (if any) is answered.
        .sheet(isPresented: Binding(get: { model.isConfigured && !model.showingSettings && model.permissionOffer == nil && model.machinesStart },
                                    set: { if !$0, !model.showingSettings { model.machinesStart = false } })) {
            MachinesStartSheet().environmentObject(model).environmentObject(engine)
        }
        .sheet(item: Binding(get: { model.openItemId.map { PendingSnooze(id: $0) } }, set: { model.openItemId = $0?.id })) { p in
            NavigationStack {
                ItemView(id: p.id)
                    // In the theme's colors, as the related items it opens over itself are (PageLink).
                    .themedPage()
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { model.openItemId = nil } } }
            }
            .environmentObject(model)
            .environmentObject(engine)
            #if os(macOS)
            // A Mac sheet takes its content's size, and a list has none of its own: without a size it opened with only
            // its title and Done.
            .frame(minWidth: 480, idealWidth: 560, minHeight: 480, idealHeight: 620)
            #endif
        }
        .overlay(alignment: .top) {
            if let c = model.activityCheckin {
                CheckinBanner(checkin: c, still: { Task { await model.answerCheckin(stop: false) } }, stop: { Task { await model.answerCheckin(stop: true) } })
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.default, value: model.activityCheckin)
    }
}

struct PendingSnooze: Identifiable { var id: String }

/// iPhone: a gear at the top of a tab's first screen that opens Settings. Elsewhere Settings sits in the sidebar.
struct SettingsGear: ViewModifier {
    @EnvironmentObject var model: AppModel
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    func body(content: Content) -> some View {
        #if os(iOS)
        content.toolbar {
            if sizeClass == .compact {
                ToolbarItem(placement: .topBarLeading) {
                    Button { model.showingSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Settings")
                }
            }
        }
        #else
        content
        #endif
    }
}

extension View {
    func settingsGear() -> some View { modifier(SettingsGear()) }
}

/// A screen with the app theme behind it.
func sectionView(_ s: Section) -> some View { ModuleGate(section: s) }

/// A screen whose module is off says so instead (a Mac window left open on it, a link pushed before the switch arrived).
private struct ModuleGate: View {
    @EnvironmentObject var model: AppModel
    var section: Section

    var body: some View {
        if model.shows(section) {
            sectionContent(section).themedScreen()
        } else {
            let title = section.module.flatMap { m in model.modules.first { $0.id == m.rawValue }?.title } ?? section.title
            EmptyState(text: "\(title) is off. Turn it on in Settings, Modules.").themedScreen()
        }
    }
}

@ViewBuilder
private func sectionContent(_ s: Section) -> some View {
    switch s {
    case .today: TodayView()
    case .assistant: AssistantView()
    case .capture: CaptureView()
    case .library: LibraryView()
    case .search: SearchView()
    case .inbox: InboxView()
    case .tasks: TasksView()
    case .reminders: TasksView() // reminders are tasks now
    case .week: WeekView()
    case .renewals: RenewalsView()
    case .dashboard: DashboardView()
    case .planRules: PlanRulesView()
    case .notes: NotesView()
    case .memory: MemoryView()
    case .people: PeopleView()
    case .reference: ReferenceView()
    case .ops: OpsView()
    case .hosts: HostsView()
    case .journal: JournalView()
    case .snippets: SnippetsView()
    case .projects: ProjectsView()
    case .wiki: WikiView()
    case .procedures: ProceduresView()
    case .music: MusicView()
    case .quiz: QuizView()
    case .images: ImageGalleryView()
    case .health: HealthDataView()
    case .logs: LogsView()
    case .pet: PetView()
    case .food: FoodView()
    case .sensors: SensorsView()
    case .mail: MailView()
    case .lists: ListsView()
    case .career: CareerView()
    case .games: GamesView()
    case .films: FilmsView()
    case .listening: ListeningView()
    case .calc: CalcView()
    case .settings: SettingsView()
    }
}

// iPhone: PhoneRoot, the screens of the bottom bar each with its own stack, and the bar itself (PhoneBar.swift).

/// iPad and Mac: a sidebar with the main screens on top and the Library areas as groups below, plus one detail screen.
struct SplitRoot: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.eaTheme) private var theme
    #if os(macOS)
    @Environment(\.openWindow) private var openWindow
    #endif
    @AppStorage(LibraryOpen.key) private var openRaw = ""
    /// The area holding the open screen, when you closed it while on that screen.
    @State private var shut: String?

    /// The Library area holding the screen you are on (the change journal and snippets count as the Overview).
    private var here: String? { model.libraryAreas.first { $0.sections.contains(model.section.libraryRow) }?.title }

    /// Areas start closed and remember being opened. A closed area also opens for as long as it holds the screen you
    /// are on (reached by search or a shortcut, say) without being remembered as open; closing it then keeps it closed
    /// until you move to another area.
    private func expanded(_ title: String) -> Binding<Bool> {
        Binding(
            get: { LibraryOpen.isOpen(openRaw, title) || (title == here && shut != title) },
            set: { open in
                openRaw = LibraryOpen.setting(openRaw, title, open: open)
                if title == here { shut = open ? nil : title }
            }
        )
    }

    /// The row the sidebar shows as chosen (the Library is only a screen on the iPhone).
    private var chosen: Section { model.section == .library ? .today : model.section }

    var body: some View {
        NavigationSplitView {
            List(selection: Binding(get: { Optional(chosen) }, set: { if let s = $0 { model.section = s } })) {
                ForEach(Section.primary) { s in SidebarRow(section: s, chosen: s == chosen).tag(s).contextMenu { popOut(s) } }
                ForEach(model.libraryAreas) { area in
                    let open = expanded(area.title)
                    SwiftUI.Section(isExpanded: open) {
                        ForEach(area.sections) { s in SidebarRow(section: s, chosen: s == chosen).tag(s).contextMenu { popOut(s) } }
                    } header: {
                        HStack {
                            Text(area.title)
                            Spacer()
                            if !open.wrappedValue, area.sections.contains(.inbox), !engine.unprocessedCaptures.isEmpty {
                                Text("\(engine.unprocessedCaptures.count)").monospacedDigit()
                                    .accessibilityLabel("\(engine.unprocessedCaptures.count) to sort")
                            }
                        }
                    }
                }
            }
            .themedScreen()
            .navigationTitle("Aeneas")
            .navigationSplitViewColumnWidth(min: 200, ideal: 230)
            .onChange(of: here) { _, _ in shut = nil }
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 6) {
                    Circle().fill(engine.status == .online ? StatusStyle.ok : StatusStyle.warn).frame(width: 8, height: 8)
                    Text(engine.statusLabel).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button { model.section = .settings } label: { Image(systemName: "gearshape") }
                        .buttonStyle(.borderless)
                        .foregroundStyle(model.section == .settings ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                        .help("Settings")
                        .accessibilityLabel("Settings")
                }
                .padding(10)
                // In the sidebar's own color, not see-through: in a window shorter than the list, the row that
                // scrolled under the status line showed through it ("Films" under "Online").
                // Down to the sidebar's bottom edge: on the iPhone and iPad the strip under the status line (the
                // space kept free for the home indicator) showed the next row too.
                .background {
                    Group { if let theme { theme.background } else { Rectangle().fill(.bar) } }
                        .ignoresSafeArea(.container, edges: .bottom)
                }
            }
        } detail: {
            NavigationStack {
                sectionView(model.section)
                    .navigationDestination(for: Section.self) { sectionView($0) }
                    #if os(macOS)
                    .toolbar {
                        if model.section != .settings, model.section != .library {
                            ToolbarItem(placement: .automatic) {
                                Button { openWindow(id: "screen", value: model.section) } label: { Image(systemName: "rectangle.portrait.on.rectangle.portrait") }
                                    .help("Open \(model.section.title) in its own window")
                                    .accessibilityLabel("Open \(model.section.title) in its own window")
                            }
                        }
                    }
                    #endif
            }
            // The screens ask how wide this side is before they lay themselves out (WideLayout in UI.swift).
            .givesWideHint()
        }
    }

    /// Mac: a sidebar row's right-click menu opens that screen in its own window. Nothing on iPad.
    @ViewBuilder private func popOut(_ s: Section) -> some View {
        #if os(macOS)
        Button("Open in New Window") { openWindow(id: "screen", value: s) }
        #endif
    }
}

struct SidebarRow: View {
    @EnvironmentObject var engine: SyncEngine
    var section: Section
    /// Whether this is the row of the screen that is open. Only the Mac uses it, to draw the row in the theme's colors.
    var chosen = false

    var body: some View {
        HStack {
            Label(section.title, systemImage: section.symbol)
            Spacer()
            if section == .inbox, !engine.unprocessedCaptures.isEmpty { Text("\(engine.unprocessedCaptures.count)").foregroundStyle(.secondary) }
        }
        #if os(macOS)
        .modifier(SidebarRowTheme(chosen: chosen))
        #endif
    }
}

#if os(macOS)
/// Mac: a sidebar row in the theme's colors. The Mac draws a sidebar's icons and its chosen row in the accent color
/// picked in System Settings, whatever tint the app sets: under Midnight (violet) the icons and the chosen row were
/// orange on a Mac set to orange. Under a theme the icons take the theme's accent, and the chosen row is drawn here:
/// the theme's accent with the words and the icon in the theme's color for words on the accent (the Mac puts a white
/// icon there, which does not read on a light accent such as Forest's green). In a window that is not the active
/// one the row is a quiet band, as the Mac's own is. Classic is left to the system.
private struct SidebarRowTheme: ViewModifier {
    @Environment(\.eaTheme) private var theme
    @Environment(\.appearsActive) private var active
    var chosen: Bool

    func body(content: Content) -> some View {
        if let theme {
            content
                .foregroundStyle(chosen && active ? theme.onAccent : theme.text)
                .labelStyle(SidebarLabel(icon: chosen && active ? theme.onAccent : nil))
                .listItemTint(.fixed(theme.accent))
                .listRowBackground(chosen ? band(theme) : nil)
        } else {
            content
        }
    }

    /// The Mac's own band for the chosen row stays under this one and cannot be switched off, so this covers the
    /// whole row with the sidebar's background first. The band has the Mac's shape: 10 points in from each side.
    private func band(_ theme: ThemeColors) -> some View {
        ZStack {
            theme.background
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(active ? AnyShapeStyle(theme.accent) : AnyShapeStyle(theme.text.opacity(0.12)))
                .padding(.horizontal, 10)
        }
    }
}

/// The label as the sidebar draws it, with the icon in a color of its own when one is given.
private struct SidebarLabel: LabelStyle {
    var icon: Color?

    func makeBody(configuration: Configuration) -> some View {
        Label {
            configuration.title
        } icon: {
            if let icon { configuration.icon.foregroundStyle(icon) } else { configuration.icon }
        }
    }
}
#endif
