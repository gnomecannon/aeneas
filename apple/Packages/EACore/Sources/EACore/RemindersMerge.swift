import Foundation

/// One Apple Reminders item as the sync sees it. Dates are ISO strings rounded to the minute; a date-only due is
/// local midnight. `repeatRule` uses the app's repeat grammar and is nil when Apple's rule has no equivalent.
public struct ReminderItem: Equatable, Sendable {
    /// The calendar server's id, the same on every device. The key the iPhone and the Mac agree on.
    public var externalId: String
    /// This device's id for it (EKCalendarItem.calendarItemIdentifier).
    public var localId: String
    public var listId: String
    public var listTitle: String
    public var isWork: Bool
    public var title: String
    public var notes: String?
    public var due: String?
    public var remindAt: String?
    public var repeatRule: String?
    public var done: Bool
    public var doneAt: String?
    public var modified: Date?

    public init(externalId: String, localId: String, listId: String, listTitle: String, isWork: Bool = false, title: String, notes: String? = nil,
                due: String? = nil, remindAt: String? = nil, repeatRule: String? = nil, done: Bool = false, doneAt: String? = nil, modified: Date? = nil) {
        self.externalId = externalId; self.localId = localId; self.listId = listId; self.listTitle = listTitle; self.isWork = isWork
        self.title = title; self.notes = notes; self.due = due; self.remindAt = remindAt; self.repeatRule = repeatRule
        self.done = done; self.doneAt = doneAt; self.modified = modified
    }
}

/// What both sides agreed on at the last sync, per item, kept on this device.
public struct SyncedReminder: Codable, Equatable, Sendable {
    public var taskId: String
    public var localId: String
    public var fields: [String: String]
    public init(taskId: String, localId: String, fields: [String: String]) { self.taskId = taskId; self.localId = localId; self.fields = fields }
}

/// The changes one sync makes: task patches for the hub, and writes to Apple Reminders.
public struct RemindersPlan: Equatable, Sendable {
    public struct AppleWrite: Equatable, Sendable {
        public var localId: String
        /// Field name to new value; "" clears it.
        public var fields: [String: String]
    }
    public struct AppleCreate: Equatable, Sendable {
        public var taskId: String
        public var fields: [String: String]
        /// The list it was made in, by name; nil means the default list.
        public var listTitle: String? = nil
        public var isWork = false
    }
    public struct AppleMove: Equatable, Sendable {
        public var localId: String
        public var listTitle: String
    }
    public var taskPatches: [Patch] = []
    public var appleWrites: [AppleWrite] = []
    public var appleCreates: [AppleCreate] = []
    public var appleDeletes: [String] = []
    public var appleMoves: [AppleMove] = []
    public var state: [String: SyncedReminder] = [:]
}

/// Two-way merge between tasks and Apple Reminders, field by field against what both sides last agreed on:
/// a field changed on one side only goes to the other; changed on both, the newer side wins. A side with no
/// record yet takes the newer value too. Pure, so it is tested without EventKit.
public enum RemindersMerge {
    public static let fieldNames = ["title", "notes", "due", "remind_at", "repeat", "done"]
    /// Finished Apple items older than this are not brought in.
    public static let importDoneWithin: TimeInterval = 14 * 86400

    public static func taskId(forExternal id: String) -> String { StableID.uuid("apple-reminder:\(id)") }

    /// A minute-rounded ISO string, so EventKit's seconds and the hub's milliseconds compare equal.
    public static func minute(_ s: String?) -> String {
        guard let s, let d = ISO.date(s) else { return "" }
        return ISO.string(Date(timeIntervalSince1970: (d.timeIntervalSince1970 / 60).rounded(.down) * 60))
    }

    /// A repeat Apple Reminders can hold too (days and longer); minutes and hours stay app-only.
    public static func appleRepeat(_ r: String?) -> String {
        guard let r, let rule = RepeatRule.parse(r), ![.minutes, .hours].contains(rule.unit) else { return "" }
        return rule.description
    }

    public static func fields(of item: ReminderItem) -> [String: String] {
        ["title": item.title, "notes": item.notes ?? "", "due": minute(item.due), "remind_at": minute(item.remindAt),
         "repeat": appleRepeat(item.repeatRule), "done": item.done ? "1" : "0"]
    }

    public static func fields(of task: Entity) -> [String: String] {
        ["title": task.str("title"), "notes": task.str("notes"), "due": minute(task.str("due")), "remind_at": minute(task.str("remind_at")),
         "repeat": appleRepeat(task.fields["repeat"]?.stringValue), "done": task.str("status") == "done" ? "1" : "0"]
    }

    /// Task fields for values that came from Apple.
    static func taskFields(_ changed: [String: String], item: ReminderItem, task: Entity?, now: Date) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for (k, v) in changed {
            switch k {
            case "title": out["title"] = .string(v.isEmpty ? "Untitled" : v)
            case "notes", "due", "remind_at", "repeat": out[k] = v.isEmpty ? .null : .string(v)
            case "done":
                if v == "1" {
                    out["status"] = "done"
                    out["done_at"] = .string(item.doneAt ?? ISO.string(now))
                } else {
                    let timed = !(changed["due"] ?? fields(of: item)["due"] ?? "").isEmpty || !(changed["remind_at"] ?? fields(of: item)["remind_at"] ?? "").isEmpty
                    out["status"] = .string(timed ? "scheduled" : "inbox")
                    out["done_at"] = .null
                }
            default: break
            }
        }
        if out["remind_at"] != nil { out["snoozed_until"] = .null }
        return out
    }

    /// - Parameters:
    ///   - items: every item in the lists this device can see.
    ///   - tasks: every task on this device, deleted ones included.
    ///   - state: what was agreed at the last sync, by external id.
    ///   - presentLists: list ids on this device; an item missing from one of them was deleted in Apple Reminders.
    ///   - createsInApple: whether this device adds Apple items for tasks made in the app (only one device does, so
    ///     the iPhone and Mac never both add the same one).
    ///   - workOff: the work space is off, so work lists are left alone.
    public static func plan(items: [ReminderItem], tasks: [Entity], state: [String: SyncedReminder], presentLists: Set<String>,
                            createsInApple: Bool, workOff: Bool, now: Date = Date()) -> RemindersPlan {
        var out = RemindersPlan()
        var byLink: [String: Entity] = [:]
        var byId: [String: Entity] = [:]
        for t in tasks where t.kind == .task {
            byId[t.id] = t
            if let link = t.fields["apple"]?.objectValue?["id"]?.stringValue, !link.isEmpty { byLink[link] = t }
        }
        let byLocal = Dictionary(state.map { ($0.value.localId, $0.key) }, uniquingKeysWith: { a, _ in a })
        var seen = Set<String>()
        let ts = ISO.string(now)

        for item in items {
            if item.isWork && workOff { continue }
            // An item whose server id changed after its first save keeps its record by this device's id.
            let key = state[item.externalId] != nil ? item.externalId : (byLocal[item.localId] ?? item.externalId)
            seen.insert(key)
            let prior = state[key]
            var task = byLink[item.externalId] ?? byLink[key] ?? prior.flatMap { byId[$0.taskId] } ?? byId[taskId(forExternal: item.externalId)]
            if task == nil, prior == nil {
                // A task made in the app whose Apple item came here before its link did (the other device made the
                // item, and iCloud was quicker than the hub), or whose link was lost when the app stopped: the same
                // title, open, not linked yet and made in the last day. Without this match it became a second task.
                let title = item.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let space: Space = item.isWork ? .work : .personal
                task = tasks.first { t in
                    t.kind == .task && !t.isDeleted && t.fields["apple"] == nil && t.space == space && t.str("status") != "done"
                        && t.str("title").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == title && !title.isEmpty
                        && (ISO.date(t.created_at).map { now.timeIntervalSince($0) < 86400 } ?? false)
                }
            }
            let a = fields(of: item)
            let link: JSONValue = .object(["id": .string(item.externalId), "list": .string(item.listId), "list_title": .string(item.listTitle)])

            guard let t = task else {
                // New in Apple Reminders: bring it in, unless it was finished long ago.
                if item.done, let d = ISO.date(item.doneAt), now.timeIntervalSince(d) > importDoneWithin { continue }
                if prior != nil { continue } // its task is gone from this device; nothing to match
                let id = taskId(forExternal: item.externalId)
                var f = taskFields(a.filter { !$0.value.isEmpty }, item: item, task: nil, now: now)
                f["title"] = .string(item.title.isEmpty ? "Untitled" : item.title)
                if f["status"] == nil { f["status"] = .string(a["due"]!.isEmpty && a["remind_at"]!.isEmpty ? "inbox" : "scheduled") }
                f["order"] = .number((now.timeIntervalSince1970 * 1000).rounded())
                f["friction"] = "none"
                f["apple"] = link
                out.taskPatches.append(Patch(id: id, kind: .task, space: item.isWork ? .work : .personal, ts: ts, fields: f, create: true))
                out.state[item.externalId] = SyncedReminder(taskId: id, localId: item.localId, fields: a)
                continue
            }

            if t.isDeleted {
                // Deleted in the app: delete it in Apple Reminders too, except work items (turning the work space
                // off erases them from the app, never from the work account).
                if prior != nil, t.space != .work { out.appleDeletes.append(item.localId) }
                continue
            }

            let tf = fields(of: t)
            let s = prior?.fields ?? [:]
            var toTask: [String: String] = [:]
            var toApple: [String: String] = [:]
            let appleNewer = (item.modified ?? .distantPast) > (ISO.date(t.updated_at) ?? .distantPast)
            for k in fieldNames {
                let av = a[k] ?? "", tv = tf[k] ?? ""
                if av == tv { continue }
                let aChanged = prior == nil || av != (s[k] ?? "")
                let tChanged = prior == nil || tv != (s[k] ?? "")
                if aChanged && !tChanged { toTask[k] = av }
                else if tChanged && !aChanged { toApple[k] = tv }
                else if appleNewer { toTask[k] = av } else { toApple[k] = tv }
            }
            var patch = taskFields(toTask, item: item, task: t, now: now)
            let currentLink = t.fields["apple"]?.objectValue
            let taskList = currentLink?["list_title"]?.stringValue ?? ""
            if !taskList.isEmpty, taskList != item.listTitle,
               (ISO.date(t.field_ts["apple"]) ?? .distantPast) > (item.modified ?? .distantPast) {
                // Moved to another list in the app, after the last change in Apple: move it there too.
                out.appleMoves.append(.init(localId: item.localId, listTitle: taskList))
            } else if currentLink?["id"]?.stringValue != item.externalId || taskList != item.listTitle {
                patch["apple"] = link
            }
            if !patch.isEmpty { out.taskPatches.append(Patch(id: t.id, kind: .task, ts: ts, fields: patch)) }
            if !toApple.isEmpty { out.appleWrites.append(.init(localId: item.localId, fields: toApple)) }
            var agreed = a
            for (k, v) in toApple { agreed[k] = v }
            out.state[item.externalId] = SyncedReminder(taskId: t.id, localId: item.localId, fields: agreed)
        }

        // Synced before, gone from Apple Reminders now (and its list is still here): deleted there, so delete the task.
        for (key, rec) in state where !seen.contains(key) {
            guard let t = byId[rec.taskId], !t.isDeleted else { continue }
            // Finished in the app (on another device, while this one was away): a finished item drops out of what
            // Apple returns after two weeks, which is not a deletion. Its record is forgotten instead.
            if t.str("status") == "done" { continue }
            let listId = t.fields["apple"]?.objectValue?["list"]?.stringValue ?? ""
            if t.space == .work && workOff { continue }
            if presentLists.contains(listId) || listId.isEmpty {
                out.taskPatches.append(Patch(id: t.id, kind: .task, ts: ts, fields: ["deleted_at": .string(ts)]))
            } else {
                out.state[key] = rec // its list is not on this device; another device keeps it
            }
        }

        // Open tasks made in the app go to Apple Reminders, from one device only: into the list they were made in
        // (a work task only when it names a work list), else personal ones into the default list.
        if createsInApple {
            // A task matched to an Apple item above has its item already.
            let linkedNow = Set(out.state.values.map(\.taskId))
            for t in tasks where t.kind == .task && !t.isDeleted && t.str("status") != "done" && !linkedNow.contains(t.id) {
                let link = t.fields["apple"]?.objectValue
                guard (link?["id"]?.stringValue ?? "").isEmpty else { continue }
                let list = link?["list_title"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
                if t.space == .work && list == nil { continue }
                out.appleCreates.append(.init(taskId: t.id, fields: fields(of: t), listTitle: list, isWork: t.space == .work))
            }
        }
        return out
    }
}
