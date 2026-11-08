import SwiftUI
import Charts
import UniformTypeIdentifiers
import EACore

/// Home sensors: state at a glance, the last 24 h per sensor, bounds and alerts.
/// Config comes from the synced `sensor` entities; the series comes from `GET /sensors`
/// because readings are left out of the sync feed.
struct SensorsView: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    @State private var proposing: String?
    @State private var series: [String: [SensorPoint]] = [:]
    @State private var loadedAt: Date?
    @State private var loadError: String?
    @State private var loading = false
    @State private var editing: Entity?
    @State private var exportDoc: SensorCSVFile?
    /// The sensor key (GET /feeds): it posts readings and nothing else, so it can sit on a board.
    @State private var sensorKey = ""
    @State private var exportName = ""
    @State private var exportError: String?
    @State private var showHowTo = false

    private var sensors: [Entity] {
        engine.list(.sensor).sorted { $0.str("name").localizedCaseInsensitiveCompare($1.str("name")) == .orderedAscending }
    }

    var body: some View {
        let list = sensors
        List {
            SwiftUI.Section { summary(list) }

            if list.isEmpty {
                SwiftUI.Section {
                    Text("No sensors yet. A sensor appears here when its first reading is posted to the hub. Open How to post readings below.")
                        .foregroundStyle(.secondary)
                }
            }

            ForEach(list) { s in
                SwiftUI.Section {
                    SensorCard(sensor: s, points: series[s.id], onSettings: { editing = s }, onExport: { Task { await export(s) } },
                               onPropose: { Task { await propose(s) } }, proposing: proposing == s.id)
                }
            }

            SwiftUI.Section {
                DisclosureGroup("How to post readings", isExpanded: $showHowTo) { howTo }
            }
        }
        .navigationTitle("Sensors")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .disabled(loading)
            }
        }
        .sheet(item: $editing) { s in SensorSettingsView(sensor: s) }
        .fileExporter(isPresented: Binding(get: { exportDoc != nil }, set: { if !$0 { exportDoc = nil } }), document: exportDoc, contentType: .commaSeparatedText, defaultFilename: exportName) { _ in exportDoc = nil }
        .refreshable { await load() }
        .task {
            // Readings arrive every few minutes; poll while the screen is open.
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }

    // MARK: summary

    @ViewBuilder private func summary(_ list: [Entity]) -> some View {
        let attention = list.filter { SensorState.of($0) != .ok }
        VStack(alignment: .leading, spacing: 6) {
            if list.isEmpty {
                Label("No sensors", systemImage: "sensor").font(.title3.weight(.semibold))
            } else if attention.isEmpty {
                Label("\(list.count) sensor\(list.count == 1 ? "" : "s"), all OK", systemImage: "checkmark.circle.fill")
                    .font(.title3.weight(.semibold)).foregroundStyle(.green)
            } else {
                Label("\(attention.count) of \(list.count) need a look", systemImage: "exclamationmark.triangle.fill")
                    .font(.title3.weight(.semibold)).foregroundStyle(.orange)
                Text(attention.map { "\(SensorCard.displayName($0)) \(SensorState.of($0).label.lowercased())" }.joined(separator: ", "))
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if let e = loadError {
                BodyErrorRow(text: e)
            } else if let t = loadedAt {
                Text("Charts updated \(BodyFmt.ago(t))").font(.caption).foregroundStyle(.secondary)
            } else if loading {
                Text("Loading charts").font(.caption).foregroundStyle(.secondary)
            }
            if let e = exportError { BodyErrorRow(text: e) }
        }
        .padding(.vertical, 4)
    }

    // MARK: how to

    private var hubURL: String { engine.client?.http?.baseURL.absoluteString ?? "http://your-hub" }

    private var howTo: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("POST to this address with a JSON body. The first post creates the sensor. A reading outside the bounds raises one alert per crossing.")
                .font(.subheadline)
            Text("\(hubURL)/sensors/<name>/readings?key=\(sensorKey.isEmpty ? "<sensor key>" : sensorKey)")
                .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            Text("{\"value\": 21.5, \"unit\": \"C\"}")
                .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            Text("MicroPython on a Pico W:").font(.subheadline)
            ScrollView(.horizontal) {
                Text(example).font(.system(.caption2, design: .monospaced)).textSelection(.enabled).padding(8)
            }
            .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        }
        .padding(.vertical, 6)
    }

    private var example: String {
        """
        import network, urequests, time
        HUB = "\(hubURL)"
        KEY = "\(sensorKey.isEmpty ? "<sensor key>" : sensorKey)"   # posts readings only, nothing else
        NAME = "planter_moisture"
        UNIT = "%"

        def post(value):
            r = urequests.post(f"{HUB}/sensors/{NAME}/readings?key={KEY}",
                               json={"value": value, "unit": UNIT})
            r.close()

        while True:
            post(read_sensor())
            time.sleep(300)
        """
    }

    // MARK: actions

    private func load() async {
        guard let c = engine.client else { loadError = "Charts need the hub. Set it up in Settings."; return }
        if sensorKey.isEmpty, let k = try? await c.feedKeys() { sensorKey = k.sensors.key }
        loading = true
        defer { loading = false }
        do {
            let rows = try await c.sensors()
            var map: [String: [SensorPoint]] = [:]
            for r in rows {
                map[r.entity.id] = r.series_24h
                await engine.absorb(r.entity)
            }
            series = map
            loadedAt = Date()
            loadError = nil
        } catch {
            loadError = "Could not load charts: \(error.localizedDescription)"
        }
    }

    /// An alert opens a chat where the assistant looks into it and proposes one fix, which runs only when approved.
    private func propose(_ s: Entity) async {
        guard let c = engine.client else { exportError = "Proposing a fix needs the hub."; return }
        proposing = s.id
        defer { proposing = nil }
        do { model.openChat(try await c.proposeSensorFix(name: s.str("name"))) }
        catch { exportError = "Could not start a fix for \(SensorCard.displayName(s)): \(error.localizedDescription)" }
    }

    private func export(_ s: Entity) async {
        guard let c = engine.client else { exportError = "Export needs the hub."; return }
        exportError = nil
        do {
            let text = try await c.sensorCSV(name: s.str("name"), days: 30)
            exportName = "\(s.str("name"))-30d-\(PetCustody.dateString(Date())).csv"
            exportDoc = SensorCSVFile(text: text)
        } catch {
            exportError = "Could not export \(SensorCard.displayName(s)): \(error.localizedDescription)"
        }
    }
}

// MARK: state

enum SensorState: String {
    case ok, low, high, stale

    /// The hub's state when present, else derived: stale past `stale_minutes` (default 180), low under min, high over max.
    static func of(_ s: Entity, now: Date = Date()) -> SensorState {
        if let st = SensorState(rawValue: s.str("state")) { return st }
        guard let v = s.number("last_value"), let at = s.date("last_at") else { return .stale }
        let staleMin = s.number("stale_minutes").flatMap { $0 > 0 ? $0 : nil } ?? 180
        if now.timeIntervalSince(at) / 60 > staleMin { return .stale }
        if let lo = s.number("min"), v < lo { return .low }
        if let hi = s.number("max"), v > hi { return .high }
        return .ok
    }

    var label: String {
        switch self {
        case .ok: return "OK"
        case .low: return "Low"
        case .high: return "High"
        case .stale: return "No data"
        }
    }
    var symbol: String {
        switch self {
        case .ok: return "checkmark.circle.fill"
        case .low: return "arrow.down.circle.fill"
        case .high: return "arrow.up.circle.fill"
        case .stale: return "clock.badge.exclamationmark"
        }
    }
    var color: Color {
        switch self {
        case .ok: return .green
        case .low: return .blue
        case .high: return .red
        case .stale: return .gray
        }
    }
}

// MARK: card

struct SensorCard: View {
    var sensor: Entity
    var points: [SensorPoint]?
    var onSettings: () -> Void
    var onExport: () -> Void
    var onPropose: () -> Void = {}
    var proposing = false

    static func displayName(_ s: Entity) -> String {
        let n = s.str("name").replacingOccurrences(of: "_", with: " ")
        return n.prefix(1).uppercased() + n.dropFirst()
    }

    var body: some View {
        let state = SensorState.of(sensor)
        let unit = sensor.str("unit")
        let lo = sensor.number("min"), hi = sensor.number("max")
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(Self.displayName(sensor)).font(.headline)
                    if let loc = sensor.string("location"), !loc.isEmpty { Text(loc).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 6)
                BodyStatusPill(text: state.label, symbol: state.symbol, color: state.color)
            }

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let v = sensor.number("last_value") {
                    Text("\(BodyFmt.number(v)) \(unit)").font(.system(.largeTitle, design: .rounded).weight(.semibold)).monospacedDigit()
                } else {
                    Text("No reading yet").font(.title3).foregroundStyle(.secondary)
                }
                if let at = sensor.date("last_at") { Text(BodyFmt.ago(at)).font(.subheadline).foregroundStyle(.secondary) }
            }

            chart(lo: lo, hi: hi, state: state)

            Text(boundsText(lo: lo, hi: hi, unit: unit)).font(.caption).foregroundStyle(.secondary)

            HStack(spacing: 10) {
                if state != .ok && sensor.bool("alert") != false {
                    Button { onPropose() } label: { Label(proposing ? "Starting" : "Propose a fix", systemImage: "wrench.and.screwdriver") }
                        .buttonStyle(.borderedProminent).disabled(proposing)
                }
                Button { onSettings() } label: { Label("Bounds and alerts", systemImage: "slider.horizontal.3") }
                    .buttonStyle(.bordered)
                Button { onExport() } label: { Label("Export 30 days", systemImage: "square.and.arrow.up") }
                    .buttonStyle(.borderless)
            }
            .controlSize(.small)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private func chart(lo: Double?, hi: Double?, state: SensorState) -> some View {
        let pts = (points ?? []).compactMap { p in p.date.map { (date: $0, value: p.value) } }
        if points == nil {
            Text("Chart loads from the hub").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 60)
        } else if pts.count < 2 {
            Text("Fewer than 2 readings in the last 24 h").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 60)
        } else {
            Chart {
                ForEach(pts, id: \.date) { p in
                    LineMark(x: .value("Time", p.date), y: .value("Value", p.value))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(state == .ok ? Color.accentColor : state.color)
                }
                if let lo { RuleMark(y: .value("Min", lo)).lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3])).foregroundStyle(.blue.opacity(0.7)) }
                if let hi { RuleMark(y: .value("Max", hi)).lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3])).foregroundStyle(.red.opacity(0.7)) }
            }
            .chartYScale(domain: .automatic(includesZero: false))
            .chartXAxis { AxisMarks(values: .stride(by: .hour, count: 6)) { _ in AxisGridLine(); AxisValueLabel(format: .dateTime.hour()) } }
            .frame(height: 120)
            .accessibilityLabel("Last 24 hours, \(pts.count) points, from \(BodyFmt.number(pts.map(\.value).min() ?? 0)) to \(BodyFmt.number(pts.map(\.value).max() ?? 0))")
        }
    }

    private func boundsText(lo: Double?, hi: Double?, unit: String) -> String {
        let alerts = sensor.bool("alert") != false
        switch (lo, hi) {
        case (nil, nil): return "Last 24 h. No bounds set, so no alerts."
        case let (l?, h?): return "Last 24 h. Bounds \(BodyFmt.number(l)) to \(BodyFmt.number(h)) \(unit). Alerts \(alerts ? "on" : "off")."
        case let (l?, nil): return "Last 24 h. Low bound \(BodyFmt.number(l)) \(unit). Alerts \(alerts ? "on" : "off")."
        case let (nil, h?): return "Last 24 h. High bound \(BodyFmt.number(h)) \(unit). Alerts \(alerts ? "on" : "off")."
        }
    }
}

// MARK: settings

struct SensorSettingsView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var sensor: Entity

    @State private var min = ""
    @State private var max = ""
    @State private var alert = true
    @State private var staleMinutes = 180
    @State private var location = ""

    private var invalid: String? {
        if !min.isEmpty && BodyFmt.parse(min) == nil { return "Min is not a number." }
        if !max.isEmpty && BodyFmt.parse(max) == nil { return "Max is not a number." }
        if let l = BodyFmt.parse(min), let h = BodyFmt.parse(max), l >= h { return "Min must be below max." }
        return nil
    }

    var body: some View {
        let unit = sensor.str("unit")
        NavigationStack {
            Form {
                SwiftUI.Section {
                    LabeledContent("Min, \(unit)") { TextField("none", text: $min).numericKeyboard().multilineTextAlignment(.trailing) }
                    LabeledContent("Max, \(unit)") { TextField("none", text: $max).numericKeyboard().multilineTextAlignment(.trailing) }
                    Toggle("Alert when outside the bounds", isOn: $alert)
                    if let e = invalid { BodyErrorRow(text: e) }
                } header: { Text("Bounds") } footer: {
                    Text("Leave a bound empty to ignore it. You get one alert when a reading crosses a bound and one when it returns.")
                }
                SwiftUI.Section {
                    Stepper("No data after \(staleMinutes) min", value: $staleMinutes, in: 5...10080, step: staleMinutes < 60 ? 5 : 30)
                    TextField("Location, for example Balcony", text: $location)
                } footer: {
                    Text("Sensor name \(sensor.str("name")), unit \(unit). The name comes from the device that posts.")
                }
            }
            .formStyle(.grouped)
            .navigationTitle(SensorCard.displayName(sensor))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(invalid != nil) }
            }
            .onAppear(perform: load)
        }
        #if os(macOS)
        .frame(minWidth: 440, minHeight: 420)
        #endif
    }

    private func load() {
        min = sensor.number("min").map(BodyFmt.number) ?? ""
        max = sensor.number("max").map(BodyFmt.number) ?? ""
        alert = sensor.bool("alert") != false
        staleMinutes = Int(sensor.number("stale_minutes") ?? 180)
        location = sensor.str("location")
    }

    private func save() {
        let loc = location.trimmingCharacters(in: .whitespaces)
        let f: [String: JSONValue] = [
            "min": BodyFmt.parse(min).map { .number($0) } ?? .null,
            "max": BodyFmt.parse(max).map { .number($0) } ?? .null,
            "alert": .bool(alert),
            "stale_minutes": .number(Double(staleMinutes)),
            "location": loc.isEmpty ? .null : .string(loc)
        ]
        Task { await engine.update(sensor.id, fields: f) }
        dismiss()
    }
}

// MARK: CSV export

struct SensorCSVFile: FileDocument {
    static var readableContentTypes: [UTType] { [.commaSeparatedText] }
    var text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws {
        text = configuration.file.regularFileContents.map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}
