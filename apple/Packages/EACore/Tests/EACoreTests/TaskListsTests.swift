import XCTest
@testable import EACore

/// Choosing tasks by their Reminders list (TaskLists.swift): the same cases as packages/shared/test/taskLists.test.ts, so
/// the Apple apps, the web client and the hub choose the same tasks.
final class TaskListsTests: XCTestCase {
    private let todo = SourcesSetting.ReminderList(key: "icloud:iCloud/To-Do", title: "To-Do")
    private let shop = SourcesSetting.ReminderList(key: "icloud:iCloud/Shopping", title: "Shopping", was: ["icloud:iCloud/Groceries"])
    private let homework = SourcesSetting.ReminderList(key: "exchange:School/Homework", title: "Homework", kind: "exchange")
    private let homeworkToo = SourcesSetting.ReminderList(key: "icloud:iCloud/Homework", title: "Homework")
    private var lists: [SourcesSetting.ReminderList] { [todo, shop, homework, homeworkToo] }

    private func apple(_ a: [String: String], id: String = "r1") -> [String: JSONValue] {
        var link: [String: JSONValue] = ["id": .string(id), "list": .string(id.isEmpty ? "" : "L1")]
        for (k, v) in a { link[k] = .string(v) }
        return ["title": .string("x"), "apple": .object(link)]
    }
    private func match(_ chosen: [String], _ lists: [SourcesSetting.ReminderList]? = nil) -> TaskListMatch { TaskListMatch(chosen, lists: lists ?? self.lists) }

    func testATaskIsInTheChoiceByItsListsKeyAnOlderKeyOrItsListsName() {
        let inTodo = match([todo.key])
        XCTAssertTrue(inTodo.contains(fields: apple(["list_key": todo.key, "list_title": "To-Do"])))
        XCTAssertFalse(inTodo.contains(fields: apple(["list_key": shop.key, "list_title": "Shopping"])))
        // Linked before lists had keys: by its list's name.
        XCTAssertTrue(inTodo.contains(fields: apple(["list_title": "To-Do"])))
        XCTAssertFalse(inTodo.contains(fields: apple(["list_title": "Shopping"])))
        // Made in Aeneas inside a list, not yet added to Reminders: by the name too.
        XCTAssertTrue(inTodo.contains(fields: apple(["list_title": "To-Do"], id: "")))
        // In no list: only when the choice names `none`.
        XCTAssertFalse(inTodo.contains(fields: ["title": .string("Water the plants")]))
        XCTAssertFalse(inTodo.contains(fields: apple([:], id: "")))
        XCTAssertTrue(match([todo.key, ListChoices.noList]).contains(fields: ["title": .string("Water the plants")]))
        XCTAssertFalse(match([ListChoices.noList]).contains(fields: apple(["list_key": todo.key, "list_title": "To-Do"])))
        // A key from before the list was renamed finds it by `was`, and a choice made under the old key still holds.
        XCTAssertTrue(match([shop.key]).contains(fields: apple(["list_key": "icloud:iCloud/Groceries"])))
        XCTAssertTrue(match(["icloud:iCloud/Groceries"]).contains(fields: apple(["list_key": shop.key, "list_title": "Shopping"])))
        // A key whose list now has another name: an older app changed only the title, so the title decides.
        XCTAssertTrue(inTodo.contains(fields: apple(["list_key": shop.key, "list_title": "To-Do"])))
        XCTAssertFalse(inTodo.contains(fields: apple(["list_key": todo.key, "list_title": "Shopping"])))
        // A name two accounts share: in the choice when either list is.
        XCTAssertTrue(match([homework.key]).contains(fields: apple(["list_title": "Homework"])))
        XCTAssertTrue(match([homeworkToo.key]).contains(fields: apple(["list_title": "Homework"])))
        XCTAssertFalse(match([homework.key]).contains(fields: apple(["list_key": homeworkToo.key, "list_title": "Homework"])))
        // A list the setting has not heard of counts when the choice names its key, and not by its name alone.
        XCTAssertTrue(match(["caldav:Google/Errands"]).contains(fields: apple(["list_key": "caldav:Google/Errands", "list_title": "Errands"])))
        XCTAssertFalse(match(["caldav:Google/Errands"]).contains(fields: apple(["list_title": "Errands"])))
        XCTAssertTrue(match(["caldav:Google/Errands"], []).contains(fields: apple(["list_key": "caldav:Google/Errands"])))
        // Nothing chosen: no task.
        XCTAssertFalse(match([]).contains(fields: ["title": .string("x")]))
        XCTAssertFalse(match([]).contains(fields: apple(["list_key": todo.key])))
    }

    func testAChoiceKeepsItsRulesAndIsChangedOneListAtATime() {
        XCTAssertTrue(ListChoices.isValid([]))
        XCTAssertTrue(ListChoices.isValid([todo.key, ListChoices.noList]))
        XCTAssertTrue(ListChoices.isValid((0..<ListChoices.max).map { "icloud:iCloud/L\($0)" }))
        for bad in [[todo.key, todo.key], ["ab"], [String(repeating: "x", count: 301)], (0...ListChoices.max).map { "icloud:iCloud/L\($0)" }] {
            XCTAssertFalse(ListChoices.isValid(bad), "\(bad.prefix(2))")
        }
        XCTAssertTrue(ListChoices.isEntry(ListChoices.noList))
        XCTAssertTrue(ListChoices.isEntry(String(repeating: "x", count: 300)))

        var c = ["icloud:iCloud/Groceries", "local:On My iPhone/Packing"]
        XCTAssertTrue(ListChoices.contains(c, shop), "by the key it had before a rename")
        c = ListChoices.with(c, shop, false)
        XCTAssertEqual(c, ["local:On My iPhone/Packing"], "taken out with its older keys; a list not shown here stays")
        c = ListChoices.with(c, todo, true)
        c = ListChoices.with(c, todo, true)
        XCTAssertEqual(c, ["local:On My iPhone/Packing", todo.key], "added once")
        c = ListChoices.withNoList(c, true)
        XCTAssertEqual(ListChoices.withNoList(c, true), c)
        XCTAssertEqual(ListChoices.withNoList(c, false), ["local:On My iPhone/Packing", todo.key])
    }

    func testTheToDoCardsListsArePartOfTodaysSettingAndEveryEditKeepsThem() throws {
        func decode(_ json: String) -> TodaySetting? { try? JSONCoding.decode(TodaySetting.self, from: json) }
        let s = TodaySetting(order: ["now", "todo"], hidden: [], todoLists: [todo.key, ListChoices.noList])
        XCTAssertEqual(decode(#"{"order":["now","todo"],"hidden":[],"todo_lists":["icloud:iCloud/To-Do","none"]}"#), s)
        XCTAssertEqual(decode(#"{"order":[],"hidden":[],"todo_lists":null}"#), TodaySetting(order: [], hidden: []), "null asks for every list")
        XCTAssertEqual(decode(#"{"order":[],"hidden":[]}"#)?.todoLists, nil)
        XCTAssertEqual(decode(#"{"order":[],"hidden":[],"todo_lists":[]}"#)?.todoLists, [], "nothing chosen")
        for bad in [#""none""#, #"["icloud:iCloud/To-Do","icloud:iCloud/To-Do"]"#, #"["ab"]"#, "{}"] {
            XCTAssertNil(decode(#"{"order":[],"hidden":[],"todo_lists":\#(bad)}"#), bad)
        }
        // Moving, showing and hiding keep the choice.
        XCTAssertEqual(s.moving(.coming, to: 0).todoLists, [todo.key, ListChoices.noList])
        XCTAssertEqual(s.showing(.todo, false).todoLists, [todo.key, ListChoices.noList])
        XCTAssertEqual(s.withOrder([.todo]).todoLists, [todo.key, ListChoices.noList])
        XCTAssertEqual(s.moving(fromOffsets: IndexSet(integer: 0), toOffset: 3).todoLists, [todo.key, ListChoices.noList])
        // Always written, null for every list, so the hub hears a change back to every list.
        let all = String(decoding: try JSONEncoder().encode(TodaySetting.standard), as: UTF8.self)
        XCTAssertTrue(all.contains(#""todo_lists":null"#), all)
        let chosen = TodaySetting.standard.withTodoLists([todo.key])
        XCTAssertEqual(decode(String(decoding: try JSONEncoder().encode(chosen), as: UTF8.self)), chosen)
        XCTAssertEqual(chosen.order, TodaySetting.standard.order)
        XCTAssertNil(chosen.withTodoLists(nil).todoLists)
        XCTAssertNil(TodaySetting.standard.todoMatch(lists))
        XCTAssertEqual(chosen.todoMatch(lists)?.contains(fields: apple(["list_title": "To-Do"])), true)
        XCTAssertEqual(chosen.todoMatch(lists)?.contains(fields: apple(["list_title": "Shopping"])), false)
    }

    func testTheSummaryAndTheListsOffered() {
        let all = TodaySetting.standard
        XCTAssertEqual(TodayText.todoListsSummary(all, lists: lists), "All lists")
        XCTAssertEqual(TodayText.todoListsSummary(all.withTodoLists([]), lists: lists), "None")
        XCTAssertEqual(TodayText.todoListsSummary(all.withTodoLists([todo.key]), lists: lists), "To-Do")
        XCTAssertEqual(TodayText.todoListsSummary(all.withTodoLists([ListChoices.noList]), lists: lists), "No list")
        XCTAssertEqual(TodayText.todoListsSummary(all.withTodoLists(["icloud:iCloud/Gone"]), lists: lists), "1 list")
        XCTAssertEqual(TodayText.todoListsSummary(all.withTodoLists([todo.key, ListChoices.noList]), lists: lists), "2 lists")
        let off = SourcesSetting.ReminderList(key: "caldav:Google/Errands", title: "Errands", account: "Google", kind: "caldav", on: false)
        let ex = SourcesSetting.ReminderList(key: "exchange:/Homework", title: "Homework", account: "", kind: "exchange", space: .work)
        let a = SourcesSetting.ReminderList(key: "icloud:iCloud/To-Do", title: "To-Do", account: "iCloud")
        let b = SourcesSetting.ReminderList(key: "icloud:iCloud/Shopping", title: "Shopping", account: "iCloud")
        XCTAssertEqual(TodayText.choosable([a, off, b, ex]).map(\.title), ["Homework", "Shopping", "To-Do"])
    }

    // MARK: groups (the same cases as the groups tests in packages/shared/test/taskLists.test.ts)

    func testWhatASetOfTaskGroupsMustBeInTheWordsTheScreensShow() {
        let school = TaskGroup(id: "school", name: "School", lists: [homework.key, "icloud:iCloud/Reading"])
        let home = TaskGroup(id: "home", name: "Home", lists: [shop.key, ListChoices.noList])
        XCTAssertNil(TaskGroups.problem([]))
        XCTAssertNil(TaskGroups.problem([school, home]))
        XCTAssertNil(TaskGroups.problem([TaskGroup(id: "school", name: "School")]), "a group with no lists yet")
        let many = (0..<TaskGroups.max).map { TaskGroup(id: "g\($0)", name: "Group \($0)") }
        XCTAssertNil(TaskGroups.problem(many))
        func named(_ g: TaskGroup, id: String? = nil, name: String? = nil, lists: [String]? = nil) -> TaskGroup {
            TaskGroup(id: id ?? g.id, name: name ?? g.name, lists: lists ?? g.lists)
        }
        let cases: [([TaskGroup], String)] = [
            (many + [TaskGroup(id: "one-more", name: "One more")], TaskGroups.Problem.tooMany),
            ([named(school, id: "School")], TaskGroups.Problem.id),
            ([named(school, id: "")], TaskGroups.Problem.id),
            ([named(school, id: String(repeating: "x", count: 41))], TaskGroups.Problem.id),
            ([school, named(home, id: "school")], TaskGroups.Problem.id),
            ([named(school, name: "   ")], TaskGroups.Problem.noName),
            ([named(school, name: String(repeating: "x", count: 41))], TaskGroups.Problem.longName),
            ([named(school, name: " work ")], TaskGroups.Problem.reserved),
            ([named(school, name: "PERSONAL")], TaskGroups.Problem.reserved),
            ([school, named(home, name: "school ")], TaskGroups.Problem.taken),
            ([named(school, lists: [homework.key, homework.key])], TaskGroups.Problem.lists),
            ([named(school, lists: ["ab"])], TaskGroups.Problem.lists),
        ]
        for (groups, problem) in cases { XCTAssertEqual(TaskGroups.problem(groups), problem, "\(groups.map(\.name))") }
        // A name of 40 characters is fine, counted as characters, not as UTF-16 units.
        XCTAssertNil(TaskGroups.problem([named(school, name: String(repeating: "é", count: 40))]))
        XCTAssertNil(TaskGroups.problem([named(school, name: String(repeating: "📚", count: 40))]))
    }

    func testIdsForNewGroupsAndAddingRenamingAndDeletingOne() {
        let school = TaskGroup(id: "school", name: "School")
        XCTAssertEqual(TaskGroups.newId("School", groups: []), "school")
        XCTAssertEqual(TaskGroups.newId("School", groups: [school]), "school-2")
        XCTAssertEqual(TaskGroups.newId("School", groups: [school, TaskGroup(id: "school-2", name: "x")]), "school-3")
        XCTAssertEqual(TaskGroups.newId("École & Art!", groups: []), "ecole-art")
        XCTAssertEqual(TaskGroups.newId("📚", groups: []), "group")
        XCTAssertEqual(TaskGroups.newId(String(repeating: "a", count: 29) + " b", groups: []), String(repeating: "a", count: 29))
        var groups = TaskGroups.with([], school)
        groups = TaskGroups.with(groups, TaskGroup(id: "home", name: "Home", lists: [ListChoices.noList]))
        groups = TaskGroups.with(groups, TaskGroup(id: "school", name: "Classes", lists: [homework.key]))
        XCTAssertEqual(groups.map(\.name), ["Classes", "Home"], "renamed in its place")
        XCTAssertEqual(TaskGroups.without(groups, id: "school").map(\.id), ["home"])
        // A group shows the tasks of its lists, whichever space they are in.
        let inSchool = TaskListMatch(groups[0].lists, lists: lists)
        XCTAssertTrue(inSchool.contains(fields: apple(["list_key": homework.key, "list_title": "Homework"])))
        XCTAssertFalse(inSchool.contains(fields: apple(["list_key": todo.key, "list_title": "To-Do"])))
        XCTAssertFalse(inSchool.contains(fields: ["title": .string("Water the plants")]))
    }

    func testTheSourcesSettingCarriesTheGroupsAndDropsASetThatBreaksARule() throws {
        let ok = #"{"lists":[{"key":"exchange:School/Homework","title":"Homework","on":true,"space":"work"},{"key":"icloud:iCloud/Reading","title":"Reading","on":false}],"groups":[{"id":"school","name":"School","lists":["exchange:School/Homework","icloud:iCloud/Reading","none"]}]}"#
        let s = try JSONCoding.decode(SourcesSetting.self, from: ok)
        XCTAssertEqual(s.groups, [TaskGroup(id: "school", name: "School", lists: ["exchange:School/Homework", "icloud:iCloud/Reading", "none"])])
        XCTAssertEqual(s.group("school")?.name, "School")
        XCTAssertEqual(s.lists(in: s.groups[0]).map(\.title), ["Homework"], "only the lists that are on")
        XCTAssertEqual(try JSONCoding.decode(SourcesSetting.self, from: #"{"lists":[]}"#).groups, [], "an older hub has none")
        let twice = #"{"groups":[{"id":"a","name":"School","lists":[]},{"id":"b","name":"school","lists":[]}]}"#
        XCTAssertEqual(try JSONCoding.decode(SourcesSetting.self, from: twice).groups, [])
        // Kept on the device and read back the same.
        XCTAssertEqual(try JSONCoding.decode(SourcesSetting.self, from: String(decoding: JSONEncoder().encode(s), as: UTF8.self)), s)
    }
}
