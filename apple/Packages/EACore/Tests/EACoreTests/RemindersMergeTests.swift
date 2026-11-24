import XCTest
@testable import EACore

final class RemindersMergeTests: XCTestCase {
    let now = ISO.date("2026-10-28T12:00:00.000Z")!
    func item(_ ext: String = "X1", title: String = "Buy filament", due: String? = nil, remind: String? = nil, repeatRule: String? = nil, done: Bool = false, modified: String = "2026-10-28T11:00:00.000Z", work: Bool = false) -> ReminderItem {
        ReminderItem(externalId: ext, localId: "L-\(ext)", listId: work ? "W" : "P", listTitle: work ? "Work" : "Personal", isWork: work, title: title,
                     due: due, remindAt: remind, repeatRule: repeatRule, done: done, modified: ISO.date(modified))
    }
    func task(_ id: String, _ f: [String: JSONValue], updated: String = "2026-10-28T10:00:00.000Z", deleted: Bool = false, space: Space = .personal) -> Entity {
        var e = Entity(id: id, kind: .task, space: space, fields: f)
        e.updated_at = updated
        if deleted { e.deleted_at = updated }
        return e
    }

    func testNewAppleItemBecomesAScheduledTaskWithAStableId() {
        let p = RemindersMerge.plan(items: [item(remind: "2026-10-29T15:00:30.000Z")], tasks: [], state: [:], presentLists: ["P"], createsInApple: false, workOff: false, now: now)
        XCTAssertEqual(p.taskPatches.count, 1)
        let patch = p.taskPatches[0]
        XCTAssertEqual(patch.id, RemindersMerge.taskId(forExternal: "X1"))
        XCTAssertEqual(patch.create, true)
        XCTAssertEqual(patch.fields["status"]?.stringValue, "scheduled")
        XCTAssertEqual(patch.fields["remind_at"]?.stringValue, "2026-10-29T15:00:00.000Z", "rounded to the minute")
        XCTAssertEqual(patch.fields["apple"]?.objectValue?["list_title"]?.stringValue, "Personal")
        XCTAssertEqual(p.state["X1"]?.taskId, patch.id)
        // Long-finished items stay out; work items stay out while the work space is off.
        var old = item("X2", done: true); old.doneAt = "2026-09-01T00:00:00.000Z"
        XCTAssertTrue(RemindersMerge.plan(items: [old, item("X3", work: true)], tasks: [], state: [:], presentLists: ["P", "W"], createsInApple: false, workOff: true, now: now).taskPatches.isEmpty)
        XCTAssertEqual(RemindersMerge.plan(items: [item("X3", work: true)], tasks: [], state: [:], presentLists: ["W"], createsInApple: false, workOff: false, now: now).taskPatches.first?.space, .work)
    }

    func testOneSidedChangesGoAcrossAndBothSidedTakesTheNewer() {
        let id = RemindersMerge.taskId(forExternal: "X1")
        let agreed = SyncedReminder(taskId: id, localId: "L-X1", fields: RemindersMerge.fields(of: item()))
        let link: JSONValue = .object(["id": "X1", "list": "P", "list_title": "Personal"])
        // Title changed in Apple only.
        var t = task(id, ["title": "Buy filament", "status": "inbox", "order": 1, "apple": link])
        var p = RemindersMerge.plan(items: [item(title: "Buy PLA filament")], tasks: [t], state: ["X1": agreed], presentLists: ["P"], createsInApple: false, workOff: false, now: now)
        XCTAssertEqual(p.taskPatches.first?.fields["title"]?.stringValue, "Buy PLA filament")
        XCTAssertTrue(p.appleWrites.isEmpty)
        // Done in the app only.
        t = task(id, ["title": "Buy filament", "status": "done", "order": 1, "apple": link])
        p = RemindersMerge.plan(items: [item()], tasks: [t], state: ["X1": agreed], presentLists: ["P"], createsInApple: false, workOff: false, now: now)
        XCTAssertEqual(p.appleWrites.first?.fields["done"], "1")
        XCTAssertTrue(p.taskPatches.isEmpty)
        XCTAssertEqual(p.state["X1"]?.fields["done"], "1")
        // Both changed the title: the app edit at 10:00 loses to Apple's at 11:00.
        t = task(id, ["title": "Filament from the app", "status": "inbox", "order": 1, "apple": link])
        p = RemindersMerge.plan(items: [item(title: "Filament from Apple")], tasks: [t], state: ["X1": agreed], presentLists: ["P"], createsInApple: false, workOff: false, now: now)
        XCTAssertEqual(p.taskPatches.first?.fields["title"]?.stringValue, "Filament from Apple")
    }

    func testAnHourlyRepeatStaysInTheAppAndIsNeverCleared() {
        let id = RemindersMerge.taskId(forExternal: "X1")
        let link: JSONValue = .object(["id": "X1", "list": "P", "list_title": "Personal"])
        let t = task(id, ["title": "Water", "status": "scheduled", "order": 1, "remind_at": "2026-10-28T13:00:00.000Z", "repeat": "every 2 hours", "apple": link])
        let i = item(title: "Water", remind: "2026-10-28T13:00:00.000Z")
        let agreed = SyncedReminder(taskId: id, localId: "L-X1", fields: RemindersMerge.fields(of: i))
        let p = RemindersMerge.plan(items: [i], tasks: [t], state: ["X1": agreed], presentLists: ["P"], createsInApple: false, workOff: false, now: now)
        XCTAssertTrue(p.taskPatches.isEmpty)
        XCTAssertTrue(p.appleWrites.isEmpty)
    }

    func testDeletionsBothWaysAndWorkItemsAreNeverDeletedInApple() {
        let id = RemindersMerge.taskId(forExternal: "X1")
        let link: JSONValue = .object(["id": "X1", "list": "P", "list_title": "Personal"])
        let agreed = SyncedReminder(taskId: id, localId: "L-X1", fields: RemindersMerge.fields(of: item()))
        // Gone from Apple, list still here: the task is deleted.
        let live = task(id, ["title": "Buy filament", "status": "inbox", "order": 1, "apple": link])
        var p = RemindersMerge.plan(items: [], tasks: [live], state: ["X1": agreed], presentLists: ["P"], createsInApple: false, workOff: false, now: now)
        XCTAssertNotNil(p.taskPatches.first?.fields["deleted_at"])
        // Its list is not on this device (the Mac lacks an iPhone-only list): leave it alone.
        p = RemindersMerge.plan(items: [], tasks: [live], state: ["X1": agreed], presentLists: ["Q"], createsInApple: false, workOff: false, now: now)
        XCTAssertTrue(p.taskPatches.isEmpty)
        XCTAssertNotNil(p.state["X1"])
        // Deleted in the app: deleted in Apple, except a work item.
        let gone = task(id, ["title": "Buy filament", "status": "inbox", "order": 1, "apple": link], deleted: true)
        p = RemindersMerge.plan(items: [item()], tasks: [gone], state: ["X1": agreed], presentLists: ["P"], createsInApple: false, workOff: false, now: now)
        XCTAssertEqual(p.appleDeletes, ["L-X1"])
        let goneWork = task(id, ["title": "Buy filament", "status": "inbox", "order": 1, "apple": link], deleted: true, space: .work)
        p = RemindersMerge.plan(items: [item()], tasks: [goneWork], state: ["X1": agreed], presentLists: ["P"], createsInApple: false, workOff: false, now: now)
        XCTAssertTrue(p.appleDeletes.isEmpty)
    }

    func testAppTasksAreAddedToAppleFromOneDeviceOnly() {
        let open = task("T1", ["title": "Call the vet", "status": "scheduled", "order": 1, "remind_at": "2026-10-29T15:00:00.000Z"])
        let done = task("T2", ["title": "Old", "status": "done", "order": 2])
        let work = task("T3", ["title": "Work thing", "status": "next", "order": 3], space: .work)
        let p = RemindersMerge.plan(items: [], tasks: [open, done, work], state: [:], presentLists: ["P"], createsInApple: true, workOff: false, now: now)
        XCTAssertEqual(p.appleCreates.map(\.taskId), ["T1"])
        XCTAssertEqual(p.appleCreates.first?.fields["remind_at"], "2026-10-29T15:00:00.000Z")
        XCTAssertTrue(RemindersMerge.plan(items: [], tasks: [open], state: [:], presentLists: ["P"], createsInApple: false, workOff: false, now: now).appleCreates.isEmpty)
    }

    func testListMovesFollowTheNewerSideAndNewTasksLandInTheirList() {
        let id = RemindersMerge.taskId(forExternal: "X1")
        let agreed = SyncedReminder(taskId: id, localId: "L-X1", fields: RemindersMerge.fields(of: item()))
        // Moved to Groceries in the app at 11:30, after Apple's last change at 11:00: move it in Apple.
        var t = task(id, ["title": "Buy filament", "status": "inbox", "order": 1, "apple": .object(["id": "X1", "list": "P", "list_title": "Groceries"])])
        t.field_ts["apple"] = "2026-10-28T11:30:00.000Z"
        var p = RemindersMerge.plan(items: [item()], tasks: [t], state: ["X1": agreed], presentLists: ["P"], createsInApple: false, workOff: false, now: now)
        XCTAssertEqual(p.appleMoves, [.init(localId: "L-X1", listTitle: "Groceries")])
        XCTAssertTrue(p.taskPatches.isEmpty)
        // Moved in Apple after the app's change: the task follows.
        t.field_ts["apple"] = "2026-10-28T10:30:00.000Z"
        p = RemindersMerge.plan(items: [item()], tasks: [t], state: ["X1": agreed], presentLists: ["P"], createsInApple: false, workOff: false, now: now)
        XCTAssertTrue(p.appleMoves.isEmpty)
        XCTAssertEqual(p.taskPatches.first?.fields["apple"]?.objectValue?["list_title"]?.stringValue, "Personal")
        // Made in the app inside a list: created there; a work task only with a list named.
        let inList = task("T1", ["title": "Milk", "status": "inbox", "order": 1, "apple": .object(["id": "", "list": "", "list_title": "Groceries"])])
        let workNamed = task("T2", ["title": "Badge", "status": "inbox", "order": 2, "apple": .object(["id": "", "list": "", "list_title": "Work"])], space: .work)
        let workBare = task("T3", ["title": "Loose", "status": "inbox", "order": 3], space: .work)
        p = RemindersMerge.plan(items: [], tasks: [inList, workNamed, workBare], state: [:], presentLists: ["P"], createsInApple: true, workOff: false, now: now)
        XCTAssertEqual(p.appleCreates.map(\.taskId), ["T1", "T2"])
        XCTAssertEqual(p.appleCreates.map(\.listTitle), ["Groceries", "Work"])
        XCTAssertEqual(p.appleCreates.last?.isWork, true)
    }

    /// gnomecannon/aeneas#9: tasks from an iCloud list (Shopping) showed under no list, in Inbox, instead of under its name.
    func testATaskTakesItsListsNameWhenTheListWasRenamedOrTheItemMovedInApple() {
        let id = RemindersMerge.taskId(forExternal: "X1")
        func inList(_ title: String, modified: Date?) -> ReminderItem {
            var i = item(); i.listId = "S"; i.listTitle = title; i.modified = modified; return i
        }
        func linked(_ list: String) -> Entity {
            var t = task(id, ["title": "Buy filament", "status": "inbox", "order": 1, "apple": .object(["id": "X1", "list": "S", "list_title": .string(list)])])
            // Linked by the sync at noon, after Apple's last edit of the item at 11:00.
            t.field_ts["apple"] = "2026-10-28T11:59:00.000Z"
            return t
        }
        var rec = RemindersMerge.fields(of: item())
        rec[RemindersMerge.listKey] = "Groceries"
        let agreed = SyncedReminder(taskId: id, localId: "L-X1", fields: rec)
        // The list Groceries was renamed Shopping in Apple Reminders: none of its items changed, so the link was newer
        // and the app's old name won (a move to a list that no longer exists). The task takes the new name.
        let renamed = inList("Shopping", modified: ISO.date("2026-10-28T11:00:00.000Z"))
        var p = RemindersMerge.plan(items: [renamed], tasks: [linked("Groceries")], state: ["X1": agreed], presentLists: ["S"], createsInApple: true, workOff: false,
                                    writableLists: ["Shopping", "Reminders"], now: now)
        XCTAssertTrue(p.appleMoves.isEmpty, "never moved back to a list that is gone")
        XCTAssertEqual(p.taskPatches.first?.fields["apple"]?.objectValue?["list_title"]?.stringValue, "Shopping")
        XCTAssertEqual(p.state["X1"]?.fields[RemindersMerge.listKey], "Shopping")
        // The same with a record from an older build (no list in it): the old name is on no list here, so Apple's wins.
        let legacy = SyncedReminder(taskId: id, localId: "L-X1", fields: RemindersMerge.fields(of: item()))
        p = RemindersMerge.plan(items: [renamed], tasks: [linked("Groceries")], state: ["X1": legacy], presentLists: ["S"], createsInApple: true, workOff: false,
                                writableLists: ["Shopping", "Reminders"], now: now)
        XCTAssertTrue(p.appleMoves.isEmpty)
        XCTAssertEqual(p.taskPatches.first?.fields["apple"]?.objectValue?["list_title"]?.stringValue, "Shopping")
        // Moved from Reminders into a new Shopping list in Apple, with no edit time given: Apple's list, not a move back.
        p = RemindersMerge.plan(items: [inList("Shopping", modified: nil)], tasks: [linked("Reminders")], state: ["X1": legacy], presentLists: ["S"], createsInApple: true,
                                workOff: false, writableLists: ["Shopping", "Reminders"], now: now)
        XCTAssertTrue(p.appleMoves.isEmpty)
        XCTAssertEqual(p.taskPatches.first?.fields["apple"]?.objectValue?["list_title"]?.stringValue, "Shopping")
        // A move made in the app still goes to Apple, even after a later edit there (the title), by the record.
        var moved = linked("Shopping")
        moved.field_ts["apple"] = "2026-10-28T10:00:00.000Z"
        let edited = inList("Groceries", modified: ISO.date("2026-10-28T11:00:00.000Z"))
        p = RemindersMerge.plan(items: [edited], tasks: [moved], state: ["X1": agreed], presentLists: ["S"], createsInApple: true, workOff: false,
                                writableLists: ["Shopping", "Groceries"], now: now)
        XCTAssertEqual(p.appleMoves, [.init(localId: "L-X1", listTitle: "Shopping")])
        XCTAssertNil(p.taskPatches.first?.fields["apple"])
        XCTAssertEqual(p.state["X1"]?.fields[RemindersMerge.listKey], "Shopping")
        // To a list this device does not have (an iPhone-only one, seen from the Mac): neither side changes.
        p = RemindersMerge.plan(items: [edited], tasks: [moved], state: ["X1": agreed], presentLists: ["S"], createsInApple: false, workOff: false,
                                writableLists: ["Groceries"], now: now)
        XCTAssertTrue(p.appleMoves.isEmpty)
        XCTAssertNil(p.taskPatches.first?.fields["apple"])
        XCTAssertEqual(p.state["X1"]?.fields[RemindersMerge.listKey], "Groceries")
        // A new item's record keeps its list.
        p = RemindersMerge.plan(items: [renamed], tasks: [], state: [:], presentLists: ["S"], createsInApple: false, workOff: false, now: now)
        XCTAssertEqual(p.state["X1"]?.fields[RemindersMerge.listKey], "Shopping")
    }

    /// A task made inside a list on the web: the iPhone adds it to that list, and the Mac sees the new item before the
    /// task's link arrives. It made a second task for it, in Inbox.
    func testAnItemMadeForATaskInAListMeetsItOnTheOtherDevice() {
        var t = task("T1", ["title": "Milk", "status": "next", "order": 1, "apple": .object(["id": "", "list": "", "list_title": "Shopping"])])
        t.created_at = "2026-10-28T11:50:00.000Z"
        var i = item(title: "Milk"); i.listTitle = "Shopping"
        let p = RemindersMerge.plan(items: [i], tasks: [t], state: [:], presentLists: ["P"], createsInApple: false, workOff: false, now: now)
        XCTAssertFalse(p.taskPatches.contains { $0.create == true }, "no second task")
        XCTAssertEqual(p.state["X1"]?.taskId, "T1")
        XCTAssertEqual(p.taskPatches.first?.fields["apple"]?.objectValue?["id"]?.stringValue, "X1")
    }

    func testAnAppleItemWhoseLinkHasNotArrivedMeetsItsTaskInsteadOfMakingASecond() {
        var t = task("T1", ["title": "Buy filament", "status": "next", "order": 1])
        t.created_at = "2026-10-28T11:50:00.000Z"
        let p = RemindersMerge.plan(items: [item()], tasks: [t], state: [:], presentLists: ["P"], createsInApple: true, workOff: false, now: now)
        XCTAssertFalse(p.taskPatches.contains { $0.create == true }, "no second task")
        XCTAssertEqual(p.state["X1"]?.taskId, "T1")
        XCTAssertTrue(p.appleCreates.isEmpty, "and no second Apple item for it")
    }

    func testATaskFinishedElsewhereIsNotDeletedWhenItsItemDropsOutOfApple() {
        let t = task("T1", ["title": "Buy filament", "status": "done", "order": 1, "apple": .object(["id": "X1", "list": "P", "list_title": "Personal"])])
        let rec = SyncedReminder(taskId: "T1", localId: "L-X1", fields: ["title": "Buy filament", "done": "0"])
        let p = RemindersMerge.plan(items: [], tasks: [t], state: ["X1": rec], presentLists: ["P"], createsInApple: false, workOff: false, now: now)
        XCTAssertTrue(p.taskPatches.isEmpty, "finished, so gone from what Apple returns, not deleted")
    }

    // MARK: first matches

    /// The person's own Apple reminder shares its title with a task made in the app today. Its deadline, alarm and
    /// notes were cleared (the newer task's empty values won); now the task takes them and nothing of it is cleared.
    func testATitleMatchFillsTheTaskAndNeverClearsTheAppleReminder() throws {
        var t = task("T1", ["title": "Call the dentist", "status": "inbox", "order": 1], updated: "2026-10-28T11:50:00.000Z")
        t.created_at = "2026-10-28T11:50:00.000Z"
        var i = item(title: "Call the dentist", due: "2026-11-02T17:00:00.000Z", remind: "2026-11-02T14:00:00.000Z", modified: "2026-10-21T10:00:00.000Z")
        i.notes = "ask about the crown"
        let p = RemindersMerge.plan(items: [i], tasks: [t], state: [:], presentLists: ["P"], createsInApple: true, workOff: false, now: now)
        XCTAssertTrue(p.appleWrites.isEmpty, "nothing written over the person's reminder")
        let patch = try XCTUnwrap(p.taskPatches.first { $0.id == "T1" })
        XCTAssertEqual(patch.fields["due"]?.stringValue, "2026-11-02T17:00:00.000Z")
        XCTAssertEqual(patch.fields["remind_at"]?.stringValue, "2026-11-02T14:00:00.000Z")
        XCTAssertEqual(patch.fields["notes"]?.stringValue, "ask about the crown")
        XCTAssertEqual(p.state["X1"]?.taskId, "T1")
        // What the task has and the reminder lacks fills it in; two values that differ stay as the reminder has them.
        var mine = t
        mine.fields["notes"] = "front desk"
        mine.fields["due"] = "2026-11-03T17:00:00.000Z"
        let bare = item(title: "Call the dentist", due: "2026-11-02T17:00:00.000Z", modified: "2026-10-21T10:00:00.000Z")
        let q = RemindersMerge.plan(items: [bare], tasks: [mine], state: [:], presentLists: ["P"], createsInApple: true, workOff: false, now: now)
        XCTAssertEqual(q.appleWrites.first?.fields, ["notes": "front desk"])
        XCTAssertEqual(q.taskPatches.first?.fields["due"]?.stringValue, "2026-11-02T17:00:00.000Z")
    }

    /// A finished Apple reminder with an open task's title is another reminder: it was reopened. It comes in as a
    /// done task of its own, and the open task gets an Apple item of its own.
    func testAFinishedAppleReminderNeverTakesATaskByTitle() {
        var t = task("T1", ["title": "Buy milk", "status": "inbox", "order": 1])
        t.created_at = "2026-10-28T11:50:00.000Z"
        var done = item(title: "Buy milk", done: true, modified: "2026-10-26T10:00:00.000Z")
        done.doneAt = "2026-10-26T10:00:00.000Z"
        let p = RemindersMerge.plan(items: [done], tasks: [t], state: [:], presentLists: ["P"], createsInApple: true, workOff: false, now: now)
        XCTAssertTrue(p.appleWrites.isEmpty, "not reopened")
        let own = RemindersMerge.taskId(forExternal: "X1")
        XCTAssertEqual(p.state["X1"]?.taskId, own)
        XCTAssertEqual(p.taskPatches.first { $0.id == own }?.fields["status"]?.stringValue, "done")
        XCTAssertNil(p.taskPatches.first { $0.id == "T1" })
        XCTAssertEqual(p.appleCreates.map(\.taskId), ["T1"])
    }

    /// Two Apple reminders with one title (one in each list) and one task: both took it, and its link changed on every
    /// run, a hub write each time. One takes it now, the other comes in as its own, and from the next run nothing moves.
    func testTwoRemindersWithOneTitleTakeOneTaskAndSettle() {
        var t = task("T1", ["title": "Milk", "status": "inbox", "order": 1], updated: "2026-10-28T11:50:00.000Z")
        t.created_at = "2026-10-28T11:50:00.000Z"
        let a1 = item("X1", title: "Milk", modified: "2026-10-28T11:55:00.000Z")
        var a2 = item("X2", title: "Milk", modified: "2026-10-28T11:55:00.000Z")
        a2.listId = "G"; a2.listTitle = "Groceries"
        var tasks = [t]
        var state: [String: SyncedReminder] = [:]
        var changes: [Int] = []
        for run in 0..<4 {
            let p = RemindersMerge.plan(items: [a2, a1], tasks: tasks, state: state, presentLists: ["P", "G"], createsInApple: true, workOff: false,
                                        now: now.addingTimeInterval(Double(run) * 10))
            for patch in p.taskPatches {
                if let i = tasks.firstIndex(where: { $0.id == patch.id }) { tasks[i].apply(patch) }
                else { var e = Entity(id: patch.id, kind: .task, space: patch.space ?? .personal, created_at: patch.ts); e.apply(patch); tasks.append(e) }
            }
            state = p.state
            changes.append(p.taskPatches.count + p.appleWrites.count + p.appleMoves.count + p.appleCreates.count)
        }
        XCTAssertEqual(state["X1"]?.taskId, "T1")
        XCTAssertEqual(state["X2"]?.taskId, RemindersMerge.taskId(forExternal: "X2"))
        XCTAssertEqual(tasks.first { $0.id == "T1" }?.fields["apple"]?.objectValue?["id"]?.stringValue, "X1")
        XCTAssertEqual(Array(changes.dropFirst()), [0, 0, 0], "settled after the first run")
    }

    /// Records left by that: two items whose records both name one task. The item its link names keeps it; the
    /// other's record goes, and it comes in as its own task on the next run.
    func testTwoRecordsNamingOneTaskSettle() {
        let link: JSONValue = .object(["id": "X1", "list": "P", "list_title": "Personal"])
        let t = task("T1", ["title": "Milk", "status": "inbox", "order": 1, "apple": link])
        let a1 = item("X1", title: "Milk"), a2 = item("X2", title: "Milk")
        let state = ["X1": SyncedReminder(taskId: "T1", localId: "L-X1", fields: RemindersMerge.fields(of: a1)),
                     "X2": SyncedReminder(taskId: "T1", localId: "L-X2", fields: RemindersMerge.fields(of: a2))]
        let p = RemindersMerge.plan(items: [a1, a2], tasks: [t], state: state, presentLists: ["P"], createsInApple: false, workOff: false, now: now)
        XCTAssertTrue(p.taskPatches.isEmpty, "the link stays on X1")
        XCTAssertTrue(p.appleDeletes.isEmpty)
        XCTAssertEqual(p.state["X1"]?.taskId, "T1")
        XCTAssertNil(p.state["X2"])
        let q = RemindersMerge.plan(items: [a1, a2], tasks: [t], state: p.state, presentLists: ["P"], createsInApple: false, workOff: false, now: now)
        XCTAssertEqual(q.taskPatches.map(\.id), [RemindersMerge.taskId(forExternal: "X2")])
        XCTAssertEqual(q.taskPatches.first?.create, true)
    }

    /// Linked by the other device, no record here yet: an empty value is filled from the other side, whichever side is
    /// newer. The newer Apple side cleared the task's notes.
    func testAFirstMatchByLinkFillsEmptyValuesAndClearsNone() {
        let link: JSONValue = .object(["id": "X1", "list": "P", "list_title": "Personal"])
        let t = task("T1", ["title": "Buy filament", "status": "scheduled", "order": 1, "notes": "PLA, black", "apple": link], updated: "2026-10-28T11:30:00.000Z")
        let i = item(title: "Buy filament", remind: "2026-10-29T15:00:00.000Z", modified: "2026-10-28T11:45:00.000Z")
        let p = RemindersMerge.plan(items: [i], tasks: [t], state: [:], presentLists: ["P"], createsInApple: false, workOff: false, now: now)
        XCTAssertEqual(p.appleWrites.first?.fields, ["notes": "PLA, black"])
        XCTAssertEqual(p.taskPatches.first?.fields["remind_at"]?.stringValue, "2026-10-29T15:00:00.000Z")
        XCTAssertNil(p.taskPatches.first?.fields["notes"])
    }

    // MARK: a day alone

    private func calendar(_ zone: String) -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: zone)!
        return c
    }

    /// "Pay rent" on Nov 20 with no time was read as local midnight, another moment in each time zone: the iPhone in
    /// Los Angeles stored its midnight and the Mac in New York wrote it back as 3:00 AM. It is the day alone now.
    func testADayAloneIsTheSameDayInEveryTimeZone() {
        let rent = DateComponents(year: 2026, month: 11, day: 20)
        for zone in ["America/New_York", "America/Los_Angeles", "Asia/Tokyo"] {
            XCTAssertEqual(ReminderDates.read(due: rent, alarms: [], calendar: calendar(zone)).due, "2026-11-20", zone)
            let back = ReminderDates.components("2026-11-20", calendar: calendar(zone))
            XCTAssertNil(back?.hour, "written back with no time in \(zone)")
            XCTAssertEqual([back?.year, back?.month, back?.day], [2026, 11, 20])
        }
        // With an alarm at 9 AM that day: the day, and the reminder at 9.
        let ny = calendar("America/New_York")
        let nine = ISO.date("2026-11-20T14:00:00.000Z")!
        let r = ReminderDates.read(due: rent, alarms: [ReminderAlarm(absolute: nine)], calendar: ny)
        XCTAssertEqual(r.due, "2026-11-20")
        XCTAssertEqual(r.remindAt, ISO.string(nine))
        // The iPhone in Los Angeles and the Mac in New York read the item alike: nothing to write on either side.
        let link: JSONValue = .object(["id": "X1", "list": "P", "list_title": "Personal"])
        let t = task("T1", ["title": "Pay rent", "status": "scheduled", "order": 1, "due": "2026-11-20", "apple": link])
        let i = item(title: "Pay rent", due: ReminderDates.read(due: rent, alarms: [], calendar: calendar("America/Los_Angeles")).due)
        let agreed = SyncedReminder(taskId: "T1", localId: "L-X1", fields: RemindersMerge.fields(of: i))
        let p = RemindersMerge.plan(items: [i], tasks: [t], state: ["X1": agreed], presentLists: ["P"], createsInApple: true, workOff: false, now: now)
        XCTAssertTrue(p.taskPatches.isEmpty)
        XCTAssertTrue(p.appleWrites.isEmpty)
        // A task an older build kept as New York midnight takes the day alone once; no hour goes to Apple.
        let midnight = "2026-11-20T05:00:00.000Z"
        let old = task("T1", ["title": "Pay rent", "status": "scheduled", "order": 1, "due": .string(midnight), "apple": link])
        var before = agreed
        before.fields["due"] = midnight
        let q = RemindersMerge.plan(items: [i], tasks: [old], state: ["X1": before], presentLists: ["P"], createsInApple: true, workOff: false, now: now)
        XCTAssertEqual(q.taskPatches.first?.fields["due"]?.stringValue, "2026-11-20")
        XCTAssertTrue(q.appleWrites.isEmpty)
    }

    // MARK: repeats

    /// Done in the app on "Water the plants" (every week, with an end in Apple Reminders, an alarm at 9 AM and one on
    /// arriving home). The rule was made again from the app's repeat (end gone) and every alarm replaced. Now the
    /// dates move a week, the rule stays, the 9 AM alarm moves with them and the place alarm stays.
    func testDoneOnARepeatMovesTheDatesAndKeepsApplesRuleAndAlarms() {
        let ny = calendar("America/New_York")
        let at = ISO.date("2026-11-20T14:00:00.000Z")!
        let next = at.addingTimeInterval(7 * 86400)
        let due = DateComponents(calendar: ny, timeZone: ny.timeZone, year: 2026, month: 11, day: 20, hour: 9, minute: 0)
        let alarms = [ReminderAlarm(absolute: at), ReminderAlarm(place: true)]
        let full = ["title": "Water the plants", "notes": "", "due": "", "remind_at": ISO.string(next), "repeat": "every 1 weeks", "done": "0"]
        let w = ReminderDates.write(full: full, repeatChanged: false, due: due, alarms: alarms, calendar: ny)
        XCTAssertTrue(w.keepsRepeat, "Apple's rule stays, with its end")
        XCTAssertEqual(w.alarms, [.init(from: 0, at: next), .init(from: 1, at: nil)])
        XCTAssertEqual(w.due?.day, 27)
        XCTAssertEqual(w.due?.hour, 9)
        // An alarm counted from the due date moves with it as it is.
        let relative = ReminderDates.write(full: full, repeatChanged: false, due: due, alarms: [ReminderAlarm(offset: 0)], calendar: ny)
        XCTAssertEqual(relative.alarms, [.init(from: 0, at: nil)])
        // No alarm to move: one at the new time, as before; the rule still stays.
        let none = ReminderDates.write(full: full, repeatChanged: false, due: due, alarms: [], calendar: ny)
        XCTAssertEqual(none.alarms, [.init(from: nil, at: next)])
        XCTAssertTrue(none.keepsRepeat)
        // The repeat itself changed in the app: the rule and the alarm are made again from the app's, as before.
        let changed = ReminderDates.write(full: full, repeatChanged: true, due: due, alarms: alarms, calendar: ny)
        XCTAssertFalse(changed.keepsRepeat)
        XCTAssertEqual(changed.alarms, [.init(from: nil, at: next)])
        // Alarms that would not read back as the task's dates are made again as before. Here the reminder time was
        // taken off and only a place alarm would be left, which reads as an alarm at the due date.
        var cleared = full
        cleared["remind_at"] = ""
        cleared["due"] = "2026-11-27"
        let off = ReminderDates.write(full: cleared, repeatChanged: false, due: due, alarms: alarms, calendar: ny)
        XCTAssertEqual(off.alarms, [])
        XCTAssertNil(off.due?.hour, "a day alone")
        XCTAssertTrue(off.keepsRepeat)
    }


    func testATaskMovedToWorkInTheAppLeavesItsPersonalListAndAWorkItemIsNeverDeleted() {
        let id = RemindersMerge.taskId(forExternal: "X1")
        let agreed = SyncedReminder(taskId: id, localId: "L-X1", fields: RemindersMerge.fields(of: item()))
        let link: JSONValue = .object(["id": "X1", "list": "P", "list_title": "Personal"])
        // Moved to Work in the app: the item in the personal list goes, and the tie with it; nothing comes back in.
        var moved = task(id, ["title": "Buy filament", "status": "inbox", "order": 1, "apple": link], space: .work)
        moved.field_ts["space"] = "2026-10-28T11:30:00.000Z"
        var p = RemindersMerge.plan(items: [item()], tasks: [moved], state: ["X1": agreed], presentLists: ["P"], createsInApple: true, workOff: false, now: now)
        XCTAssertEqual(p.appleDeletes, ["L-X1"])
        XCTAssertEqual(p.taskPatches.map(\.fields), [["apple": .null]])
        XCTAssertNil(p.state["X1"])
        XCTAssertTrue(p.appleCreates.isEmpty, "a work task with no list stays out of Apple")
        // A work task in a personal list that was never moved in the app (the account was read as personal) is left alone.
        let notMoved = task(id, ["title": "Buy filament", "status": "inbox", "order": 1, "apple": link], space: .work)
        p = RemindersMerge.plan(items: [item()], tasks: [notMoved], state: ["X1": agreed], presentLists: ["P"], createsInApple: true, workOff: false, now: now)
        XCTAssertTrue(p.appleDeletes.isEmpty)
        XCTAssertNotNil(p.state["X1"])
        // A deleted work task's item stays in the work account.
        let workLink: JSONValue = .object(["id": "X1", "list": "W", "list_title": "Work"])
        let gone = task(id, ["title": "Buy filament", "status": "inbox", "order": 1, "apple": workLink], deleted: true, space: .work)
        p = RemindersMerge.plan(items: [item(work: true)], tasks: [gone], state: ["X1": agreed], presentLists: ["W"], createsInApple: true, workOff: false, now: now)
        XCTAssertTrue(p.appleDeletes.isEmpty)
    }
}
