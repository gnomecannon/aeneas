import SwiftUI
import EACore

struct RootView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
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
                #if os(iOS)
                if sizeClass == .compact { PhoneRoot() } else { SplitRoot() }
                #else
                SplitRoot()
                #endif
            }
        }
        .alert("Switch this device to another hub?", isPresented: Binding(get: { model.pendingSetup != nil }, set: { if !$0 { model.pendingSetup = nil } }), presenting: model.pendingSetup) { p in
            Button("Switch hubs", role: .destructive) {
                model.pendingSetup = nil
                Task { model.setupError = await model.connect(p.link) }
            }
            Button("Keep the current hub", role: .cancel) { model.pendingSetup = nil }
        } message: { p in
            Text("This link connects to \(p.hub). This device uses \(p.current) now. Switch only if you made this link yourself.")
        }
        .sheet(item: Binding(get: { model.pendingSnoozeReminderId.map { PendingSnooze(id: $0) } }, set: { model.pendingSnoozeReminderId = $0?.id })) { p in
            SnoozeReasonSheet(reminderId: p.id)
        }
        // After pairing, or a module switched on: what the modules need, asked only after Continue.
        // While the iPhone's Settings sheet is up, that sheet shows it instead.
        .sheet(item: Binding(get: { model.isConfigured && !model.showingSettings ? model.permissionOffer : nil }, set: { if $0 == nil, !model.showingSettings { model.permissionOffer = nil } })) { offer in
            PermissionsOfferView(offer: offer).environmentObject(model)
        }
        .sheet(item: Binding(get: { model.openItemId.map { PendingSnooze(id: $0) } }, set: { model.openItemId = $0?.id })) { p in
            NavigationStack {
                ItemView(id: p.id)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { model.openItemId = nil } } }
            }
            .environmentObject(model)
            .environmentObject(engine)
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
    case .now: NowView()
    case .notes: NotesView()
    case .memory: MemoryView()
    case .people: PeopleView()
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
    case .lists: ListsView()
    case .career: CareerView()
    case .games: GamesView()
    case .films: FilmsView()
    case .calc: CalcView()
    case .settings: SettingsView()
    }
}

/// iPhone: five tabs. Today (with Now on top), the Assistant, Capture, Library (everything else, by area) and Search.
struct PhoneRoot: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine

    private var tabSelection: Binding<Section> {
        Binding(get: { model.section.tab }, set: { model.section = $0 })
    }

    var body: some View {
        TabView(selection: tabSelection) {
            Tab(Section.today.title, systemImage: Section.today.symbol, value: Section.today) { TodayStack() }
            Tab(Section.assistant.title, systemImage: Section.assistant.symbol, value: Section.assistant) { AssistantStack() }
            Tab(Section.capture.title, systemImage: Section.capture.symbol, value: Section.capture) { NavigationStack { CaptureView().themedScreen() } }
            Tab(Section.library.title, systemImage: Section.library.symbol, value: Section.library) { LibraryStack() }
                .badge(engine.unprocessedCaptures.count)
            Tab(value: Section.search, role: .search) { NavigationStack { SearchView().themedScreen() } }
        }
        .sheet(isPresented: $model.showingSettings) {
            NavigationStack {
                SettingsView().themedScreen()
                    .navigationDestination(for: Section.self) { sectionView($0) }
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { model.showingSettings = false } } }
            }
            // A module switched on in Settings, Modules: what it needs is offered over Settings, which is a sheet
            // here (a sheet cannot open under another one).
            .sheet(item: Binding(get: { model.permissionOffer }, set: { if $0 == nil { model.permissionOffer = nil } })) { offer in
                PermissionsOfferView(offer: offer).environmentObject(model)
            }
        }
        // Anything that asks for Settings by section opens the sheet instead.
        .onChange(of: model.section) { old, s in
            if s == .settings { model.section = old == .settings ? .today : old; model.showingSettings = true }
        }
    }
}

/// Today with Now and Week pushed on top when asked for.
struct TodayStack: View {
    @EnvironmentObject var model: AppModel
    @State private var path: [Section] = []

    var body: some View {
        NavigationStack(path: $path) {
            TodayView().themedScreen()
                .settingsGear()
                .navigationDestination(for: Section.self) { sectionView($0) }
        }
        .onChange(of: model.section) { _, s in sync(s) }
        .onAppear { sync(model.section) }
    }

    private func sync(_ s: Section) {
        if s == .week || s == .now { path = [s] } else if s == .today { path = [] }
    }
}

/// The Assistant tab, with Memory (what it knows) one tap away.
struct AssistantStack: View {
    @EnvironmentObject var model: AppModel
    @State private var path: [Section] = []

    var body: some View {
        NavigationStack(path: $path) {
            AssistantView().themedScreen()
                .navigationDestination(for: Section.self) { sectionView($0) }
        }
        .onChange(of: model.section) { _, s in path = s == .memory ? [.memory] : (s == .assistant ? [] : path) }
        .onAppear { if model.section == .memory { path = [.memory] } }
    }
}

/// The Library tab: every other screen, grouped by area, with the chosen one pushed on top.
struct LibraryStack: View {
    @EnvironmentObject var model: AppModel
    @State private var path: [Section] = []

    private func target(for s: Section) -> [Section]? {
        guard s.tab == .library, s != .library else { return s == .library ? [] : nil }
        return [s]
    }

    var body: some View {
        NavigationStack(path: $path) {
            LibraryView().themedScreen()
                .settingsGear()
                .navigationDestination(for: Section.self) { sectionView($0) }
        }
        .onChange(of: model.section) { _, s in if let t = target(for: s) { path = t } }
        .onAppear { if let t = target(for: model.section) { path = t } }
        // A module switched off (here or on another device) takes its open screen with it.
        .onChange(of: model.modules) { _, _ in if let i = path.firstIndex(where: { !model.shows($0) }) { path.removeSubrange(i...) } }
    }
}

/// iPad and Mac: a sidebar with the main screens on top and the Library areas as groups below, plus one detail screen.
struct SplitRoot: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    #if os(macOS)
    @Environment(\.openWindow) private var openWindow
    #endif
    @AppStorage(LibraryOpen.key) private var openRaw = ""
    /// The area holding the open screen, when you closed it while on that screen.
    @State private var shut: String?

    /// The Library area holding the screen you are on.
    private var here: String? { model.libraryAreas.first { $0.sections.contains(model.section) }?.title }

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

    var body: some View {
        NavigationSplitView {
            List(selection: Binding(get: { Optional(model.section == .library ? .today : model.section) }, set: { if let s = $0 { model.section = s } })) {
                ForEach(Section.primary) { s in SidebarRow(section: s).tag(s).contextMenu { popOut(s) } }
                ForEach(model.libraryAreas) { area in
                    let open = expanded(area.title)
                    SwiftUI.Section(isExpanded: open) {
                        ForEach(area.sections) { s in SidebarRow(section: s).tag(s).contextMenu { popOut(s) } }
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
                    Circle().fill(engine.status == .online ? Color.green : Color.orange).frame(width: 8, height: 8)
                    Text(engine.statusLabel).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button { model.section = .settings } label: { Image(systemName: "gearshape") }
                        .buttonStyle(.borderless)
                        .foregroundStyle(model.section == .settings ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                        .help("Settings")
                        .accessibilityLabel("Settings")
                }
                .padding(10)
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

    var body: some View {
        HStack {
            Label(section.title, systemImage: section.symbol)
            Spacer()
            if section == .inbox, !engine.unprocessedCaptures.isEmpty { Text("\(engine.unprocessedCaptures.count)").foregroundStyle(.secondary) }
        }
    }
}
