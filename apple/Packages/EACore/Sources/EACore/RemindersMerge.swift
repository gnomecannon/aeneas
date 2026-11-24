import Foundation

/// One Apple Reminders item as the sync sees it. Dates are ISO strings rounded to the minute; a due date with no time
/// is the day alone (YYYY-MM-DD), the same day in every time zone (`ReminderDates`). `repeatRule` uses the app's
/// repeat grammar and is nil when Apple's rule has no equivalent.
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
/// a field changed on one side only goes to the other; changed on both, the newer side wins. With no record yet (a
/// first match), an empty value is filled from the other side and never clears it, and two values that differ go to
/// the newer side (to the task when the match was by title alone). Pure, so it is tested without EventKit.
public enum RemindersMerge {
    public static let fieldNames = ["title", "notes", "due", "remind_at", "repeat", "done"]
    /// The key in a sync record for the list both sides last agreed the item is in, by name. Records from before
    /// 2026-11-24 have none.
    public static let listKey = "list"
    /// Finished Apple items older than this are not brought in.
    public static let importDoneWithin: TimeInterval = 14 * 86400

    public static func taskId(forExternal id: String) -> String { StableID.uuid("apple-reminder:\(id)") }

    /// A minute-rounded ISO string, so EventKit's seconds and the hub's milliseconds compare equal.
    public static func minute(_ s: String?) -> String {
        guard let s, let d = ISO.date(s) else { return "" }
        return ISO.string(Date(timeIntervalSince1970: (d.timeIntervalSince1970 / 60).rounded(.down) * 60))
    }

    /// A deadline as both sides compare it: a day alone (YYYY-MM-DD) stays that day, as the contract allows; a moment
    /// is rounded to the minute. A day read as local midnight was another moment in every time zone, and went back to
    /// Apple Reminders with an hour (3:00 AM after a flight west).
    public static func due(_ s: String?) -> String {
        guard let s, !s.isEmpty else { return "" }
        return TaskDue.isDateOnly(s) ? s : minute(s)
    }

    /// A repeat Apple Reminders can hold too (days and longer); minutes and hours stay app-only.
    public static func appleRepeat(_ r: String?) -> String {
        guard let r, let rule = RepeatRule.parse(r), ![.minutes, .hours].contains(rule.unit) else { return "" }
        return rule.description
    }

    public static func fields(of item: ReminderItem) -> [String: String] {
        ["title": item.title, "notes": item.notes ?? "", "due": due(item.due), "remind_at": minute(item.remindAt),
         "repeat": appleRepeat(item.repeatRule), "done": item.done ? "1" : "0"]
    }

    public static func fields(of task: Entity) -> [String: String] {
        ["title": task.str("title"), "notes": task.str("notes"), "due": due(task.str("due")), "remind_at": minute(task.str("remind_at")),
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
    ///   - writableLists: the names of the lists this device can move an item into; nil when not known (any).
    public static func plan(items: [ReminderItem], tasks: [Entity], state: [String: SyncedReminder], presentLists: Set<String>,
                            createsInApple: Bool, workOff: Bool, writableLists: Set<String>? = nil, now: Date = Date()) -> RemindersPlan {
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
        // One Apple item per task. Two items that both took one task (the same title in two lists) moved its link
        // back and forth on every run, a hub write each time.
        var taken = Set<String>()
        // A task a record already ties to an item is not free for a match by title.
        let recorded = Set(state.values.map(\.taskId))
        func linkId(_ t: Entity) -> String { t.fields["apple"]?.objectValue?["id"]?.stringValue ?? "" }
        func plain(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

        // The same order on every run and every device, so a title meets the same task everywhere.
        for item in items.sorted(by: { $0.externalId < $1.externalId }) {
            if item.isWork && workOff { continue }
            // An item whose server id changed after its first save keeps its record by this device's id.
            let key = state[item.externalId] != nil ? item.externalId : (byLocal[item.localId] ?? item.externalId)
            seen.insert(key)
            let prior = state[key]
            var task = byLink[item.externalId] ?? byLink[key]
            if task == nil, let t = prior.flatMap({ byId[$0.taskId] }) {
                // The record's task, unless it is linked to another item now: then the record came from two items
                // taking one task, and this item is left to come in as its own on the next run.
                let other = linkId(t)
                if other.isEmpty || other == item.externalId || other == key { task = t }
            }
            if task == nil { task = byId[taskId(forExternal: item.externalId)] }
            if let t = task, taken.contains(t.id) { task = nil }
            var byTitle = false
            if task == nil, prior == nil, !item.done {
                // A task made in the app whose Apple item came here before its link did (the other device made the
                // item, and iCloud was quicker than the hub), or whose link was lost when the app stopped: the same
                // title, open, not linked yet and made in the last day. Without this match it became a second task.
                // Only an open item: a finished one is another reminder that only shares the name.
                let title = plain(item.title)
                let space: Space = item.isWork ? .work : .personal
                // A task made inside a list carries a link with no id yet ({ id: "", list_title }): it is not linked
                // either. Left out, the Mac made a second task for the iPhone's new item, in Inbox.
                task = tasks.filter { t in
                    t.kind == .task && !t.isDeleted && linkId(t).isEmpty && t.space == space && t.str("status") != "done"
                        && !taken.contains(t.id) && !recorded.contains(t.id) && !title.isEmpty && plain(t.str("title")) == title
                        && (ISO.date(t.created_at).map { now.timeIntervalSince($0) < 86400 } ?? false)
                }.min { ($0.created_at, $0.id) < ($1.created_at, $1.id) }
                byTitle = task != nil
            }
            if let t = task { taken.insert(t.id) }
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
                var rec = a
                rec[listKey] = item.listTitle
                out.state[item.externalId] = SyncedReminder(taskId: id, localId: item.localId, fields: rec)
                continue
            }

            if t.isDeleted {
                // Deleted in the app: delete it in Apple Reminders too, except work items (turning the work space
                // off erases them from the app, never from the work account).
                if prior != nil, t.space != .work { out.appleDeletes.append(item.localId) }
                continue
            }

            if t.space == .work, !item.isWork, t.field_ts["space"] != nil {
                // Moved to Work in the app (a move leaves its stamp) while its item is in a personal list: work tasks
                // stay out of personal lists, so the item goes, as a deleted personal task's does, and so does the tie.
                out.appleDeletes.append(item.localId)
                if t.fields["apple"] != nil { out.taskPatches.append(Patch(id: t.id, kind: .task, ts: ts, fields: ["apple": .null])) }
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
                guard prior != nil else {
                    // Met for the first time, with no record of what the two last agreed on: an empty value is filled
                    // from the other side and never clears it (a deadline, an alarm, notes). Matched by title alone,
                    // the item may be the person's own reminder that only shares the name: its values stay, and the
                    // task takes them.
                    if av.isEmpty { toApple[k] = tv }
                    else if tv.isEmpty || byTitle || appleNewer { toTask[k] = av }
                    else { toApple[k] = tv }
                    continue
                }
                let aChanged = av != (s[k] ?? "")
                let tChanged = tv != (s[k] ?? "")
                if aChanged && !tChanged { toTask[k] = av }
                else if tChanged && !aChanged { toApple[k] = tv }
                else if appleNewer { toTask[k] = av } else { toApple[k] = tv }
            }
            var patch = taskFields(toTask, item: item, task: t, now: now)
            let currentLink = t.fields["apple"]?.objectValue
            let taskList = currentLink?["list_title"]?.stringValue ?? ""
            // The list, merged like the other fields against the one both sides last agreed on. It used to go by time
            // alone: the app's side won whenever the task's link was written after Apple's last edit of the item. But
            // renaming a list in Apple Reminders changes none of its items, and an item's edit time can be missing,
            // so the app kept the old name (or the default list) and tried to move the item back, which failed for a
            // list that no longer exists. Tasks from such a list showed under no list, in Inbox, for good.
            var agreedList = item.listTitle
            let movable = !taskList.isEmpty && (writableLists?.contains(taskList) ?? true)
            if !taskList.isEmpty, taskList != item.listTitle {
                let appNewer = (ISO.date(t.field_ts["apple"]) ?? .distantPast) > (item.modified ?? .distantPast)
                let appMoved: Bool
                if let was = prior?.fields[listKey] {
                    let aChanged = item.listTitle != was, tChanged = taskList != was
                    if tChanged && !aChanged { appMoved = true }
                    else if aChanged && !tChanged { appMoved = false }
                    else { appMoved = appNewer && item.modified != nil }
                } else {
                    // A record from before lists were kept in it: the time decides, as it did, but only against a
                    // known edit time and a list this device has (a renamed list's old name is on none).
                    appMoved = appNewer && item.modified != nil && writableLists.map { $0.contains(taskList) } != false
                }
                if appMoved {
                    if movable {
                        // Moved to another list in the app: move it there too.
                        out.appleMoves.append(.init(localId: item.localId, listTitle: taskList))
                        agreedList = taskList
                    } else {
                        // Not a list this device can put it in (another device may have it): left as both are.
                        agreedList = prior?.fields[listKey] ?? item.listTitle
                    }
                } else {
                    patch["apple"] = link
                }
            } else if currentLink?["id"]?.stringValue != item.externalId || taskList != item.listTitle {
                patch["apple"] = link
            }
            if !patch.isEmpty { out.taskPatches.append(Patch(id: t.id, kind: .task, ts: ts, fields: patch)) }
            if !toApple.isEmpty { out.appleWrites.append(.init(localId: item.localId, fields: toApple)) }
            var agreed = a
            for (k, v) in toApple { agreed[k] = v }
            agreed[listKey] = agreedList
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

/// An Apple Reminders alarm as the date rules see it: at a moment, or an offset from the due date. One tied to a
/// place (arriving or leaving) is kept as it is when dates move.
public struct ReminderAlarm: Equatable, Sendable {
    public var absolute: Date?
    public var offset: TimeInterval
    public var place: Bool
    public init(absolute: Date? = nil, offset: TimeInterval = 0, place: Bool = false) { self.absolute = absolute; self.offset = offset; self.place = place }
}

/// How an Apple item's due date and alarms read as a task's `due` and `remind_at`, and what is written back when they
/// change. Pure, so it is tested without EventKit (RemindersSync reads and writes the EventKit side).
public enum ReminderDates {
    /// The due date and reminder time Apple's fields stand for. A due date with no time is the day alone
    /// (YYYY-MM-DD): read as local midnight, it was another moment in every time zone. Apple puts a timed reminder's
    /// time in both the due date and its alarm; that reads as a reminder with no separate deadline.
    public static func read(due c: DateComponents?, alarms: [ReminderAlarm], calendar: Calendar = .current) -> (due: String?, remindAt: String?) {
        let dueDate = c.flatMap { moment($0, calendar: calendar) }
        let alarm = alarms.lazy.compactMap { a in a.absolute ?? dueDate.map { $0.addingTimeInterval(a.offset) } }.first
        let remindAt = alarm.map { ISO.string($0) }
        guard let c, let d = dueDate, alarm.map({ abs($0.timeIntervalSince(d)) < 60 }) != true else { return (nil, remindAt) }
        return (dayAlone(c) ?? ISO.string(d), remindAt)
    }

    /// YYYY-MM-DD for a due date with no time; nil for one with a time.
    static func dayAlone(_ c: DateComponents) -> String? {
        guard c.hour == nil, let y = c.year, let m = c.month, let d = c.day else { return nil }
        return String(format: "%04d-%02d-%02d", y, m, d)
    }

    /// The moment a due date stands for on this device: a day alone at local midnight (alarms set from the due date
    /// count from there).
    static func moment(_ c: DateComponents, calendar: Calendar) -> Date? {
        var c = c
        if c.calendar == nil { c.calendar = calendar }
        if c.hour == nil { c.hour = 0; c.minute = 0 }
        return c.date
    }

    /// The due date written for a task's `due` (or its reminder time when it has no deadline). A day alone is a date
    /// with no time, whatever the time zone; so is a moment at local midnight, which is how older builds kept a day.
    public static func components(_ s: String?, calendar: Calendar = .current) -> DateComponents? {
        guard let s, !s.isEmpty else { return nil }
        if TaskDue.isDateOnly(s) {
            let p = s.split(separator: "-").compactMap { Int($0) }
            guard p.count == 3 else { return nil }
            var out = DateComponents(year: p[0], month: p[1], day: p[2])
            out.calendar = calendar
            return out
        }
        guard let d = ISO.date(s) else { return nil }
        let hm = calendar.dateComponents([.hour, .minute], from: d)
        let timed = !(hm.hour == 0 && hm.minute == 0)
        var out = calendar.dateComponents(timed ? [.year, .month, .day, .hour, .minute] : [.year, .month, .day], from: d)
        out.calendar = calendar
        out.timeZone = timed ? calendar.timeZone : nil
        return out
    }

    /// One alarm after a change of dates: `from` is the index of one kept from before (moved to `at` when that is
    /// set), nil a new one at `at`.
    public struct AlarmWrite: Equatable, Sendable {
        public var from: Int?
        public var at: Date?
        public init(from: Int?, at: Date?) { self.from = from; self.at = at }
    }

    public struct Write: Equatable, Sendable {
        public var due: DateComponents?
        public var alarms: [AlarmWrite]
        /// Apple's repeat rule stays as it is; otherwise it is made again from the app's repeat.
        public var keepsRepeat: Bool
    }

    /// What to write after the task's due date, reminder time or repeat changed in the app.
    /// - Parameters:
    ///   - full: the task's fields, as `RemindersMerge.fields(of:)` gives them.
    ///   - repeatChanged: the repeat itself changed, so Apple's rule is made again from the app's.
    ///   - current, alarms: the item's due date and alarms as they are now.
    /// When only the dates moved (Done on a repeating task moves them to the next time), Apple's rule and alarms stay:
    /// they can hold what the app's repeat cannot (an end date, a count, "last Friday", a place). Alarms at a moment
    /// move as far as the reminder time did, those counted from the due date move with it, and those tied to a place
    /// stay. Only when that would not read back as the task's dates are the alarms made again, as before: one at the
    /// reminder time.
    public static func write(full: [String: String], repeatChanged: Bool, due current: DateComponents?, alarms: [ReminderAlarm],
                             calendar: Calendar = .current) -> Write {
        let deadline = full["due"] ?? ""
        let due = components(deadline.isEmpty ? full["remind_at"] : deadline, calendar: calendar)
        let at = ISO.date(full["remind_at"])
        let rebuilt = at.map { [AlarmWrite(from: nil, at: $0)] } ?? []
        guard !repeatChanged else { return Write(due: due, alarms: rebuilt, keepsRepeat: false) }
        let keeps = due != nil
        // What the item has to read as afterwards, or the next run takes Apple's side for a change and undoes the edit.
        let wantDue = deadline.isEmpty ? "" : RemindersMerge.due(read(due: due, alarms: [], calendar: calendar).due)
        let wantAt = RemindersMerge.minute(full["remind_at"])
        let oldAt = ISO.date(read(due: current, alarms: alarms, calendar: calendar).remindAt)
        let shift = at.flatMap { a in oldAt.map { a.timeIntervalSince($0) } } ?? 0
        var moved: [AlarmWrite] = []
        for (i, a) in alarms.enumerated() {
            if a.place { moved.append(AlarmWrite(from: i, at: nil)); continue }
            // No reminder time any more: the alarms with a time go; one tied to a place stays.
            guard at != nil else { continue }
            if let t = a.absolute, shift != 0 { moved.append(AlarmWrite(from: i, at: t.addingTimeInterval(shift))) }
            else { moved.append(AlarmWrite(from: i, at: nil)) }
        }
        let after = moved.map { w -> ReminderAlarm in
            guard let i = w.from else { return ReminderAlarm(absolute: w.at) }
            var a = alarms[i]
            if let t = w.at { a.absolute = t }
            return a
        }
        let r = read(due: due, alarms: after, calendar: calendar)
        if RemindersMerge.due(r.due) == wantDue, RemindersMerge.minute(r.remindAt) == wantAt {
            return Write(due: due, alarms: moved, keepsRepeat: keeps)
        }
        return Write(due: due, alarms: rebuilt, keepsRepeat: keeps)
    }
}
