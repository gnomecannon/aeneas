import XCTest
@testable import EACore

/// The sources setting on the Apple devices (Sources.swift): which Reminders lists sync and show, Personal or Work per
/// list, the list for new tasks, the hub-wide work calendars and the one Contacts device.
final class SourcesTests: XCTestCase {
    let now = ISO.date("2026-11-24T12:00:00.000Z")!
    let shop = SourcesSetting.ReminderList(key: "icloud:iCloud/Shopping", title: "Shopping", account: "iCloud", kind: "icloud", on: false)
    let todo = SourcesSetting.ReminderList(key: "icloud:iCloud/To do", title: "To do", account: "iCloud", kind: "icloud", on: true)

    func item(_ ext: String, list: String = "Shopping", key: String = "icloud:iCloud/Shopping", on: Bool = true, work: Bool = false, title: String = "Oat milk",
              modified: String = "2026-11-24T11:00:00.000Z") -> ReminderItem {
        ReminderItem(externalId: ext, localId: "L-\(ext)", listId: "ID-\(list)", listTitle: list, listKey: key, listOn: on, isWork: work, title: title, modified: ISO.date(modified))
    }
    func task(_ id: String, _ f: [String: JSONValue], space: Space = .personal, spaceMoved: Bool = false, updated: String = "2026-11-24T10:00:00.000Z", deleted: Bool = false) -> Entity {
        var e = Entity(id: id, kind: .task, space: space, fields: f)
        e.updated_at = updated
        if spaceMoved { e.field_ts["space"] = updated }
        if deleted { e.deleted_at = updated }
        return e
    }
    func link(_ ext: String, list: String = "Shopping", key: String? = "icloud:iCloud/Shopping") -> JSONValue {
        var o: [String: JSONValue] = ["id": .string(ext), "list": .string("ID-\(list)"), "list_title": .string(list)]
        if let key { o["list_key"] = .string(key) }
        return .object(o)
    }

    // MARK: the rule for hidden tasks

    func testTheRuleForHiddenTasksIsTheHubs() {
        var renamed = shop
        renamed.was = ["icloud:iCloud/Groceries"]
        let lists = [renamed, .init(key: "exchange:School/Tasks", title: "Tasks", kind: "exchange", on: false), .init(key: "icloud:iCloud/Tasks", title: "Tasks", on: true)]
        let v = TaskVisibility(lists: lists)
        func shows(_ apple: [String: JSONValue]?) -> Bool { v.shows(fields: apple.map { ["apple": .object($0)] } ?? ["title": "x"]) }
        XCTAssertTrue(shows(nil))
        XCTAssertFalse(shows(["id": "1", "list_key": "icloud:iCloud/Shopping", "list_title": "Shopping"]))
        XCTAssertFalse(shows(["id": "1", "list_title": "Shopping"]), "an older app's link: by name")
        XCTAssertFalse(shows(["id": "1", "list_key": "icloud:iCloud/Groceries", "list_title": "Groceries"]), "a key from before a rename")
        XCTAssertTrue(shows(["id": "1", "list_title": "Tasks"]), "two lists of that name, one on")
        XCTAssertFalse(shows(["id": "1", "list_key": "exchange:School/Tasks", "list_title": "Tasks"]))
        XCTAssertFalse(shows(["id": "", "list_title": "Shopping"]), "made in the app inside a list that is off")
        XCTAssertTrue(shows(["id": "1", "list_title": "Unknown"]), "a list the setting has not heard of hides nothing")
        XCTAssertTrue(TaskVisibility(nil).shows(fields: ["apple": .object(["list_title": "Shopping"])]))
        // Only tasks.
        XCTAssertTrue(v.shows(Entity(id: "n", kind: .note, fields: ["apple": .object(["list_title": "Shopping"])])))
    }

    @MainActor
    func testTheEngineLeavesHiddenTasksOutOfEveryListAndBringsThemBack() async throws {
        let engine = SyncEngine(config: SharedConfig(suiteName: "eacore-sources-\(UUID().uuidString)"), platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        await engine.absorb([task("t1", ["title": "Oat milk", "status": "next", "order": 1, "apple": link("A1")]),
                             task("t2", ["title": "Call the plumber", "status": "next", "order": 2, "apple": link("A2", list: "To do", key: "icloud:iCloud/To do")]),
                             task("t3", ["title": "Water the plants", "status": "next", "order": 3])])
        XCTAssertEqual(engine.tasks.count, 3)
        engine.adoptSources(SourcesSetting(lists: [shop, todo]))
        XCTAssertEqual(Set(engine.tasks.map(\.id)), ["t2", "t3"])
        XCTAssertNotNil(engine.get("t1"), "still held here, whole")
        XCTAssertEqual(engine.config.sources?.lists.count, 2, "kept for offline")
        engine.adoptSources(nil)
        XCTAssertEqual(engine.tasks.count, 3)
    }

    // MARK: Reminders

    func testDefaultsKeepAHubThatAlreadySyncsAsItWas() {
        // No setting (a hub before 1.0.18): every list syncs in its account's space.
        XCTAssertEqual(SourcesSetting.choice(nil, key: "exchange:Work/Tasks", kind: "exchange", accountWork: true, hasTasks: false), ReminderListChoice(on: true, space: .work))
        let s = SourcesSetting(lists: [shop])
        // Never heard of: on in iCloud or on the device itself, or with tasks; off elsewhere.
        XCTAssertTrue(SourcesSetting.choice(s, key: "icloud:iCloud/New", kind: "icloud", accountWork: false, hasTasks: false).on)
        XCTAssertTrue(SourcesSetting.choice(s, key: "local:On My iPhone/Packing", kind: "local", accountWork: false, hasTasks: false).on)
        XCTAssertFalse(SourcesSetting.choice(s, key: "caldav:Google/Errands", kind: "caldav", accountWork: false, hasTasks: false).on)
        XCTAssertTrue(SourcesSetting.choice(s, key: "exchange:School/Homework", kind: "exchange", accountWork: true, hasTasks: true).on)
        // Known: the hub's choice, in the space in effect.
        var chosen = todo
        chosen.space = .work
        XCTAssertEqual(SourcesSetting.choice(SourcesSetting(lists: [shop, chosen]), key: chosen.key, kind: "icloud", accountWork: false, hasTasks: true), ReminderListChoice(on: true, space: .work))
        XCTAssertFalse(SourcesSetting.choice(SourcesSetting(lists: [shop]), key: shop.key, kind: "icloud", accountWork: false, hasTasks: true).on)
    }

    func testAListThatIsOffIsNeitherReadNorWrittenAndCarriesOnWithNoDoublesWhenOnAgain() {
        let off = TaskVisibility(lists: [shop, todo])
        let id = RemindersMerge.taskId(forExternal: "A1")
        let agreed = SyncedReminder(taskId: id, localId: "L-A1", fields: RemindersMerge.fields(of: item("A1")).merging([RemindersMerge.listKey: "Shopping"]) { _, b in b })
        // Done in the app (another device, an older app) and renamed in Apple Reminders, while the list is off.
        let milk = task(id, ["title": "Oat milk", "status": "done", "order": 1, "apple": link("A1")])
        let renamed = item("A1", on: false, title: "Oat milk, 2 cartons")
        // Made in the app inside the list that is off; and a hidden task whose Apple item is gone.
        let stamps = task("t-stamps", ["title": "Stamps", "status": "next", "order": 2, "apple": .object(["id": "", "list": "", "list_title": "Shopping"])])
        let gone = task("t-gone", ["title": "Eggs", "status": "next", "order": 3, "apple": link("A9")])
        let goneRec = SyncedReminder(taskId: "t-gone", localId: "L-A9", fields: ["title": "Eggs", "done": "0", RemindersMerge.listKey: "Shopping"])
        let p = RemindersMerge.plan(items: [renamed], tasks: [milk, stamps, gone], state: ["A1": agreed, "A9": goneRec], presentLists: ["ID-Shopping"],
                                    createsInApple: true, workOff: false, shows: { off.shows($0) }, now: now)
        XCTAssertTrue(p.taskPatches.isEmpty, "nothing about its tasks changes: \(p.taskPatches)")
        XCTAssertTrue(p.appleWrites.isEmpty && p.appleDeletes.isEmpty && p.appleCreates.isEmpty && p.appleMoves.isEmpty, "nothing changes in Apple Reminders")
        XCTAssertEqual(p.state["A1"], agreed, "its record stays as it was")
        XCTAssertEqual(p.state["A9"], goneRec)

        // On again: both changes go across, against the record kept, and no second task or item is made.
        let on = RemindersMerge.plan(items: [item("A1", title: "Oat milk, 2 cartons")], tasks: [milk, stamps], state: p.state, presentLists: ["ID-Shopping"],
                                     createsInApple: false, workOff: false, now: now)
        XCTAssertEqual(on.taskPatches.count, 1)
        XCTAssertEqual(on.taskPatches[0].id, id)
        XCTAssertEqual(on.taskPatches[0].fields["title"]?.stringValue, "Oat milk, 2 cartons")
        XCTAssertNil(on.taskPatches[0].create)
        XCTAssertEqual(on.appleWrites.map(\.fields), [["done": "1"]])
    }

    func testAListThatIsOffOnlyTeachesALinkItsKey() {
        let id = RemindersMerge.taskId(forExternal: "A1")
        let agreed = SyncedReminder(taskId: id, localId: "L-A1", fields: RemindersMerge.fields(of: item("A1")))
        // Linked by an older app: the list's name only. Its link learns the key, so every device can tell it is off.
        let old = task(id, ["title": "Oat milk", "status": "next", "order": 1, "apple": link("A1", key: nil)])
        let p = RemindersMerge.plan(items: [item("A1", on: false)], tasks: [old], state: ["A1": agreed], presentLists: [], createsInApple: false, workOff: false, now: now)
        XCTAssertEqual(p.taskPatches.map { $0.fields.keys.sorted() }, [["apple"]])
        XCTAssertEqual(p.taskPatches.first?.fields["apple"]?.objectValue?["list_key"]?.stringValue, "icloud:iCloud/Shopping")
        // In a list that is on, too; but a key another device wrote is left as it is.
        var other = old
        other.fields["apple"] = link("A1", key: "icloud:Other name/Shopping")
        let q = RemindersMerge.plan(items: [item("A1")], tasks: [other], state: ["A1": agreed], presentLists: [], createsInApple: false, workOff: false, now: now)
        XCTAssertTrue(q.taskPatches.isEmpty)
        let r = RemindersMerge.plan(items: [item("A1")], tasks: [old], state: ["A1": agreed], presentLists: [], createsInApple: false, workOff: false, now: now)
        XCTAssertEqual(r.taskPatches.first?.fields["apple"]?.objectValue?["list_key"]?.stringValue, "icloud:iCloud/Shopping")
    }

    func testAListSetToWorkKeepsItsItemsAndNewItemsComeInAsWork() {
        // The hub moved the list's tasks to Work (a move leaves its stamp). Its items are Work now: nothing is deleted.
        let id = RemindersMerge.taskId(forExternal: "A1")
        let agreed = SyncedReminder(taskId: id, localId: "L-A1", fields: RemindersMerge.fields(of: item("A1", list: "Office", key: "icloud:iCloud/Office")))
        let moved = task(id, ["title": "Oat milk", "status": "next", "order": 1, "apple": link("A1", list: "Office", key: "icloud:iCloud/Office")], space: .work, spaceMoved: true)
        let p = RemindersMerge.plan(items: [item("A1", list: "Office", key: "icloud:iCloud/Office", work: true), item("A2", list: "Office", key: "icloud:iCloud/Office", work: true, title: "Badge")],
                                    tasks: [moved], state: ["A1": agreed], presentLists: ["ID-Office"], createsInApple: false, workOff: false, now: now)
        XCTAssertTrue(p.appleDeletes.isEmpty)
        XCTAssertEqual(p.taskPatches.filter { $0.create == true }.map(\.space), [.work])
        // Not read from the hub this run (an older copy may still say Personal): nothing is deleted for the move.
        let held = RemindersMerge.plan(items: [item("A1", list: "Office", key: "icloud:iCloud/Office")], tasks: [moved], state: ["A1": agreed], presentLists: ["ID-Office"],
                                       createsInApple: false, workOff: false, moveDeletes: false, now: now)
        XCTAssertTrue(held.appleDeletes.isEmpty)
        // One task moved to Work by hand from a personal list: its item leaves the list, as before (1.0.16).
        let byHand = RemindersMerge.plan(items: [item("A1", list: "Office", key: "icloud:iCloud/Office")], tasks: [moved], state: ["A1": agreed], presentLists: ["ID-Office"],
                                         createsInApple: false, workOff: false, now: now)
        XCTAssertEqual(byHand.appleDeletes, ["L-A1"])
        // A list set to Work while the work space is off is not synced, and its records stay.
        let off = RemindersMerge.plan(items: [item("A1", list: "Office", key: "icloud:iCloud/Office", work: true)], tasks: [moved], state: ["A1": agreed], presentLists: ["ID-Office"],
                                      createsInApple: false, workOff: true, now: now)
        XCTAssertTrue(off.taskPatches.isEmpty && off.appleDeletes.isEmpty)
        XCTAssertEqual(off.state["A1"], agreed)
    }

    func testNewTasksGoToTheChosenListAndNeverIntoOneThatIsOff() {
        let t = task("t-new", ["title": "Post the letter", "status": "next", "order": 1])
        let chosen = RemindersMerge.plan(items: [], tasks: [t], state: [:], presentLists: [], createsInApple: true, workOff: false, newTasksList: "To do", now: now)
        XCTAssertEqual(chosen.appleCreates.map(\.listTitle), ["To do"])
        let fallback = RemindersMerge.plan(items: [], tasks: [t], state: [:], presentLists: [], createsInApple: true, workOff: false, now: now)
        XCTAssertEqual(fallback.appleCreates.map(\.listTitle), [nil], "the default list, as before")
        let none = RemindersMerge.plan(items: [], tasks: [t], state: [:], presentLists: [], createsInApple: true, workOff: false, defaultListOn: false, now: now)
        XCTAssertTrue(none.appleCreates.isEmpty, "the default list is off and no list is chosen: the task stays in the app")
        // A task made inside a list keeps its list.
        let inList = task("t-in", ["title": "Bread", "status": "next", "order": 1, "apple": .object(["id": "", "list": "", "list_title": "Groceries"])])
        XCTAssertEqual(RemindersMerge.plan(items: [], tasks: [inList], state: [:], presentLists: [], createsInApple: true, workOff: false, newTasksList: "To do", now: now).appleCreates.map(\.listTitle), ["Groceries"])
    }

    // MARK: the setting, the hub's answer and what devices report

    func testTheHubsAnswerDecodesAndComesOverTheLiveStream() throws {
        let json = ##"{"lists":[{"key":"icloud:iCloud/Shopping","title":"Shopping","account":"iCloud","kind":"icloud","on":false,"space":"personal","work_default":false,"wants":"work","was":["icloud:iCloud/Groceries"],"devices":["d1"]}],"new_tasks":null,"calendars":[{"key":"exchange:Work/Meetings","title":"Meetings","account":"Work","kind":"exchange","color":"#3366FF","work":true,"hub_kept":false,"devices":["d1"]}],"contacts":{"device":"d2","name":"Mac"},"waiting":[{"id":"d3","name":"iPad","platform":"ipad","version":"1.0.17"}],"needs":"1.0.18","later":"ignored"}"##
        let s = try JSONCoding.decode(SourcesSetting.self, from: Data(json.utf8))
        XCTAssertEqual(s.lists.first?.wants, .work)
        XCTAssertEqual(s.lists.first?.was, ["icloud:iCloud/Groceries"])
        XCTAssertEqual(s.calendars.first?.work, true)
        XCTAssertEqual(s.contacts, .init(device: "d2", name: "Mac"))
        XCTAssertEqual(s.waiting.map(\.version), ["1.0.17"])
        guard case .sources(let live) = HubClient.liveEvent(SSEMessage(event: "sources", data: json)) else { return XCTFail("not a sources event") }
        XCTAssertEqual(live, s)
        // A partial answer still reads.
        XCTAssertEqual(try JSONCoding.decode(SourcesSetting.self, from: Data(#"{"lists":[{"key":"k","title":"T"}]}"#.utf8)).lists.first?.on, true)
    }

    func testKeysAndKinds() {
        XCTAssertEqual(SourceKey.make(kind: "icloud", account: "iCloud", title: "Shopping"), "icloud:iCloud/Shopping")
        XCTAssertEqual(SourceKey.kind(sourceType: 2, accountTitle: "iCloud"), "icloud")
        XCTAssertEqual(SourceKey.kind(sourceType: 2, accountTitle: "Google"), "caldav")
        XCTAssertEqual(SourceKey.kind(sourceType: 0, accountTitle: "On My iPhone"), "local")
        XCTAssertEqual(SourceKey.kind(sourceType: 1, accountTitle: "School"), "exchange")
        XCTAssertEqual(SourceKey.kind(sourceType: 4, accountTitle: "Holidays"), "subscribed")
        var m = SourcesReportMemory()
        XCTAssertTrue(m.due("a"))
        m.keys = ["ID1": "icloud:iCloud/Groceries"]; m.print = "a"; m.at = now
        XCTAssertEqual(m.was(id: "ID1", key: "icloud:iCloud/Shopping"), "icloud:iCloud/Groceries", "renamed here: its choices go with it")
        XCTAssertNil(m.was(id: "ID1", key: "icloud:iCloud/Groceries"))
        XCTAssertFalse(m.due("a", now: now.addingTimeInterval(3600)))
        XCTAssertTrue(m.due("b", now: now.addingTimeInterval(3600)))
        XCTAssertTrue(m.due("a", now: now.addingTimeInterval(2 * 86_400)))
    }

    // MARK: Calendars

    func testWorkCalendarsAreOneChoiceAndADevicesOwnTicksMoveOnce() {
        let meetings = CalendarInfo(id: "C1", title: "Meetings", sourceTitle: "Work", isExchange: true)
        let family = CalendarInfo(id: "C2", title: "Family", sourceTitle: "iCloud", isExchange: false, kind: "icloud")
        let standups = CalendarInfo(id: "C3", title: "Standups", sourceTitle: "Work", isExchange: true)
        XCTAssertEqual(meetings.sourceKey, "exchange:Work/Meetings")
        // Its own ticks, once; a device that never chose sends what its first run would pick.
        XCTAssertEqual(WorkCalendarMove.ticked(chosen: ["C2"], calendars: [meetings, family, standups], workDomain: nil), ["icloud:iCloud/Family"])
        XCTAssertEqual(WorkCalendarMove.ticked(chosen: nil, calendars: [meetings, family, standups], workDomain: nil), ["exchange:Work/Meetings", "exchange:Work/Standups"])
        // Each device imports the chosen calendars it has; one the hub keeps in step itself never.
        let s = SourcesSetting(calendars: [.init(key: "exchange:Work/Meetings", title: "Meetings", work: true),
                                           .init(key: "icloud:iCloud/Family", title: "Family", kind: "icloud", work: true, hub_kept: true),
                                           .init(key: "exchange:Work/Standups", title: "Standups", work: false),
                                           .init(key: "exchange:Work/Elsewhere", title: "Elsewhere", work: true)])
        XCTAssertEqual(s.workCalendarIds([meetings, family, standups]), ["C1"])
    }

    // MARK: Contacts

    func testContactsAreMirroredByOneDeviceAtATime() {
        func setting(_ device: String?, _ name: String? = nil) -> SourcesSetting { SourcesSetting(contacts: .init(device: device, name: name)) }
        // A hub before 1.0.18: each device by its own switch, as before.
        XCTAssertEqual(ContactsDevice.step(localOn: true, wasOn: nil, setting: nil, me: "me"), .mirror)
        // Switched on here: this device is the one, even when another was.
        XCTAssertEqual(ContactsDevice.step(localOn: true, wasOn: false, setting: setting("other"), me: "me"), .claim)
        XCTAssertEqual(ContactsDevice.step(localOn: true, wasOn: nil, setting: setting(nil), me: "me"), .claim)
        XCTAssertEqual(ContactsDevice.step(localOn: true, wasOn: true, setting: setting("me"), me: "me"), .mirror)
        // Another device took them over: this one stops and says which.
        XCTAssertEqual(ContactsDevice.step(localOn: true, wasOn: true, setting: setting("other", "Mac"), me: "me"), .stop(otherName: "Mac"))
        XCTAssertEqual(ContactsDevice.step(localOn: true, wasOn: nil, setting: setting("other", "Mac"), me: "me"), .stop(otherName: "Mac"))
        // Switched off on the one device: none mirrors them now. Off elsewhere: nothing to do.
        XCTAssertEqual(ContactsDevice.step(localOn: false, wasOn: true, setting: setting("me"), me: "me"), .release)
        XCTAssertEqual(ContactsDevice.step(localOn: false, wasOn: false, setting: setting("other"), me: "me"), .idle)
    }
}
