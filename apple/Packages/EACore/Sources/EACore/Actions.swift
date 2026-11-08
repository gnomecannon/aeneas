import Foundation

/// Domain actions shared by every Apple target: Now, capture, logs, activity, reminders.
extension SyncEngine {

    // MARK: Now

    public var tasks: [Entity] { list(.task) }

    /// The single current task: status doing, else the lowest order next task.
    public var nowTask: Entity? {
        let t = tasks
        if let doing = t.filter({ $0.str("status") == "doing" }).sorted(by: { ($0.number("order") ?? 0) < ($1.number("order") ?? 0) }).first { return doing }
        return t.filter { $0.str("status") == "next" }.sorted { ($0.number("order") ?? 0) < ($1.number("order") ?? 0) }.first
    }

    public var upNext: [Entity] {
        let nowId = nowTask?.id
        return tasks.filter { $0.str("status") == "next" && $0.id != nowId }.sorted(by: Self.byOrder)
    }

    /// Tasks with one status, by order; Scheduled (where reminders wait) by when they notify.
    public func tasks(status: TaskStatus) -> [Entity] {
        let items = tasks.filter { $0.str("status") == status.rawValue }
        if status == .scheduled {
            return items.sorted { a, b in
                let x = a.alertDate ?? .distantFuture, y = b.alertDate ?? .distantFuture
                return x != y ? x < y : Self.byOrder(a, b)
            }
        }
        return items.sorted(by: Self.byOrder)
    }

    /// By order, then creation, then id: the cache is a dictionary, so without the tie-breaks equal orders
    /// (tasks imported in one batch) would swap places on every refresh.
    nonisolated static func byOrder(_ a: Entity, _ b: Entity) -> Bool {
        let x = a.number("order") ?? 0, y = b.number("order") ?? 0
        if x != y { return x < y }
        if a.created_at != b.created_at { return a.created_at < b.created_at }
        return a.id < b.id
    }

    private var maxOrder: Double { tasks.map { $0.number("order") ?? 0 }.max() ?? 0 }
    private var minOrder: Double { tasks.map { $0.number("order") ?? 0 }.min() ?? 0 }

    /// Done. A repeating task moves its reminder and deadline on and stays open.
    public func markDone(_ id: String) async {
        guard let e = entities[id] else { return }
        _ = await update(id, fields: ReminderMath.completeTask(e))
    }

    /// Skip: send the task to the end of next so the following one becomes Now.
    public func skip(_ id: String) async {
        _ = await update(id, fields: ["status": "next", "order": .number(maxOrder + 1), "block": .null])
    }

    public func park(_ id: String, reason: String) async {
        _ = await update(id, fields: ["status": "parked", "parked_reason": .string(reason), "block": .null])
    }

    /// Start a block of `hours` (default 3) and make this the Now task.
    public func startBlock(_ id: String, hours: Double = 3) async {
        let start = Date()
        let end = start.addingTimeInterval(hours * 3600)
        // Only one task is doing at a time.
        for t in tasks where t.str("status") == "doing" && t.id != id {
            _ = await update(t.id, fields: ["status": "next"])
        }
        _ = await update(id, fields: ["status": "doing", "block": .object(["start": .string(ISO.string(start)), "end": .string(ISO.string(end))])])
    }

    public func makeNow(_ id: String) async {
        for t in tasks where t.str("status") == "doing" && t.id != id {
            _ = await update(t.id, fields: ["status": "next"])
        }
        _ = await update(id, fields: ["status": "doing"])
    }

    public func moveToNext(_ id: String) async {
        _ = await update(id, fields: ["status": "next", "order": .number(maxOrder + 1)])
    }

    @discardableResult
    public func createTask(title: String, notes: String? = nil, status: TaskStatus = .inbox, due: String? = nil, space: Space = .personal) async -> Entity? {
        var f: [String: JSONValue] = ["title": .string(title), "status": .string(status.rawValue), "order": .number(maxOrder + 1)]
        if let n = notes, !n.isEmpty { f["notes"] = .string(n) }
        if let d = due, !d.isEmpty { f["due"] = .string(d) }
        return await create(kind: .task, space: space, fields: f)
    }

    /// Moves a task to another section, as a drag on the task list does. Next takes the given place in its order
    /// (the end when nil); Done goes through markDone so a repeat moves on. Parked needs a reason and Scheduled
    /// needs a time, so neither is a move: returns false and changes nothing.
    @discardableResult
    public func moveTask(_ id: String, to status: TaskStatus, nextOrder ids: [String]? = nil) async -> Bool {
        guard let t = entities[id] else { return false }
        switch status {
        case .done: await markDone(id)
        case .doing: await makeNow(id)
        case .inbox: _ = await update(id, fields: ["status": "inbox", "block": .null])
        case .next:
            if t.str("status") != "next" { _ = await update(id, fields: ["status": "next", "order": .number(maxOrder + 1), "block": .null]) }
            if let ids { await reorderNext(ids: ids) }
        case .parked: return false
        case .scheduled:
            guard t.alertDate != nil || !t.str("due").isEmpty else { return false }
            _ = await update(id, fields: ["status": "scheduled", "block": .null])
        }
        return true
    }

    /// Reorder within `next`: assign increasing order values in the given id sequence.
    public func reorderNext(ids: [String]) async {
        var order = minOrder
        for id in ids {
            order += 1
            if let t = entities[id], (t.number("order") ?? 0) != order {
                _ = await update(id, fields: ["order": .number(order)])
            }
        }
    }

    // MARK: Capture

    public var unprocessedCaptures: [Entity] {
        list(.capture).filter { !($0.bool("processed") ?? false) }.sorted { $0.created_at > $1.created_at }
    }

    public var captureSource: Source {
        switch platform {
        case .watch: return .watch
        case .iphone: return .iphone
        case .ipad: return .ipad
        case .mac: return .mac
        case .windows: return .windows
        case .web: return .web
        }
    }

    /// Capture text, always sorted: online `POST /capture` with `auto`, so it goes into the day's diary and the assistant
    /// files it. Offline: a local capture with `sort: true`, pushed later through the outbox; the hub sorts it on arrival,
    /// so nothing saved away from the hub waits in Unsorted Info.
    @discardableResult
    public func capture(_ text: String, attachments: [Attachment]? = nil, source: Source? = nil, transcriptConfidence: Double? = nil) async -> Entity? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let src = source ?? captureSource
        let id = UUID().uuidString.lowercased()
        if let c = client, status != .unconfigured {
            do {
                let resp = try await c.capture(CaptureRequest(text: trimmed, source: src, attachments: attachments, auto: true, id: id))
                await absorb(resp.capture)
                for e in resp.created ?? [] { await absorb(e) }
                moment(.create, kind: resp.created?.first?.kind ?? .capture)
                status = .online
                Task { await self.sync() }
                updateSnapshot()
                return resp.capture
            } catch {
                if let h = error as? HubError, h.isAuth { lastError = "Token rejected by hub" }
                // The reply can be lost after the hub saved and sorted it (through the Watch relay above all): if it
                // has the capture, that is the one, and no second copy goes out to be sorted again.
                // Asked only when the request may have arrived (through the relay, or a reply that timed out), so a
                // capture saved with no hub in reach is not held up by a second wait.
                let mayHaveArrived = platform == .watch || "\(error)".localizedCaseInsensitiveContains("timed out")
                if mayHaveArrived, let had = try? await c.entity(id), had.kind == .capture {
                    await absorb(had)
                    updateSnapshot()
                    return had
                }
                status = .offline
            }
        }
        var fields: [String: JSONValue] = [
            "text": .string(trimmed),
            "source": .string(src.rawValue),
            "processed": false,
            "sort": true,
            "suggested_kind": .string(Classifier.classify(trimmed).kind.rawValue)
        ]
        if let a = attachments, !a.isEmpty, let v = try? JSONCoding.value(a) { fields["attachments"] = v }
        if let tc = transcriptConfidence { fields["transcript_confidence"] = .number(tc) }
        return await create(kind: .capture, fields: fields, id: id)
    }

    /// Convert a capture into another kind. Online uses `/capture/:id/convert`; offline creates
    /// the entity locally and marks the capture processed.
    @discardableResult
    public func convertCapture(_ id: String, to kind: Kind, fields: [String: JSONValue]? = nil) async -> Entity? {
        guard let cap = entities[id] else { return nil }
        if let c = client, status == .online {
            do {
                let created = try await c.convertCapture(id, to: kind, fields: fields)
                await absorb(created)
                moment(.create, kind: created.kind)
                Task { await self.sync() }
                return created
            } catch {
                // Any error used to fall back to a local create, so a reply lost after the hub converted it made a
                // second copy. When the request may have arrived (a reply that timed out, or the Watch relay), the
                // hub is asked first, as capture() does: a new id in its converted_to is the one it made.
                let mayHaveArrived = platform == .watch || "\(error)".localizedCaseInsensitiveContains("timed out")
                if mayHaveArrived {
                    guard let had = try? await c.entity(id), had.kind == .capture else {
                        // No answer either: it may have been converted, so no copy is made here. The capture stays as
                        // it is and the next sync shows what the hub did.
                        return nil
                    }
                    let before = Set(cap.stringArray("converted_to"))
                    if let newId = had.stringArray("converted_to").first(where: { !before.contains($0) }) {
                        await absorb(had)
                        if let made = try? await c.entity(newId) { await absorb(made); return made }
                        return nil
                    }
                }
            }
        }
        var f = fields ?? [:]
        let text = cap.str("text")
        let suggestion = Classifier.classify(text)
        if suggestion.kind.rawValue == kind.rawValue { for (k, v) in suggestion.fields where f[k] == nil { f[k] = v } }
        switch kind {
        case .task:
            if f["title"] == nil { f["title"] = .string(text) }
            if f["status"] == nil { f["status"] = "inbox" }
            if f["order"] == nil { f["order"] = .number(maxOrder + 1) }
        case .note:
            if f["title"] == nil { f["title"] = .string(String(String(text.split(separator: "\n").first ?? "").prefix(80))) }
            if f["body"] == nil { f["body"] = .string(text) }
            if f["path"] == nil { f["path"] = .string("Inbox/\(Self.safeFileName(f["title"]?.stringValue ?? "Note")).md") }
        case .reminder:
            // A reminder is a task with a reminder time.
            if f["title"] == nil { f["title"] = .string(text) }
            if f["remind_at"] == nil { f["remind_at"] = f["at"] ?? .string(ISO.string(Date().addingTimeInterval(3600))) }
            f["at"] = nil
            if f["friction"] == nil { f["friction"] = "none" }
            if f["status"] == nil { f["status"] = "scheduled" }
            if f["order"] == nil { f["order"] = .number(maxOrder + 1) }
        case .log:
            if f["type"] == nil { f["type"] = "custom" }
            if f["value"] == nil { f["value"] = .string(text) }
            if f["at"] == nil { f["at"] = .string(ISO.now()) }
        case .fact:
            if f["category"] == nil { f["category"] = "preference" }
            if f["key"] == nil { f["key"] = .string(String(text.lowercased().prefix(40))) }
            if f["value"] == nil { f["value"] = .string(text) }
        default: break
        }
        guard let created = await create(kind: kind == .reminder ? .task : kind, fields: f) else { return nil }
        var converted = cap.stringArray("converted_to")
        converted.append(created.id)
        _ = await update(id, fields: ["processed": true, "converted_to": .array(converted.map { .string($0) })])
        return created
    }

    public static func safeFileName(_ s: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|#^[]")
        let cleaned = s.components(separatedBy: bad).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        return cleaned.isEmpty ? "Note" : cleaned
    }

    public func discardCapture(_ id: String) async {
        _ = await update(id, fields: ["processed": true])
    }

    // MARK: Logs

    public var logs: [Entity] { list(.log) }

    public func logs(type: LogType, days: Int? = nil) -> [Entity] {
        var out = logs.filter { $0.str("type") == type.rawValue }
        if let d = days {
            let cutoff = Date().addingTimeInterval(-Double(d) * 86400)
            out = out.filter { ($0.date("at") ?? .distantPast) >= cutoff }
        }
        return out.sorted { ($0.date("at") ?? .distantPast) < ($1.date("at") ?? .distantPast) }
    }

    @discardableResult
    public func log(type: LogType, value: JSONValue, unit: String? = nil, note: String? = nil, at: Date = Date(), source: Source? = nil) async -> Entity? {
        var f: [String: JSONValue] = ["type": .string(type.rawValue), "value": value, "at": .string(ISO.string(at)), "source": .string((source ?? captureSource).rawValue)]
        if let u = unit { f["unit"] = .string(u) }
        if let n = note, !n.isEmpty { f["note"] = .string(n) }
        let created = await create(kind: .log, fields: f)
        if type == .activity, schedulesNotifications, let e = created {
            #if canImport(UserNotifications)
            // Activity check-in with no hub: ask three hours after a start, cancel on end.
            if note == "end" {
                await ReminderScheduler.shared.cancelActivityCheckins()
            } else {
                await ReminderScheduler.shared.cancelActivityCheckins()
                await ReminderScheduler.shared.scheduleActivityCheckin(logId: e.id, name: value.displayString, start: at)
            }
            #endif
        }
        return created
    }

    /// Distinct recent values for a log type (med names, activity names), most recent first.
    public func recentValues(type: LogType, limit: Int = 12) -> [String] {
        var seen: [String] = []
        for e in logs(type: type).reversed() {
            let v = e.fields["value"]?.displayString ?? ""
            if !v.isEmpty, !seen.contains(v) { seen.append(v) }
            if seen.count >= limit { break }
        }
        return seen
    }

    // MARK: Activity (one-tap tracker)

    public struct CurrentActivity: Equatable, Sendable { public var name: String; public var start: Date; public var logId: String }

    /// Every activity still open, newest first, as the hub's activitySpans reads them (hub/src/health.ts): a start
    /// opens one for its name, the next "end" log with that name closes it, another start while it is open is the
    /// same session, and an end with nothing open is ignored. Only the last activity log used to be looked at, so a
    /// workout from Apple Health logged after an open activity hid it: no End button, and its chip started it again.
    public var openActivities: [CurrentActivity] {
        let acts = list(.log).compactMap { e -> (e: Entity, at: Date)? in
            guard e.str("type") == LogType.activity.rawValue, let at = e.date("at") else { return nil }
            return (e, at)
        }
        // At the same moment a start comes first, so an end at the start's own time still closes it; then the id,
        // so two logs in one millisecond always read the same way.
        let sorted = acts.sorted { a, b in
            if a.at != b.at { return a.at < b.at }
            let ae = Self.isActivityEnd(a.e), be = Self.isActivityEnd(b.e)
            if ae != be { return !ae }
            return a.e.id < b.e.id
        }
        var open: [String: CurrentActivity] = [:]
        var order: [String] = []
        for (e, at) in sorted {
            let name = e.fields["value"]?.displayString ?? ""
            if Self.isActivityEnd(e) {
                if open.removeValue(forKey: name) != nil { order.removeAll { $0 == name } }
                continue
            }
            if open[name] != nil { continue }
            open[name] = CurrentActivity(name: name, start: at, logId: e.id)
            order.append(name)
        }
        return order.reversed().compactMap { open[$0] }
    }

    static func isActivityEnd(_ e: Entity) -> Bool { e.str("note").trimmingCharacters(in: .whitespaces).lowercased() == "end" }

    /// The newest activity still open.
    public var currentActivity: CurrentActivity? { openActivities.first }

    /// Tap an activity: starts it, or ends it when it is open.
    public func toggleActivity(_ name: String) async {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty else { return }
        // Open but not the newest (a workout came in after it): end that one rather than start it a second time.
        if let open = openActivities.first(where: { $0.name.caseInsensitiveCompare(n) == .orderedSame }), open != currentActivity {
            _ = await log(type: .activity, value: .string(open.name), unit: "min", note: "end")
            return
        }
        if let cur = currentActivity {
            let minutes = Int(Date().timeIntervalSince(cur.start) / 60)
            _ = await log(type: .activity, value: .string(cur.name), unit: "min", note: "end")
            _ = minutes
            if cur.name.caseInsensitiveCompare(n) == .orderedSame { return }
        }
        _ = await log(type: .activity, value: .string(n))
    }

    public func startActivity(_ name: String) async {
        if let cur = currentActivity, cur.name.caseInsensitiveCompare(name) == .orderedSame { return }
        await toggleActivity(name)
    }

    public func endActivity() async {
        guard let cur = currentActivity else { return }
        _ = await log(type: .activity, value: .string(cur.name), unit: "min", note: "end")
    }

    // MARK: Reminders

    /// Open tasks with a reminder time, soonest first.
    public var reminders: [Entity] {
        list(.task).filter { $0.reminderFields != nil }.sorted { ($0.alertDate ?? .distantFuture) < ($1.alertDate ?? .distantFuture) }
    }

    public var remindersToday: [Entity] {
        let cal = Calendar.current
        return reminders.filter { $0.alertDate.map { cal.isDateInToday($0) } ?? false }
    }

    /// A task that notifies at `at`. It waits in Scheduled rather than joining Next.
    @discardableResult
    public func createReminder(title: String, at: Date, due: Date? = nil, repeat rep: String? = nil, friction: Friction = .none, space: Space = .personal) async -> Entity? {
        var f: [String: JSONValue] = ["title": .string(title), "status": "scheduled", "order": .number(maxOrder + 1), "remind_at": .string(ISO.string(at)), "friction": .string(friction.rawValue)]
        if let due { f["due"] = .string(ISO.string(due)) }
        if let rep, !rep.isEmpty { f["repeat"] = .string(rep) }
        return await create(kind: .task, space: space, fields: f)
    }

    /// Snooze: hub route when online, local patch otherwise. Reason is required when friction is reason.
    public func snooze(_ id: String, minutes: Int = 10, reason: String?) async -> Bool {
        guard let e = entities[id], let r = e.reminderFields else { return false }
        let needsReason = r.friction != .none
        let reasonText = reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if needsReason && reasonText.isEmpty { return false }
        let until = ISO.string(Date().addingTimeInterval(Double(minutes) * 60))
        if let c = client, status == .online, (try? await c.snooze(id, until: until, reason: reasonText.isEmpty ? nil : reasonText)) != nil {
            Task { await self.sync() }
            return true
        }
        var log = r.snooze_log ?? []
        log.append(SnoozeEntry(at: ISO.now(), until: until, reason: reasonText))
        _ = await update(id, fields: ["snoozed_until": .string(until), "snooze_log": (try? JSONCoding.value(log)) ?? .array([])])
        return true
    }

    /// Done from a reminder: hub route when online; locally the same rule (a repeating task moves on, others are done).
    public func ack(_ id: String) async {
        guard let e = entities[id] else { return }
        if let c = client, status == .online, (try? await c.ack(id)) != nil {
            moment(.complete, kind: .task)
            Task { await self.sync() }
            return
        }
        moment(.complete, kind: .task)
        _ = await update(id, fields: ReminderMath.completeTask(e))
    }

    // MARK: Notes, memory, projects

    public var notes: [Entity] { list(.note).sorted { $0.str("title").localizedCaseInsensitiveCompare($1.str("title")) == .orderedAscending } }
    public var facts: [Entity] { list(.fact) }
    public var rules: [Entity] { list(.rule) }
    public var ledgers: [Entity] { list(.ledger) }
    public var projects: [Entity] { list(.project) }

    /// Style patterns from active filter rules, for display.
    public var stylePatterns: [StyleGuard.Pattern] { StyleGuard.patterns(fromRules: rules) }
    public func styled(_ text: String) -> String { StyleGuard.apply(text, extra: stylePatterns).text }
}
