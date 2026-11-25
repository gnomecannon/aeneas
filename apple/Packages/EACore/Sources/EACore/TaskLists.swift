import Foundation

/// Choosing tasks by the Apple Reminders list they are in: which lists fill Today's To do card (`todoLists` in Today's
/// setting, TodayParts.swift) and which lists a group on the Tasks screen shows (`groups` in the sources setting). A
/// choice is a list of list keys as the sources setting names them (`<kind>:<account>/<title>`), and `none` for the
/// tasks in no list (made in Aeneas and never added to Reminders). The same rules as
/// `packages/shared/src/taskLists.ts`, which the hub checks by and the web client draws by; tests on both sides keep
/// them the same.
public enum ListChoices {
    /// The choice for tasks in no Reminders list. No list key is this word: a key holds `:` and `/`.
    public static let noList = "none"
    /// How many lists one choice may name: as many as the sources setting keeps.
    public static let max = 300

    /// One entry of a choice: `none`, or a list key of 3 to 300 characters (UTF-16, as the hub counts).
    public static func isEntry(_ s: String) -> Bool { (3...300).contains(s.utf16.count) }

    /// Whether a choice keeps the rules: at most 300 entries, each named once.
    public static func isValid(_ chosen: [String]) -> Bool {
        chosen.count <= max && chosen.allSatisfy(isEntry) && Set(chosen).count == chosen.count
    }

    /// Whether a list is in a choice: by its key, or by a key it had before it or its account was renamed.
    public static func contains(_ chosen: [String], _ list: SourcesSetting.ReminderList) -> Bool {
        chosen.contains(list.key) || (list.was ?? []).contains { chosen.contains($0) }
    }

    /// A choice with a list added or taken out. Taking it out takes its older keys too; adding it adds its key once.
    /// Entries for lists not named stay, so lists this device does not show keep their place in the choice.
    public static func with(_ chosen: [String], _ list: SourcesSetting.ReminderList, _ on: Bool) -> [String] {
        let old = Set([list.key] + (list.was ?? []))
        let rest = chosen.filter { !old.contains($0) }
        return on && rest.count < max ? rest + [list.key] : rest
    }

    /// `none` added to a choice or taken out.
    public static func withNoList(_ chosen: [String], _ on: Bool) -> [String] {
        let rest = chosen.filter { $0 != noList }
        return on && rest.count < max ? rest + [noList] : rest
    }
}

/// The test for "is this task in one of the lists chosen", the same as `taskInLists` in packages/shared. A task names
/// its list by `apple.list_key`; one linked by an app from before 1.0.18 has only `apple.list_title`, and is in the
/// choice when any list of that name is. A key whose list now has another name is out of date (an older app changed
/// only the title), so the title decides, as for hidden tasks (`TaskVisibility`). A key from before a rename finds its
/// list by `was`; a key the setting has not heard of counts when the choice names it. A task with neither is in no
/// list: in the choice when it names `none`.
public struct TaskListMatch: Sendable {
    private let picked: Set<String>
    private let none: Bool
    private let byKey: [String: (title: String, picked: Bool)]
    private let byOldKey: [String: Bool]
    private let byTitle: [String: [Bool]]

    public init(_ chosen: [String], lists: [SourcesSetting.ReminderList]) {
        let p = Set(chosen)
        picked = p
        none = p.contains(ListChoices.noList)
        var k: [String: (String, Bool)] = [:], old: [String: Bool] = [:], t: [String: [Bool]] = [:]
        for l in lists {
            let isPicked = p.contains(l.key) || (l.was ?? []).contains { p.contains($0) }
            k[l.key] = (l.title, isPicked)
            for w in l.was ?? [] where old[w] == nil { old[w] = isPicked }
            t[l.title, default: []].append(isPicked)
        }
        byKey = k.mapValues { (title: $0.0, picked: $0.1) }; byOldKey = old; byTitle = t
    }

    public func contains(_ e: Entity) -> Bool { contains(fields: e.fields) }

    public func contains(fields: [String: JSONValue]) -> Bool {
        let a = fields["apple"]?.objectValue
        let key = a?["list_key"]?.stringValue ?? ""
        let title = a?["list_title"]?.stringValue ?? ""
        if key.isEmpty && title.isEmpty { return none }
        if !key.isEmpty {
            if let l = byKey[key] {
                if title.isEmpty || l.title == title { return l.picked }
            } else if let old = byOldKey[key] {
                return old
            } else if picked.contains(key) {
                return true
            }
        }
        guard !title.isEmpty else { return false }
        return (byTitle[title] ?? []).contains(true)
    }
}

// MARK: task groups

/// A group on the Tasks screen (gnomecannon/aeneas#26): a name, like School, and the lists in it. Choosing it shows only
/// the tasks of those lists, from Personal and Work alike. It is a view, not a space: it changes nothing about where a
/// task is kept or synced. Kept in the sources setting, one for every device (`groups`).
public struct TaskGroup: Codable, Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var lists: [String]
    public init(id: String, name: String, lists: [String] = []) { self.id = id; self.name = name; self.lists = lists }
}

/// The rules a set of groups keeps, the same as `taskGroupsProblem` in packages/shared, with the same words.
public enum TaskGroups {
    /// How many groups there may be.
    public static let max = 20
    /// How long a group's name may be, in characters (Unicode scalars, as the hub counts them).
    public static let nameMax = 40

    /// Why a set of groups is refused, in words the screens show as they are.
    public enum Problem {
        public static let shape = "Each group is an id, a name and its lists."
        public static let tooMany = "There can be 20 groups at most."
        public static let id = "Each group needs an id of its own."
        public static let noName = "Give the group a name."
        public static let longName = "A group's name is 40 characters at most."
        public static let taken = "Another group has this name."
        public static let reserved = "Personal and Work are taken. Give the group another name."
        public static let lists = "A group holds at most 300 lists, each named once."
    }

    private static func plain(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    /// Whether an id is one a group can have: lowercase letters, digits and `-`, 1 to 40.
    public static func isId(_ s: String) -> Bool {
        (1...40).contains(s.unicodeScalars.count) && s.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }

    /// Why a set of groups breaks a rule, or nil when it keeps them. Names are read trimmed.
    public static func problem(_ groups: [TaskGroup]) -> String? {
        if groups.count > max { return Problem.tooMany }
        var ids = Set<String>(), names = Set<String>()
        for g in groups {
            if !isId(g.id) || ids.contains(g.id) { return Problem.id }
            ids.insert(g.id)
            let name = g.name.trimmingCharacters(in: .whitespacesAndNewlines)
            if name.isEmpty { return Problem.noName }
            if name.unicodeScalars.count > nameMax { return Problem.longName }
            if ["personal", "work"].contains(plain(name)) { return Problem.reserved }
            if names.contains(plain(name)) { return Problem.taken }
            names.insert(plain(name))
            if !ListChoices.isValid(g.lists) { return Problem.lists }
        }
        return nil
    }

    /// An id for a new group: its name in lowercase letters and digits (accents dropped, anything else a `-`), at most
    /// 30, made unique among `groups` with `-2`, `-3`...; `group` when nothing is left.
    public static func newId(_ name: String, groups: [TaskGroup]) -> String {
        var out = "", dash = false
        for u in name.lowercased().decomposedStringWithCompatibilityMapping.unicodeScalars where !(0x300...0x36F).contains(u.value) {
            if ("a"..."z").contains(u) || ("0"..."9").contains(u) { out.unicodeScalars.append(u); dash = false }
            else if !dash { out += "-"; dash = true }
        }
        var base = String(out.trimmingCharacters(in: CharacterSet(charactersIn: "-")).prefix(30))
        while base.hasSuffix("-") { base.removeLast() }
        if base.isEmpty { base = "group" }
        var id = base, n = 2
        while groups.contains(where: { $0.id == id }) { id = "\(base)-\(n)"; n += 1 }
        return id
    }

    /// The groups with `group` in the place of the one with its id, or added at the end.
    public static func with(_ groups: [TaskGroup], _ group: TaskGroup) -> [TaskGroup] {
        groups.contains { $0.id == group.id } ? groups.map { $0.id == group.id ? group : $0 } : groups + [group]
    }

    /// The groups without the one with this id.
    public static func without(_ groups: [TaskGroup], id: String) -> [TaskGroup] { groups.filter { $0.id != id } }
}

/// What the Tasks selector and the group editor say: the same words as the web's (`TASK_GROUP_TEXT` in
/// web/src/components/TaskGroupEditor.tsx; web/src/views/Tasks.groups.test.ts keeps the two the same).
public enum TaskGroupText {
    public static let personal = "Personal"
    public static let work = "Work"
    public static let show = "Show"
    public static let newGroup = "New group"
    public static let editGroup = "Edit group"
    public static let name = "Name"
    public static let namePlaceholder = "School"
    public static let lists = "Lists"
    public static let note = "A group shows the tasks of the lists in it, from Personal and Work. It changes nothing about where they are kept or synced."
    public static let save = "Save"
    public static let cancel = "Cancel"
    public static let delete = "Delete group"
    public static let deleteAsk = "Delete this group? Its lists and their tasks stay as they are."
    public static let empty = "This group has no lists yet. Choose them with Edit group."
    public static let offline = "Connect to your hub to change groups."
}
