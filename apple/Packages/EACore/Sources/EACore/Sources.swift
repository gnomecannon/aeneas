import Foundation

/// Which Apple Reminders lists, calendars and Contacts come into the app from each device: one setting for every
/// device, kept by the hub (`GET /prefs/sources`, contract "Sources"). Reminders: each list is on or off and Personal
/// or Work, and one list takes the tasks made in the app. Calendars: which calendars are work. Contacts: the one
/// device that mirrors them. The hub keeps the catalog of lists and calendars the devices said they see, so every
/// device shows the same chooser.
public struct SourcesSetting: Codable, Equatable, Sendable {
    public struct ReminderList: Codable, Equatable, Sendable, Identifiable {
        public var key: String
        public var title: String
        public var account: String
        /// `icloud`, `local`, `exchange`, `caldav`, `subscribed`, `birthdays` or `other` (`SourceKey.kind`).
        public var kind: String
        /// Off: its tasks are hidden everywhere and no device reads or writes it.
        public var on: Bool
        /// The space its tasks are in now.
        public var space: Space
        /// The account's own space: Exchange, or an account named after the work email's domain, is Work.
        public var work_default: Bool
        /// The space the owner chose, while it waits for every iPhone, iPad and Mac to run `needs`.
        public var wants: Space?
        /// The keys it had before it or its account was renamed.
        public var was: [String]?
        /// The devices that see it.
        public var devices: [String]
        public var id: String { key }

        public init(key: String, title: String, account: String = "", kind: String = "icloud", on: Bool = true, space: Space = .personal,
                    work_default: Bool = false, wants: Space? = nil, was: [String]? = nil, devices: [String] = []) {
            self.key = key; self.title = title; self.account = account; self.kind = kind; self.on = on; self.space = space
            self.work_default = work_default; self.wants = wants; self.was = was; self.devices = devices
        }

        enum CodingKeys: String, CodingKey { case key, title, account, kind, on, space, work_default, wants, was, devices }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            key = try c.decode(String.self, forKey: .key)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            account = (try? c.decodeIfPresent(String.self, forKey: .account)) ?? ""
            kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "other"
            on = (try? c.decodeIfPresent(Bool.self, forKey: .on)) ?? true
            space = (try? c.decodeIfPresent(Space.self, forKey: .space)) ?? .personal
            work_default = (try? c.decodeIfPresent(Bool.self, forKey: .work_default)) ?? false
            wants = try? c.decodeIfPresent(Space.self, forKey: .wants)
            was = try? c.decodeIfPresent([String].self, forKey: .was)
            devices = (try? c.decodeIfPresent([String].self, forKey: .devices)) ?? []
        }
    }

    public struct WorkCalendar: Codable, Equatable, Sendable, Identifiable {
        public var key: String
        public var title: String
        public var account: String
        public var kind: String
        public var color: String?
        public var work: Bool
        /// The hub keeps this iCloud calendar in step itself (Connections, Internet Accounts), so it is never work.
        public var hub_kept: Bool
        public var devices: [String]
        public var id: String { key }

        public init(key: String, title: String, account: String = "", kind: String = "exchange", color: String? = nil, work: Bool = false,
                    hub_kept: Bool = false, devices: [String] = []) {
            self.key = key; self.title = title; self.account = account; self.kind = kind; self.color = color; self.work = work
            self.hub_kept = hub_kept; self.devices = devices
        }

        enum CodingKeys: String, CodingKey { case key, title, account, kind, color, work, hub_kept, devices }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            key = try c.decode(String.self, forKey: .key)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            account = (try? c.decodeIfPresent(String.self, forKey: .account)) ?? ""
            kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "other"
            color = try? c.decodeIfPresent(String.self, forKey: .color)
            work = (try? c.decodeIfPresent(Bool.self, forKey: .work)) ?? false
            hub_kept = (try? c.decodeIfPresent(Bool.self, forKey: .hub_kept)) ?? false
            devices = (try? c.decodeIfPresent([String].self, forKey: .devices)) ?? []
        }
    }

    public struct Contacts: Codable, Equatable, Sendable {
        /// The device that mirrors Apple Contacts, nil while none does.
        public var device: String?
        public var name: String?
        public init(device: String? = nil, name: String? = nil) { self.device = device; self.name = name }
    }

    /// An iPhone, iPad or Mac that does not run `needs` yet.
    public struct Waiting: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var platform: String
        public var version: String?
        public init(id: String, name: String, platform: String, version: String? = nil) { self.id = id; self.name = name; self.platform = platform; self.version = version }
    }

    public var lists: [ReminderList]
    /// The key of the list tasks made in Aeneas go to; nil means each device's default list.
    public var new_tasks: String?
    public var calendars: [WorkCalendar]
    public var contacts: Contacts
    public var waiting: [Waiting]
    /// The app version a Personal or Work choice waits for.
    public var needs: String
    /// The owner's groups on the Tasks screen (gnomecannon/aeneas#26), in their order; none from an older hub, or when
    /// the hub's set breaks a rule (`TaskGroups.problem`).
    public var groups: [TaskGroup]

    public init(lists: [ReminderList] = [], new_tasks: String? = nil, calendars: [WorkCalendar] = [], contacts: Contacts = Contacts(), waiting: [Waiting] = [], needs: String = "1.0.18", groups: [TaskGroup] = []) {
        self.lists = lists; self.new_tasks = new_tasks; self.calendars = calendars; self.contacts = contacts; self.waiting = waiting; self.needs = needs
        self.groups = groups
    }

    enum CodingKeys: String, CodingKey { case lists, new_tasks, calendars, contacts, waiting, needs, groups }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        lists = (try? c.decodeIfPresent([ReminderList].self, forKey: .lists)) ?? []
        new_tasks = try? c.decodeIfPresent(String.self, forKey: .new_tasks)
        calendars = (try? c.decodeIfPresent([WorkCalendar].self, forKey: .calendars)) ?? []
        contacts = (try? c.decodeIfPresent(Contacts.self, forKey: .contacts)) ?? Contacts()
        waiting = (try? c.decodeIfPresent([Waiting].self, forKey: .waiting)) ?? []
        needs = (try? c.decodeIfPresent(String.self, forKey: .needs)) ?? "1.0.18"
        let g = (try? c.decodeIfPresent([TaskGroup].self, forKey: .groups)) ?? []
        groups = TaskGroups.problem(g) == nil ? g : []
    }

    public func list(_ key: String) -> ReminderList? { lists.first { $0.key == key } }
    public func group(_ id: String) -> TaskGroup? { groups.first { $0.id == id } }

    /// The lists of a group that are on, by name: what its chips offer on Tasks.
    public func lists(in group: TaskGroup) -> [ReminderList] {
        lists.filter { $0.on && ListChoices.contains(group.lists, $0) }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }
    public func calendar(_ key: String) -> WorkCalendar? { calendars.first { $0.key == key } }
}

/// How a list or calendar is named the same way on every device: its account's kind and name and its own title. The
/// account's name is what the device calls it (an Exchange account's description can differ from one device to
/// another), so it is the best there is, not a promise.
public enum SourceKey {
    public static func make(kind: String, account: String, title: String) -> String { "\(kind):\(account)/\(title)" }

    /// The kind of an account from EventKit's source type (`EKSourceType.rawValue`) and the account's name: iCloud is a
    /// CalDAV account named iCloud (or the older MobileMe type).
    public static func kind(sourceType: Int, accountTitle: String) -> String {
        switch sourceType {
        case 0: return "local"
        case 1: return "exchange"
        case 2: return accountTitle.trimmingCharacters(in: .whitespaces).caseInsensitiveCompare("iCloud") == .orderedSame ? "icloud" : "caldav"
        case 3: return "icloud"
        case 4: return "subscribed"
        case 5: return "birthdays"
        default: return "other"
        }
    }
}

/// The one rule for "does this task show" on the Apple devices, the same as `taskFilter` in packages/shared (the hub
/// and the web app): a task is hidden only while it is in an Apple Reminders list that is switched off. The task names
/// its list by `apple.list_key`; one linked by an app from before 1.0.18 has only `apple.list_title`, and is hidden when
/// every list of that name is off. A key from before a rename finds the list by its `was`. A list the setting has not
/// heard of hides nothing.
public struct TaskVisibility: Sendable {
    private let anyOff: Bool
    private let byKey: [String: (title: String, on: Bool)]
    private let byOldKey: [String: Bool]
    private let byTitle: [String: [Bool]]

    public init(lists: [SourcesSetting.ReminderList]) {
        anyOff = lists.contains { !$0.on }
        var k: [String: (String, Bool)] = [:], old: [String: Bool] = [:], t: [String: [Bool]] = [:]
        for l in lists {
            k[l.key] = (l.title, l.on)
            for w in l.was ?? [] where old[w] == nil { old[w] = l.on }
            t[l.title, default: []].append(l.on)
        }
        byKey = k.mapValues { (title: $0.0, on: $0.1) }; byOldKey = old; byTitle = t
    }

    public init(_ setting: SourcesSetting?) { self.init(lists: setting?.lists ?? []) }

    public func shows(_ e: Entity) -> Bool { e.kind != .task || shows(fields: e.fields) }

    public func shows(fields: [String: JSONValue]) -> Bool {
        guard anyOff, let a = fields["apple"]?.objectValue else { return true }
        let key = a["list_key"]?.stringValue ?? ""
        let title = a["list_title"]?.stringValue ?? ""
        if !key.isEmpty {
            if let l = byKey[key] {
                if title.isEmpty || l.title == title { return l.on }
            } else if let on = byOldKey[key] {
                return on
            }
        }
        guard !title.isEmpty, let named = byTitle[title] else { return true }
        return named.contains(true)
    }
}

/// What a device does with one of its own Reminders lists.
public struct ReminderListChoice: Equatable, Sendable {
    /// Synced (read and written) by this device.
    public var on: Bool
    /// The space its tasks are in.
    public var space: Space
    public init(on: Bool, space: Space) { self.on = on; self.space = space }
}

extension SourcesSetting {
    /// A list never seen with tasks is on when it is in iCloud or on the device itself, and off in any other account
    /// (Exchange, Google, other CalDAV, subscribed) until the owner picks it. The hub decides the same way when it
    /// first hears of a list.
    public static func defaultOn(kind: String, hasTasks: Bool) -> Bool { hasTasks || kind == "icloud" || kind == "local" }

    /// What this device does with a list it sees. With no setting (a hub from before 1.0.18) every list syncs in its
    /// account's space, as before. A list the hub has not heard of yet gets the defaults.
    public static func choice(_ setting: SourcesSetting?, key: String, kind: String, accountWork: Bool, hasTasks: Bool) -> ReminderListChoice {
        let own: Space = accountWork ? .work : .personal
        guard let setting else { return ReminderListChoice(on: true, space: own) }
        guard let l = setting.list(key) else { return ReminderListChoice(on: defaultOn(kind: kind, hasTasks: hasTasks), space: own) }
        return ReminderListChoice(on: l.on, space: l.space)
    }

    /// The work calendars this device imports: those of its own calendars the hub-wide choice marks as work (never one
    /// the hub keeps in step itself), by this device's calendar ids.
    public func workCalendarIds(_ calendars: [CalendarInfo]) -> Set<String> {
        let work = Set(self.calendars.filter { $0.work && !$0.hub_kept }.map(\.key))
        return Set(calendars.filter { work.contains($0.sourceKey) }.map(\.id))
    }
}

/// A list or calendar as a device reports it (`PUT /prefs/sources/seen`).
public struct SeenList: Codable, Equatable, Sendable {
    public var key: String
    public var title: String
    public var account: String
    public var kind: String
    public var work: Bool
    public var has_tasks: Bool?
    public var was: String?
    public init(key: String, title: String, account: String, kind: String, work: Bool, has_tasks: Bool? = nil, was: String? = nil) {
        self.key = key; self.title = title; self.account = account; self.kind = kind; self.work = work; self.has_tasks = has_tasks; self.was = was
    }
}

public struct SeenCalendar: Codable, Equatable, Sendable {
    public var key: String
    public var title: String
    public var account: String
    public var kind: String
    public var color: String?
    public var was: String?
    public init(key: String, title: String, account: String, kind: String, color: String? = nil, was: String? = nil) {
        self.key = key; self.title = title; self.account = account; self.kind = kind; self.color = color; self.was = was
    }
}

public struct SourcesReport: Codable, Equatable, Sendable {
    public var lists: [SeenList]?
    public var calendars: [SeenCalendar]?
    /// The calendars this device marked as work itself before the choice was one for all devices: sent once.
    public var ticked: [String]?
    public init(lists: [SeenList]? = nil, calendars: [SeenCalendar]? = nil, ticked: [String]? = nil) { self.lists = lists; self.calendars = calendars; self.ticked = ticked }
}

/// What this device last told the hub it sees, so a list or calendar renamed here carries its choices to its new
/// key (`was`), and an unchanged catalog is not sent again within a day. Kept on the device, by its own ids.
public struct SourcesReportMemory: Codable, Equatable, Sendable {
    /// This device's list or calendar id to the key last reported for it.
    public var keys: [String: String] = [:]
    /// What was sent, to tell when it changed.
    public var print: String = ""
    public var at: Date?
    public init() {}

    /// The key a list or calendar had before, when it was reported under another one.
    public func was(id: String, key: String) -> String? { keys[id].flatMap { $0 == key ? nil : $0 } }

    /// Whether a report with this print is due: it differs from the last one, or a day passed.
    public func due(_ print: String, now: Date = Date()) -> Bool { print != self.print || at.map { now.timeIntervalSince($0) > 86_400 } ?? true }
}

/// The one device that mirrors Apple Contacts. Switching Contacts sync on on a device makes it the one; another device
/// that had it on stops (and its switch shows off), and says which device mirrors them.
public enum ContactsDevice {
    public enum Step: Equatable, Sendable {
        /// This device mirrors Contacts.
        case mirror
        /// Tell the hub this device is the one, then mirror.
        case claim
        /// The switch went off here while this device was the one: tell the hub no device mirrors them now.
        case release
        /// Another device is the one: stop, and show the switch off.
        case stop(otherName: String?)
        case idle
    }

    /// - Parameters:
    ///   - localOn: this device's own switch (Settings, Accounts, From this iPhone, Contacts).
    ///   - wasOn: the switch as this device last saw it; nil the first time.
    ///   - setting: the hub's setting; nil from a hub before 1.0.18 (each device then decides alone, as before).
    public static func step(localOn: Bool, wasOn: Bool?, setting: SourcesSetting?, me: String) -> Step {
        guard let setting else { return localOn ? .mirror : .idle }
        let hub = setting.contacts.device
        if !localOn { return wasOn == true && hub == me ? .release : .idle }
        if wasOn == false || hub == nil { return hub == me ? .mirror : .claim }
        if hub == me { return .mirror }
        return .stop(otherName: setting.contacts.name)
    }
}

/// The work calendars a device marked itself before the choice was one for all devices, as it sends them once: its
/// own ticks, or when it never chose, the ones the first run would pick (Exchange, or the work email's domain).
public enum WorkCalendarMove {
    public static func ticked(chosen: Set<String>?, calendars: [CalendarInfo], workDomain: String?) -> [String] {
        let ids = chosen ?? CalendarSelection.preselect(calendars, workDomain: workDomain)
        return calendars.filter { ids.contains($0.id) }.map(\.sourceKey).sorted()
    }
}
