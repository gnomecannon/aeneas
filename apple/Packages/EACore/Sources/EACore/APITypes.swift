import Foundation

// Section 3 of the contract: request and response bodies.

public struct HealthResponse: Codable, Sendable {
    public var ok: Bool
    public var version: String?
    public var time: String?
    public var db_seq: Int?
    public var ai: AICapabilities?
    /// Whose hub this is, when several people's hubs share one machine (EA_HUB_NAME, EA_HUB_COLOR); only with a key.
    public var hub: HubIdentity?
}

/// The name and color a hub gives itself, so a device shows whose hub it is paired with.
public struct HubIdentity: Codable, Sendable, Equatable {
    public var name: String?
    /// `#rrggbb`; set on hubs that share a machine with other people's (deploy/people.sh).
    public var color: String?
    public init(name: String?, color: String?) { self.name = name; self.color = color }
    /// "Jamie’s hub", or nil on a single person's hub (no color), where it would only repeat the obvious.
    public var label: String? {
        guard let c = color, !c.isEmpty else { return nil }
        if let n = name, !n.isEmpty { return "\(n)\u{2019}s hub" }
        return "This hub"
    }
    /// The color as red, green and blue from 0 to 1.
    public var rgb: (Double, Double, Double)? {
        guard let c = color, c.count == 7, c.hasPrefix("#"), let v = UInt32(c.dropFirst(), radix: 16) else { return nil }
        return (Double((v >> 16) & 0xff) / 255, Double((v >> 8) & 0xff) / 255, Double(v & 0xff) / 255)
    }
}

public struct AICapabilities: Codable, Sendable, Equatable {
    public var cloud: Bool
    public var tools: Bool
    public var model: String?
    /// The hub accepts image attachments (vision model).
    public var images: Bool?
    public var web: Bool?
    public var hosts: Bool?
    public var voice_model: Bool?
    /// Chats are kept on the hub (GET /ai/sessions); send one turn at a time.
    public var synced_sessions: Bool?
}

/// A host command the assistant wants to run, waiting for the owner's approval.
public struct PendingAction: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var host: String
    public var command: String
    public var purpose: String?
    public var risk: String?
    public var preflight: Preflight?
    public struct Preflight: Codable, Sendable, Equatable { public var backup: String; public var verify: String; public var rollback: String }
}

/// One row of the hub's chat list.
public struct AISessionItem: Codable, Sendable, Equatable, Identifiable {
    public var session_id: String
    public var title: String
    public var task_type: String
    public var created_at: String
    public var last_at: String
    public var message_count: Int
    public var preview: String
    public var working: Bool?
    public var id: String { session_id }
}

public struct AIStoredMessage: Codable, Sendable, Equatable {
    public var role: ChatMessage.Role
    public var content: String
    public var at: String?
    public var images: [String]?
    public var actions: [ToolAction]?
    public var approval: Approval?
    public struct Approval: Codable, Sendable, Equatable {
        public var action_id: String; public var host: String; public var command: String; public var status: String?; public var exit_code: Int?
        public init(action_id: String, host: String, command: String, status: String? = nil, exit_code: Int? = nil) {
            self.action_id = action_id; self.host = host; self.command = command; self.status = status; self.exit_code = exit_code
        }
    }
    public init(role: ChatMessage.Role, content: String, at: String? = nil, images: [String]? = nil, actions: [ToolAction]? = nil, approval: Approval? = nil) {
        self.role = role; self.content = content; self.at = at; self.images = images; self.actions = actions; self.approval = approval
    }
}

/// A whole chat as the hub keeps it.
public struct AISession: Codable, Sendable, Equatable {
    public var session_id: String
    public var title: String
    public var task_type: String
    public var created_at: String
    public var last_at: String
    public var messages: [AIStoredMessage]
    public var summary: String?
    public var pending_action: PendingAction?
    /// Set while the hub is still working on a reply in this chat, from any device.
    public var working: AIWorking?
    public init(session_id: String, title: String, task_type: String, created_at: String, last_at: String, messages: [AIStoredMessage], summary: String? = nil, pending_action: PendingAction? = nil, working: AIWorking? = nil) {
        self.session_id = session_id; self.title = title; self.task_type = task_type; self.created_at = created_at; self.last_at = last_at
        self.messages = messages; self.summary = summary; self.pending_action = pending_action; self.working = working
    }
}

public struct AIWorking: Codable, Sendable, Equatable {
    public var since: String
    public var status: String?
    public var tool: String?
    public init(since: String, status: String? = nil, tool: String? = nil) { self.since = since; self.status = status; self.tool = tool }
}

public struct ToolAction: Codable, Sendable, Equatable {
    public var tool: String
    public var ok: Bool
    public var writes: Bool
    /// Plain words for a tool name, for status lines.
    public static func label(_ tool: String) -> String {
        switch tool {
        case "get_today": return "Checking today"
        case "get_week": return "Checking the week"
        case "search": return "Searching your notes"
        case "list_items", "get_item": return "Looking it up"
        case "reminders_due": return "Checking reminders"
        case "ops_status": return "Checking the homelab"
        case "health_summary": return "Checking health logs"
        case "pet_summary": return "Checking on the pet"
        case "project_summary": return "Opening the project"
        case "pick_food": return "Picking food"
        case "pick_game": return "Picking a game"
        case "create_task": return "Adding a task"
        case "update_task": return "Updating a task"
        case "schedule_task": return "Scheduling"
        case "create_reminder": return "Setting a reminder"
        case "snooze_or_finish_reminder": return "Updating a reminder"
        case "save_note": return "Saving a note"
        case "capture": return "Capturing"
        case "log_health": return "Logging"
        case "log_pet": return "Logging for the pet"
        case "toggle_checklist_item": return "Ticking the checklist"
        case "music_idea": return "Saving the idea"
        case "remember": return "Remembering"
        case "forget": return "Forgetting"
        case "ledger_update": return "Updating the ledger"
        case "runbook_note": return "Writing fix notes"
        case "journal_entry": return "Journaling"
        case "create_item": return "Saving"
        case "update_item": return "Updating"
        case "delete_item": return "Deleting"
        case "procedure": return "Updating the procedure"
        case "quiz": return "Checking the quiz"
        case "render_snippet": return "Filling a snippet"
        case "ops_action": return "Checking a monitor"
        case "sensors": return "Reading sensors"
        case "project_plan": return "Updating the plan"
        case "cover_letter": return "Drafting a cover letter"
        case "calculate": return "Calculating"
        case "checklist_from_template": return "Starting a checklist"
        case "draft_in_my_voice": return "Drafting in your voice"
        case "web_search": return "Searching the web"
        case "read_web_page": return "Reading a page"
        case "list_hosts": return "Listing machines"
        case "run_command": return "Running a command"
        case "approve_command": return "Running the approved command"
        case "wiki_search": return "Searching the wiki"
        case "wiki_page": return "Reading the wiki"
        case "library": return "Checking your library"
        case "food_chosen": return "Noting the pick"
        case "inbox": return "Sorting Unsorted Info"
        case "record_done": return "Recording it"
        case "app_status": return "Checking the app"
        case "sync_now": return "Syncing"
        case "metrics": return "Reading your charts"
        case "dashboard": return "Updating the dashboard"
        case "set_injection_day": return "Setting the injection day"
        case "note_tags": return "Tagging the note"
        default: return "Working"
        }
    }
}

public struct ChangesResponse: Codable, Sendable {
    public var changes: [Change]
    public var seq: Int
    public var more: Bool
    /// Rows this build could not read (a kind or shape newer than the app). They are skipped,
    /// never fatal: one unknown row used to fail the whole sync and show the app as offline.
    public var skipped: Int = 0
    /// The hub answered from the beginning: the device's cursor was past its latest seq (a restored hub).
    public var reset: Bool = false

    public init(changes: [Change], seq: Int, more: Bool, skipped: Int = 0, reset: Bool = false) {
        self.changes = changes; self.seq = seq; self.more = more; self.skipped = skipped; self.reset = reset
    }

    private enum CodingKeys: String, CodingKey { case changes, seq, more, reset }
    private struct Lossy: Decodable {
        var value: Change?
        init(from decoder: Decoder) throws { value = try? Change(from: decoder) }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rows = try c.decode([Lossy].self, forKey: .changes)
        changes = rows.compactMap(\.value)
        skipped = rows.count - changes.count
        seq = try c.decode(Int.self, forKey: .seq)
        more = try c.decode(Bool.self, forKey: .more)
        reset = try c.decodeIfPresent(Bool.self, forKey: .reset) ?? false
    }
}

public struct PushRequest: Codable, Sendable {
    public var device_id: String
    public var patches: [Patch]
    public init(device_id: String, patches: [Patch]) { self.device_id = device_id; self.patches = patches }
}

public struct PushResponse: Codable, Sendable {
    public struct Applied: Codable, Sendable { public var id: String; public var seq: Int }
    public struct Rejected: Codable, Sendable { public var id: String; public var reason: String }
    public var applied: [Applied]
    public var rejected: [Rejected]
    public var seq: Int
}

public struct CaptureRequest: Codable, Sendable {
    public var text: String
    public var source: Source
    public var attachments: [Attachment]?
    public var auto: Bool?
    /// The capture's own id: sent again after a lost reply, the hub answers with the capture it already has.
    public var id: String?
    public init(text: String, source: Source, attachments: [Attachment]? = nil, auto: Bool? = nil, id: String? = nil) {
        self.text = text; self.source = source; self.attachments = attachments; self.auto = auto; self.id = id
    }
}

public struct CaptureResponse: Codable, Sendable {
    public var capture: Entity
    public var suggested_kind: SuggestedKind?
    public var created: [Entity]?
}

public struct ConvertRequest: Codable, Sendable {
    public var kind: Kind
    public var fields: [String: JSONValue]?
    public init(kind: Kind, fields: [String: JSONValue]? = nil) { self.kind = kind; self.fields = fields }
}

public struct SnoozeRequest: Codable, Sendable {
    public var until: String
    public var reason: String?
    public init(until: String, reason: String? = nil) { self.until = until; self.reason = reason }
}

public struct SearchHit: Codable, Identifiable, Sendable {
    public var id: String
    public var kind: Kind
    public var title: String?
    public var snippet: String?
    public var score: Double?
    public init(id: String, kind: Kind, title: String?, snippet: String?, score: Double?) {
        self.id = id; self.kind = kind; self.title = title; self.snippet = snippet; self.score = score
    }
}

public struct SearchResponse: Codable, Sendable { public var hits: [SearchHit] }

// Notes (knowledge map)
public struct RelatedNote: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var title: String
    public var path: String?
    public var why: String?
}

/// An item connected to another (GET /entities/:id/related): a link either way, or a person by name.
public struct RelatedItem: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var kind: String
    public var title: String
    public var why: String
    public var at: String
    /// On a person: the lines of a mentioning note (a diary day) that name them.
    public var lines: [String]?
}

public struct RelatedItemsResponse: Codable, Equatable, Sendable {
    public var items: [RelatedItem]
}

public struct RelatedResponse: Codable, Equatable, Sendable {
    public var links: [RelatedNote]
    public var backlinks: [RelatedNote]
    public var similar: [RelatedNote]
    public init(links: [RelatedNote] = [], backlinks: [RelatedNote] = [], similar: [RelatedNote] = []) { self.links = links; self.backlinks = backlinks; self.similar = similar }
    public var isEmpty: Bool { links.isEmpty && backlinks.isEmpty && similar.isEmpty }
}

public struct SuggestResponse: Codable, Sendable {
    public var id: String
    public var suggested_tags: [String]
    public var links: [String]?
    public var ai_used: Bool?
}

public struct NoteGraph: Codable, Sendable {
    public struct Node: Codable, Identifiable, Sendable { public var id: String; public var title: String; public var path: String?; public var tags: [String]?; public var folder: String? }
    public struct Edge: Codable, Sendable { public var from: String; public var to: String }
    public var nodes: [Node]
    public var edges: [Edge]
}

public struct LogRequest: Codable, Sendable {
    public var type: LogType
    public var value: JSONValue
    public var unit: String?
    public var at: String?
    public var note: String?
    public init(type: LogType, value: JSONValue, unit: String? = nil, at: String? = nil, note: String? = nil) {
        self.type = type; self.value = value; self.unit = unit; self.at = at; self.note = note
    }
}

public struct DashboardLogPoint: Codable, Sendable {
    public var at: String
    public var value: JSONValue
}

public struct Dashboard: Codable, Sendable {
    public var now: Entity?
    public var next: [Entity]
    public var reminders_today: [Entity]
    public var logs_7d: [String: [DashboardLogPoint]]
    public var captures_unprocessed: Int
    public var projects_active: [Entity]
}

public struct ChatMessage: Codable, Equatable, Identifiable, Sendable {
    public enum Role: String, Codable, Sendable { case system, user, assistant }
    public var role: Role
    public var content: String
    public var id: String
    enum CodingKeys: String, CodingKey { case role, content }
    public init(role: Role, content: String) { self.role = role; self.content = content; self.id = UUID().uuidString }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = try c.decode(Role.self, forKey: .role)
        content = try c.decode(String.self, forKey: .content)
        id = UUID().uuidString
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(role, forKey: .role)
        try c.encode(content, forKey: .content)
    }
}

public struct ChatRequest: Codable, Sendable {
    public var session_id: String
    /// Whole history (older hubs). Nil when the hub keeps the chat.
    public var messages: [ChatMessage]?
    /// One new turn; the hub holds the history.
    public var message: String?
    /// Base64 JPEG/PNG images attached to `message`.
    public var images: [String]?
    /// Approve the host command this chat is waiting on.
    public var approve_action_id: String?
    public var task_type: TaskType?
    public var space: Space?
    public var allow_cloud: Bool?
    public var allow_work: Bool?
    /// What this device can do for the assistant (photos: full photo library access on).
    public var device: DeviceCaps?
    public init(session_id: String, messages: [ChatMessage], task_type: TaskType = .general, space: Space? = nil, allow_cloud: Bool? = nil, allow_work: Bool? = nil) {
        self.session_id = session_id; self.messages = messages; self.task_type = task_type; self.space = space; self.allow_cloud = allow_cloud; self.allow_work = allow_work
    }
    /// A hub-held turn: a message (with images), or an approval.
    public init(session_id: String, message: String?, images: [String]? = nil, approve_action_id: String? = nil, allow_cloud: Bool? = nil) {
        self.session_id = session_id; self.message = message; self.images = images; self.approve_action_id = approve_action_id; self.allow_cloud = allow_cloud
    }
}

public struct ChatResponse: Codable, Equatable, Sendable {
    public var reply: String
    public var model: String
    public var backend: String
    public var redactions: Int
    public var rules_applied: [String]
    public var ledger_id: String?
    public var actions: [ToolAction]?
    public var session_id: String?
    public var mode: String?
    public var pending_action: PendingAction?
    public var images: [String]?
}

public struct ClassifyResponse: Codable, Sendable {
    public var kind: SuggestedKind
    public var fields: [String: JSONValue]
}

public struct MemoryResponse: Codable, Sendable {
    public var facts: [Entity]
    public var rules: [Entity]
}

public struct RegisterRequest: Codable, Sendable {
    public var name: String
    public var platform: Platform
    public var push_token: String?
    public init(name: String, platform: Platform, push_token: String? = nil) { self.name = name; self.platform = platform; self.push_token = push_token }
}

public struct RegisterResponse: Codable, Sendable { public var device_id: String }

public struct APIError: Codable, Sendable { public var error: String; public var detail: JSONValue? }

// Planner (Module 1: days and tasks)

public struct PlannerBlock: Codable, Equatable, Identifiable, Sendable {
    public var task_id: String
    public var title: String
    public var start: String
    public var end: String
    public var status: TaskStatus?
    public var id: String { task_id + "|" + start }
    public init(task_id: String, title: String, start: String, end: String, status: TaskStatus? = nil) {
        self.task_id = task_id; self.title = title; self.start = start; self.end = end; self.status = status
    }
}

public struct PlannerCommitment: Codable, Equatable, Identifiable, Sendable {
    public var rule_id: String
    public var title: String
    public var start: String
    public var end: String
    public var type: PlanRuleType
    public var id: String { rule_id + "|" + start }
    public init(rule_id: String, title: String, start: String, end: String, type: PlanRuleType) {
        self.rule_id = rule_id; self.title = title; self.start = start; self.end = end; self.type = type
    }
}

public struct FreeSlot: Codable, Equatable, Identifiable, Sendable {
    public var start: String
    public var end: String
    public var hours: Double
    public var id: String { start }
    public init(start: String, end: String, hours: Double) { self.start = start; self.end = end; self.hours = hours }
}

/// One day of `GET /planner/week`.
public struct PlannerDay: Codable, Equatable, Identifiable, Sendable {
    public var date: String
    public var blocks: [PlannerBlock]
    public var events: [Entity]
    public var commitments: [PlannerCommitment]
    /// Preference and info rules, sent apart by the hub; `HubClient` folds them into `commitments`, which the
    /// screens draw by type (as the offline planner does).
    public var preferences: [PlannerCommitment]?
    public var reminders: [Entity]
    public var watches_due: [Entity]
    public var free_slots: [FreeSlot]
    public var id: String { date }
    public init(date: String, blocks: [PlannerBlock] = [], events: [Entity] = [], commitments: [PlannerCommitment] = [], reminders: [Entity] = [], watches_due: [Entity] = [], free_slots: [FreeSlot] = []) {
        self.date = date; self.blocks = blocks; self.events = events; self.commitments = commitments; self.reminders = reminders; self.watches_due = watches_due; self.free_slots = free_slots
    }
}

public struct PlannerWeek: Codable, Equatable, Sendable {
    public var start: String
    public var days: [PlannerDay]
    public init(start: String, days: [PlannerDay]) { self.start = start; self.days = days }
}

public struct ScheduleRequest: Codable, Sendable {
    public var task_id: String
    public var start: String
    public var hours: Double?
    public var force: Bool?
    public init(task_id: String, start: String, hours: Double? = nil, force: Bool? = nil) {
        self.task_id = task_id; self.start = start; self.hours = hours; self.force = force
    }
}

/// `GET /planner/today`.
public struct PlannerToday: Codable, Equatable, Sendable {
    public var date: String
    public var now: Entity?
    public var next: [Entity]
    public var blocks: [PlannerBlock]
    public var commitments: [PlannerCommitment]
    public var preferences: [PlannerCommitment]?
    public var reminders_due: [Entity]
    public var watches_due_soon: [Entity]
    public var captures_unprocessed: Int
    public var free_slots: [FreeSlot]
    public var digest: String
    public init(date: String, now: Entity? = nil, next: [Entity] = [], blocks: [PlannerBlock] = [], commitments: [PlannerCommitment] = [], reminders_due: [Entity] = [], watches_due_soon: [Entity] = [], captures_unprocessed: Int = 0, free_slots: [FreeSlot] = [], digest: String = "") {
        self.date = date; self.now = now; self.next = next; self.blocks = blocks; self.commitments = commitments; self.reminders_due = reminders_due; self.watches_due_soon = watches_due_soon; self.captures_unprocessed = captures_unprocessed; self.free_slots = free_slots; self.digest = digest
    }
}

/// The 409 payload of `POST /planner/schedule`: the conflicting block, commitment or blackout.
/// The hub sends `{ error, detail }`; `detail` (or the body itself) carries these keys.
public struct PlannerConflict: Codable, Equatable, Hashable, Sendable {
    public var kind: String?        // block | commitment | blackout | event
    public var title: String?
    public var start: String?
    public var end: String?
    public var task_id: String?
    public var rule_id: String?
    public init(kind: String? = nil, title: String? = nil, start: String? = nil, end: String? = nil, task_id: String? = nil, rule_id: String? = nil) {
        self.kind = kind; self.title = title; self.start = start; self.end = end; self.task_id = task_id; self.rule_id = rule_id
    }

    /// Decode from a 409 body: `detail` when it is an object, else the top level.
    public static func from(body: Data) -> PlannerConflict? {
        guard let root = try? JSONCoding.decode(JSONValue.self, from: body), let obj = root.objectValue else { return nil }
        let source: [String: JSONValue]
        if let d = obj["detail"]?.objectValue {
            source = d["conflict"]?.objectValue ?? d
        } else if let c = obj["conflict"]?.objectValue {
            source = c
        } else {
            source = obj
        }
        guard source["start"] != nil || source["title"] != nil || source["kind"] != nil else { return nil }
        var c = PlannerConflict()
        c.kind = source["kind"]?.stringValue ?? source["type"]?.stringValue
        c.title = source["title"]?.stringValue
        c.start = source["start"]?.stringValue
        c.end = source["end"]?.stringValue
        c.task_id = source["task_id"]?.stringValue
        c.rule_id = source["rule_id"]?.stringValue
        return c
    }

    /// Short description for an alert.
    public var summary: String {
        var parts: [String] = []
        if let k = kind { parts.append(k.capitalized) }
        if let t = title, !t.isEmpty { parts.append(t) }
        if let s = ISO.date(start), let e = ISO.date(end) {
            parts.append(s.formatted(date: .abbreviated, time: .shortened) + " to " + e.formatted(date: .omitted, time: .shortened))
        }
        return parts.isEmpty ? "Something is already there" : parts.joined(separator: ", ")
    }
}

/// A `notify` event on `GET /live`. `kind` is `reminder` (default), `digest` or `activity`.
public struct NotifyEvent: Equatable, Sendable {
    public var kind: String
    public var id: String?
    public var title: String
    public var at: String?
    public var friction: Friction?
    public var log_id: String?
    public init(kind: String = "reminder", id: String? = nil, title: String = "", at: String? = nil, friction: Friction? = nil, log_id: String? = nil) {
        self.kind = kind; self.id = id; self.title = title; self.at = at; self.friction = friction; self.log_id = log_id
    }
}

/// Events on `GET /live`.
public enum LiveEvent: Equatable, Sendable {
    case change(seq: Int, id: String, kind: Kind)
    case notify(NotifyEvent)
    /// A module was switched on or off on some device: the whole list as it is now.
    case modules([ModuleInfo])
    case ping
    case unknown(name: String, data: String)
}

/// Events on `POST /ai/chat/stream`.
public enum ChatStreamEvent: Equatable, Sendable {
    case token(String)
    case done(ChatResponse)
    /// The hub could not get a reply (for example the model server is down). The text is meant for the person.
    case failed(String)
    /// The assistant read or changed data with a tool.
    case tool(ToolAction)
    /// A host command is waiting for approval.
    case approval(PendingAction)
    /// Progress text from the hub (for example while condensing a long chat).
    case status(String)
    /// The assistant wants this iPhone's newest photos; answer with `HubClient.sendPhotos`.
    case photosRequest(PhotosRequest)
}

public struct PhotosRequest: Codable, Equatable, Sendable { public var id: String; public var count: Int; public var since_days: Double? }
public struct DevicePhoto: Codable, Equatable, Sendable {
    public var b64: String; public var taken_at: String?; public var width: Int?; public var height: Int?
    public init(b64: String, taken_at: String?, width: Int?, height: Int?) { self.b64 = b64; self.taken_at = taken_at; self.width = width; self.height = height }
}
public struct DeviceCaps: Codable, Equatable, Sendable { public var photos: Bool?; public init(photos: Bool?) { self.photos = photos } }

extension Array where Element == PlannerCommitment {
    /// These rules with `more` added (not twice), in time order.
    func folding(_ more: [PlannerCommitment]?) -> [PlannerCommitment] {
        let extra = (more ?? []).filter { p in !contains { $0.id == p.id } }
        return (self + extra).sorted { $0.start < $1.start }
    }
}
