#if os(iOS)
import Foundation
import HealthKit
import EACore

/// Keeps Apple Health and the app's logs in step, both ways, so nothing is typed twice.
///
/// From Health: 
/// weight, blood pressure, caffeine, workouts and mood (State of Mind) go sample by sample through anchored
/// queries: each run sends what is new since the last one, plus what was deleted in Health. Steps and sleep go as
/// one total per day, recomputed for the last two weeks every run. The first run reaches back two years (a year
/// for daily totals). The hub keys every reading by its Health id, so sending one again never makes a copy.
///
/// To Health: weight, blood pressure, caffeine, mood and timed activities logged in the app (on any device) are written
/// to Health, tagged with the log's id. A changed log is rewritten, a deleted one removed. What this app wrote is
/// skipped when reading, so nothing comes back as a copy.
@MainActor
final class HealthImporter {
    static let shared = HealthImporter()
    private let store = HKHealthStore()
    private let defaults = UserDefaults.standard
    private var running = false

    private struct Discrete {
        let id: String
        let type: HKSampleType
    }

    private var discrete: [Discrete] {
        var out: [Discrete] = []
        if let t = HKObjectType.quantityType(forIdentifier: .bodyMass) { out.append(Discrete(id: "weight", type: t)) }
        if let t = HKObjectType.correlationType(forIdentifier: .bloodPressure) { out.append(Discrete(id: "bp", type: t)) }
        if let t = HKObjectType.quantityType(forIdentifier: .dietaryCaffeine) { out.append(Discrete(id: "caffeine", type: t)) }
        out.append(Discrete(id: "workout", type: HKObjectType.workoutType()))
        out.append(Discrete(id: "mood", type: HKObjectType.stateOfMindType()))
        return out
    }

    /// What the app writes to Health: the types people log by hand here.
    private var shareTypes: Set<HKSampleType> {
        var s = Set<HKSampleType>()
        for id: HKQuantityTypeIdentifier in [.bodyMass, .bloodPressureSystolic, .bloodPressureDiastolic, .dietaryCaffeine] {
            if let t = HKObjectType.quantityType(forIdentifier: id) { s.insert(t) }
        }
        s.insert(HKObjectType.workoutType())
        s.insert(HKObjectType.stateOfMindType())
        return s
    }

    private var readTypes: Set<HKObjectType> {
        var s = Set<HKObjectType>()
        for id: HKQuantityTypeIdentifier in [.bodyMass, .bloodPressureSystolic, .bloodPressureDiastolic, .dietaryCaffeine, .stepCount] {
            if let t = HKObjectType.quantityType(forIdentifier: id) { s.insert(t) }
        }
        if let t = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) { s.insert(t) }
        s.insert(HKObjectType.workoutType())
        s.insert(HKObjectType.stateOfMindType())
        return s
    }

    func requestAndImport(into engine: SyncEngine) async -> String {
        guard HKHealthStore.isHealthDataAvailable() else { return "Health is not available on this device" }
        do { try await store.requestAuthorization(toShare: shareTypes, read: readTypes) } catch { return "Health permission: \(error.localizedDescription)" }
        return await importNow(into: engine)
    }

    /// The regular run on opening the app. It never asks (release rule 2): types iOS was not asked about yet come back
    /// empty until the person taps Send now in Connections, Apple Health, or the permission screen asks after Health
    /// is switched on.
    func importIfAuthorized(into engine: SyncEngine) async -> String {
        guard HKHealthStore.isHealthDataAvailable() else { return "Health is not available" }
        return await importNow(into: engine)
    }

    /// True when some type this version reads or writes was never asked about on this iPhone.
    func needsAsking() async -> Bool {
        guard HKHealthStore.isHealthDataAvailable() else { return false }
        return (try? await store.statusForAuthorizationRequest(toShare: shareTypes, read: readTypes)) == .shouldRequest
    }

    /// The permission screen's Health: asks, then turns the Health sync on and sends what is there. True when Health
    /// answered (it never says which types were allowed).
    func requestFromPermissionScreen(engine: SyncEngine) async -> Bool {
        guard HKHealthStore.isHealthDataAvailable() else { return false }
        do { try await store.requestAuthorization(toShare: shareTypes, read: readTypes) } catch { return false }
        resetAnchors()
        engine.config.healthImportEnabled = true
        startObserving(engine)
        _ = await importNow(into: engine)
        return true
    }

    /// Start again from nothing: the next run sends everything in reach (the hub still makes no copies).
    func resetAnchors() {
        for d in discrete { defaults.removeObject(forKey: anchorKey(d.id)) }
        defaults.removeObject(forKey: "health.dailyBackfilled")
    }

    private func anchorKey(_ id: String) -> String { "health.anchor.\(id)" }

    private func importNow(into engine: SyncEngine) async -> String {
        // Health switched off in Settings, Modules: the hub refuses /imports/health, and background wakes stop here too.
        guard engine.config.moduleOn(.health) else { return "Health is off. Turn it on in Settings, Modules." }
        guard !running else { return "Already sending" }
        guard let client = engine.client else { return "Needs the hub connection" }
        running = true
        defer { running = false }
        let config = engine.config
        var samples: [HealthSample] = []
        var removed: [String] = []
        var anchors: [String: HKQueryAnchor] = [:]
        let since = Calendar.current.date(byAdding: .year, value: -2, to: Date())!

        for d in discrete {
            let old = (defaults.data(forKey: anchorKey(d.id))).flatMap { try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0) }
            let r = await anchored(d.type, anchor: old, since: since)
            anchors[d.id] = r.anchor
            removed += r.deleted.map { $0.uuid.uuidString }
            for s in r.samples { if let h = convert(s) { samples.append(h) } }
        }

        // Daily totals: two weeks each run, a year the first time.
        let backfilled = defaults.bool(forKey: "health.dailyBackfilled")
        let days = backfilled ? 14 : 365
        samples += await dailySteps(days: days)
        samples += await nightlySleep(days: days)

        var created = 0, updated = 0, deleted = 0
        do {
            var i = 0
            repeat {
                let chunk = Array(samples[i..<min(i + 2000, samples.count)])
                let gone = i == 0 ? removed : []
                if !chunk.isEmpty || !gone.isEmpty {
                    let r = try await client.importHealth(samples: chunk, removed: gone)
                    created += r.created; updated += r.updated; deleted += r.deleted
                }
                i += 2000
            } while i < samples.count
        } catch {
            return "Could not send to the hub: \(error.localizedDescription)"
        }
        // Only now that the hub has them, remember where each type got to.
        for (id, a) in anchors {
            if let data = try? NSKeyedArchiver.archivedData(withRootObject: a, requiringSecureCoding: true) { defaults.set(data, forKey: anchorKey(id)) }
        }
        defaults.set(true, forKey: "health.dailyBackfilled")
        config.lastHealthImport = Date()
        await engine.sync()
        let wrote = await exportNow(engine)
        if created + updated + deleted + wrote == 0 { return "Up to date" }
        return [created > 0 ? "\(created) new from Health" : nil, updated > 0 ? "\(updated) changed" : nil, deleted > 0 ? "\(deleted) removed" : nil,
                wrote > 0 ? "\(wrote) written to Health" : nil].compactMap { $0 }.joined(separator: ", ")
    }

    // MARK: background delivery

    private var observing = false
    private var lastBackgroundRun = Date.distantPast

    /// Ask iOS to wake the app when Health gets new readings (weight, blood pressure, caffeine, workouts, mood, steps,
    /// sleep), so they reach the hub without opening the app. Set up at every launch while sync is on.
    func startObserving(_ engine: SyncEngine) {
        guard HKHealthStore.isHealthDataAvailable(), engine.config.healthImportEnabled, engine.config.moduleOn(.health), !observing else { return }
        observing = true
        var types: [HKSampleType] = discrete.map(\.type)
        types.append(HKQuantityType(.stepCount))
        if let sl = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) { types.append(sl) }
        for t in types {
            let q = HKObserverQuery(sampleType: t, predicate: nil) { [weak self] _, done, error in
                guard error == nil else { done(); return }
                Task { @MainActor in
                    await self?.backgroundRun(engine)
                    done()
                }
            }
            store.execute(q)
            store.enableBackgroundDelivery(for: t, frequency: .hourly) { _, _ in }
        }
    }

    /// Several types wake the app at once after a sync from the watch: one run covers them all.
    private func backgroundRun(_ engine: SyncEngine) async {
        guard Date().timeIntervalSince(lastBackgroundRun) > 60 else { return }
        lastBackgroundRun = Date()
        _ = await importNow(into: engine)
    }

    // MARK: writing to Health

    private let exportedKey = "health.exported"
    private var exporting = false

    /// Write the app's own logs to Health: new ones added, changed ones replaced, deleted ones removed. Returns how many
    /// samples were written. Runs after each read, and right after something is logged on this phone.
    @discardableResult
    func exportNow(_ engine: SyncEngine) async -> Int {
        guard HKHealthStore.isHealthDataAvailable(), engine.config.healthImportEnabled, engine.config.moduleOn(.health), !exporting else { return 0 }
        exporting = true
        defer { exporting = false }
        var done = (defaults.dictionary(forKey: exportedKey) as? [String: String]) ?? [:]
        let all = engine.list(.log)
        let byId = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var wrote = 0
        // Removed or changed in the app: take the old sample out of Health.
        for (id, sig) in done where byId[id].map({ signature($0, all) }) != sig {
            await deleteSamples(for: id)
            done[id] = nil
        }
        for e in all where e.str("note") != "Apple Health" && e.str("note") != "end" && done[e.id] == nil {
            guard let sig = signature(e, all), let samples = makeSamples(e, all) else { continue }
            do {
                try await store.save(samples)
                done[e.id] = sig
                wrote += samples.count
            } catch {
                continue  // not allowed for this type (permission off): try again next run
            }
        }
        defaults.set(done, forKey: exportedKey)
        return wrote
    }

    /// What a log looks like to Health; nil for logs Health has no type for (meds, sleep and steps come from Health).
    private func signature(_ e: Entity, _ all: [Entity]) -> String? {
        guard ["weight", "bp", "caffeine", "mood", "activity"].contains(e.str("type")) else { return nil }
        var parts = [e.str("type"), e.fields["value"].map { "\($0)" } ?? "", e.str("at")]
        if e.str("type") == "activity" {
            guard let end = activityEnd(e, all) else { return nil }  // still running: written once it ends
            parts.append(ISO.string(end))
        }
        return parts.joined(separator: "|")
    }

    private func activityEnd(_ e: Entity, _ all: [Entity]) -> Date? {
        guard let start = e.date("at") else { return nil }
        return all.filter { $0.str("type") == "activity" && $0.str("note") == "end" && $0.str("value") == e.str("value") && ($0.date("at") ?? .distantPast) >= start }
            .compactMap { $0.date("at") }.min()
    }

    private func makeSamples(_ e: Entity, _ all: [Entity]) -> [HKObject]? {
        guard let at = e.date("at") else { return nil }
        let meta: [String: Any] = [HKMetadataKeyExternalUUID: e.id, HKMetadataKeyWasUserEntered: true]
        switch e.str("type") {
        case "weight":
            guard let lb = e.number("value") else { return nil }
            let unit: HKUnit = e.str("unit") == "kg" ? .gramUnit(with: .kilo) : .pound()
            return [HKQuantitySample(type: HKQuantityType(.bodyMass), quantity: HKQuantity(unit: unit, doubleValue: lb), start: at, end: at, metadata: meta)]
        case "bp":
            let parts = e.str("value").split(separator: "/").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            guard parts.count == 2 else { return nil }
            let mm = HKUnit.millimeterOfMercury()
            let sys = HKQuantitySample(type: HKQuantityType(.bloodPressureSystolic), quantity: HKQuantity(unit: mm, doubleValue: parts[0]), start: at, end: at, metadata: meta)
            let dia = HKQuantitySample(type: HKQuantityType(.bloodPressureDiastolic), quantity: HKQuantity(unit: mm, doubleValue: parts[1]), start: at, end: at, metadata: meta)
            return [HKCorrelation(type: HKCorrelationType(.bloodPressure), start: at, end: at, objects: [sys, dia], metadata: meta)]
        case "caffeine":
            // The app counts cups; Health keeps milligrams (about 95 mg a cup). A log already in mg goes as it is.
            let v = e.number("value") ?? 1
            let mg = e.str("unit").lowercased() == "mg" ? v : v * 95
            return [HKQuantitySample(type: HKQuantityType(.dietaryCaffeine), quantity: HKQuantity(unit: .gramUnit(with: .milli), doubleValue: mg), start: at, end: at, metadata: meta)]
        case "mood":
            guard let m = e.number("value") else { return nil }
            return [HKStateOfMind(date: at, kind: .momentaryEmotion, valence: max(-1, min(1, m / 2)), labels: [], associations: [], metadata: meta)]
        case "activity":
            guard let end = activityEnd(e, all), end > at else { return nil }
            return [HKWorkout(activityType: Self.activityType(e.str("value")), start: at, end: end, workoutEvents: nil, totalEnergyBurned: nil, totalDistance: nil, metadata: meta)]
        default:
            return nil
        }
    }

    /// A timed activity's name as a Health workout type (anything unknown is "Other").
    static func activityType(_ name: String) -> HKWorkoutActivityType {
        let n = name.lowercased()
        if n.contains("walk") { return .walking }
        if n.contains("run") || n.contains("jog") { return .running }
        if n.contains("cycl") || n.contains("bike") { return .cycling }
        if n.contains("hike") { return .hiking }
        if n.contains("swim") { return .swimming }
        if n.contains("yoga") { return .yoga }
        if n.contains("lift") || n.contains("strength") || n.contains("gym") || n.contains("weights") { return .traditionalStrengthTraining }
        if n.contains("climb") { return .climbing }
        if n.contains("dance") { return .dance }
        return .other
    }

    private func deleteSamples(for id: String) async {
        let pred = HKQuery.predicateForObjects(withMetadataKey: HKMetadataKeyExternalUUID, allowedValues: [id])
        let types: [HKObjectType] = [HKQuantityType(.bodyMass), HKCorrelationType(.bloodPressure), HKQuantityType(.bloodPressureSystolic),
                                     HKQuantityType(.bloodPressureDiastolic), HKQuantityType(.dietaryCaffeine), HKObjectType.workoutType(), HKObjectType.stateOfMindType()]
        for t in types { _ = try? await store.deleteObjects(of: t, predicate: pred) }
    }

    // MARK: conversions

    private func convert(_ s: HKSample) -> HealthSample? {
        // Written by this app from a log: that log already exists.
        if s.sourceRevision.source.bundleIdentifier == Bundle.main.bundleIdentifier { return nil }
        let key = s.uuid.uuidString
        if let q = s as? HKQuantitySample {
            if q.quantityType == HKQuantityType(.bodyMass) {
                let lb = (q.quantity.doubleValue(for: .pound()) * 10).rounded() / 10
                return HealthSample(key: key, type: .weight, value: .number(lb), unit: "lb", at: q.startDate)
            }
            if q.quantityType == HKQuantityType(.dietaryCaffeine) {
                // The app counts caffeine in cups; Health keeps milligrams. About 95 mg to a cup of coffee.
                let mg = q.quantity.doubleValue(for: .gramUnit(with: .milli))
                return HealthSample(key: key, type: .caffeine, value: .number((mg / 95 * 10).rounded() / 10), unit: "cup", at: q.startDate)
            }
        }
        if let c = s as? HKCorrelation, c.correlationType == HKCorrelationType(.bloodPressure) {
            let sys = c.objects(for: HKQuantityType(.bloodPressureSystolic)).first as? HKQuantitySample
            let dia = c.objects(for: HKQuantityType(.bloodPressureDiastolic)).first as? HKQuantitySample
            guard let sys, let dia else { return nil }
            let mm = HKUnit.millimeterOfMercury()
            let v = "\(Int(sys.quantity.doubleValue(for: mm).rounded()))/\(Int(dia.quantity.doubleValue(for: mm).rounded()))"
            return HealthSample(key: key, type: .bp, value: .string(v), unit: "mmHg", at: c.startDate)
        }
        if let w = s as? HKWorkout {
            var h = HealthSample(key: key, type: .activity, value: .string(Self.workoutName(w.workoutActivityType)), unit: nil, at: w.startDate)
            h.end = ISO.string(w.endDate)
            return h
        }
        if let m = s as? HKStateOfMind {
            // Valence runs from -1 to 1; the app's mood scale is -2 to 2.
            return HealthSample(key: key, type: .mood, value: .number((m.valence * 2).rounded()), unit: nil, at: m.startDate)
        }
        return nil
    }

    static func workoutName(_ t: HKWorkoutActivityType) -> String {
        switch t {
        case .walking: return "Walking"
        case .running: return "Running"
        case .cycling: return "Cycling"
        case .hiking: return "Hiking"
        case .swimming: return "Swimming"
        case .traditionalStrengthTraining, .functionalStrengthTraining: return "Strength training"
        case .yoga: return "Yoga"
        case .highIntensityIntervalTraining: return "HIIT"
        case .elliptical: return "Elliptical"
        case .rowing: return "Rowing"
        case .dance: return "Dance"
        case .coreTraining: return "Core training"
        case .mindAndBody: return "Mind and body"
        case .cooldown: return "Cooldown"
        case .stairClimbing, .stairs: return "Stairs"
        case .pilates: return "Pilates"
        default: return "Workout"
        }
    }

    // MARK: queries

    private func anchored(_ type: HKSampleType, anchor: HKQueryAnchor?, since: Date) async -> (samples: [HKSample], deleted: [HKDeletedObject], anchor: HKQueryAnchor?) {
        await withCheckedContinuation { c in
            let pred = HKQuery.predicateForSamples(withStart: since, end: nil, options: [])
            let q = HKAnchoredObjectQuery(type: type, predicate: pred, anchor: anchor, limit: HKObjectQueryNoLimit) { _, added, deleted, newAnchor, _ in
                c.resume(returning: (added ?? [], deleted ?? [], newAnchor ?? anchor))
            }
            store.execute(q)
        }
    }

    private func dailySteps(days: Int) async -> [HealthSample] {
        let cal = Calendar.current
        let start = cal.date(byAdding: .day, value: -(days - 1), to: cal.startOfDay(for: Date()))!
        let stats: HKStatisticsCollection? = await withCheckedContinuation { c in
            let q = HKStatisticsCollectionQuery(quantityType: HKQuantityType(.stepCount), quantitySamplePredicate: HKQuery.predicateForSamples(withStart: start, end: nil),
                                                options: .cumulativeSum, anchorDate: start, intervalComponents: DateComponents(day: 1))
            q.initialResultsHandler = { _, result, _ in c.resume(returning: result) }
            store.execute(q)
        }
        guard let stats else { return [] }
        var out: [HealthSample] = []
        stats.enumerateStatistics(from: start, to: Date()) { s, _ in
            guard let sum = s.sumQuantity() else { return }
            let n = sum.doubleValue(for: .count()).rounded()
            guard n > 0 else { return }
            out.append(HealthSample(key: "steps:\(Self.day(s.startDate))", type: .steps, value: .number(n), unit: "steps", at: s.startDate))
        }
        return out
    }

    /// Minutes asleep per night, the night named by the day it ended (sleep that ends before 6 pm counts for that day).
    private func nightlySleep(days: Int) async -> [HealthSample] {
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { return [] }
        let cal = Calendar.current
        let start = cal.date(byAdding: .day, value: -days, to: cal.startOfDay(for: Date()))!
        let samples: [HKSample] = await withCheckedContinuation { c in
            let q = HKSampleQuery(sampleType: type, predicate: HKQuery.predicateForSamples(withStart: start, end: nil), limit: HKObjectQueryNoLimit,
                                  sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]) { _, s, _ in c.resume(returning: s ?? []) }
            store.execute(q)
        }
        let asleep: Set<Int> = [HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue, HKCategoryValueSleepAnalysis.asleepCore.rawValue,
                                HKCategoryValueSleepAnalysis.asleepDeep.rawValue, HKCategoryValueSleepAnalysis.asleepREM.rawValue]
        // Several sources (watch, phone, a sleep app) can record the same night: per night, keep the source with the most sleep.
        var byNight: [String: [String: (minutes: Double, first: Date)]] = [:]
        for s in samples.compactMap({ $0 as? HKCategorySample }) where asleep.contains(s.value) {
            let night = Self.day(cal.date(byAdding: .hour, value: 6, to: s.endDate)!)
            let src = s.sourceRevision.source.bundleIdentifier
            var cur = byNight[night, default: [:]][src] ?? (0, s.startDate)
            cur.minutes += s.endDate.timeIntervalSince(s.startDate) / 60
            cur.first = min(cur.first, s.startDate)
            byNight[night, default: [:]][src] = cur
        }
        return byNight.compactMap { night, sources in
            guard let best = sources.values.max(by: { $0.minutes < $1.minutes }), best.minutes >= 30 else { return nil }
            return HealthSample(key: "sleep:\(night)", type: .sleep, value: .number(best.minutes.rounded()), unit: "min", at: best.first)
        }
    }

    private static func day(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}
#endif
