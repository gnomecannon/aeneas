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

}
