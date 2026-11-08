import Foundation
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

public struct StoreError: Error, LocalizedError, Sendable {
    public var message: String
    public var errorDescription: String? { message }
}

/// Local SQLite store: `entities`, `outbox`, `meta`. One actor owns the connection.
/// Local edits are applied immediately as patches (LWW per field) and queued in the outbox.
public actor SyncStore {
    private var db: OpaquePointer?
    public let url: URL

    public init(url: URL) throws {
        self.url = url
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Complete until first user authentication, set explicitly: widgets, background refresh, the Watch relay and
        // notification actions read and write the store while the device is locked. The folder carries the class too,
        // so the WAL and shared-memory files SQLite makes start with it.
        DataProtection.protect(url.deletingLastPathComponent(), .untilFirstUnlock)
        var handle: OpaquePointer?
        var flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        #if os(iOS) || os(watchOS)
        flags |= SQLITE_OPEN_FILEPROTECTION_COMPLETEUNTILFIRSTUSERAUTHENTICATION
        #endif
        guard sqlite3_open_v2(url.path, &handle, flags, nil) == SQLITE_OK, let h = handle else {
            let msg = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            throw StoreError(message: "SQLite open: \(msg)")
        }
        db = h
        try Self.exec(h, "PRAGMA journal_mode=WAL;")
        for suffix in ["", "-wal", "-shm"] { DataProtection.protect(URL(fileURLWithPath: url.path + suffix), .untilFirstUnlock) }
        try Self.exec(h, "PRAGMA busy_timeout=3000;")
        try Self.exec(h, """
        CREATE TABLE IF NOT EXISTS entities (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            space TEXT NOT NULL DEFAULT 'personal',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            fields TEXT NOT NULL,
            field_ts TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS entities_kind ON entities(kind);
        CREATE TABLE IF NOT EXISTS outbox (
            rowid INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_id TEXT NOT NULL,
            patch TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """)
    }

    /// An in-memory store for tests and previews.
    public static func inMemory() throws -> SyncStore {
        try SyncStore(url: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("eacore-\(UUID().uuidString).sqlite"))
    }

    deinit { if let d = db { sqlite3_close(d) } }

    private static func exec(_ db: OpaquePointer, _ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
            let m = err.map { String(cString: $0) } ?? "exec failed"
            sqlite3_free(err)
            throw StoreError(message: m)
        }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        guard let db = db else { throw StoreError(message: "closed") }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let s = stmt else {
            throw StoreError(message: "prepare: \(String(cString: sqlite3_errmsg(db)))")
        }
        return s
    }

    private func bind(_ s: OpaquePointer, _ idx: Int32, _ v: String?) {
        if let v = v { sqlite3_bind_text(s, idx, v, -1, SQLITE_TRANSIENT) } else { sqlite3_bind_null(s, idx) }
    }

    private func column(_ s: OpaquePointer, _ i: Int32) -> String? {
        guard let c = sqlite3_column_text(s, i) else { return nil }
        return String(cString: c)
    }

    private func rowToEntity(_ s: OpaquePointer) -> Entity? {
        guard let id = column(s, 0), let kindRaw = column(s, 1), let kind = Kind(rawValue: kindRaw),
              let created = column(s, 3), let updated = column(s, 4),
              let fieldsJSON = column(s, 6), let tsJSON = column(s, 7) else { return nil }
        let space = Space(rawValue: column(s, 2) ?? "personal") ?? .personal
        let fields = (try? JSONCoding.decode([String: JSONValue].self, from: fieldsJSON)) ?? [:]
        let ts = (try? JSONCoding.decode([String: String].self, from: tsJSON)) ?? [:]
        return Entity(id: id, kind: kind, space: space, created_at: created, updated_at: updated, deleted_at: column(s, 5), fields: fields, field_ts: ts)
    }

    private func write(_ e: Entity) throws {
        let s = try prepare("INSERT OR REPLACE INTO entities (id, kind, space, created_at, updated_at, deleted_at, fields, field_ts) VALUES (?,?,?,?,?,?,?,?)")
        defer { sqlite3_finalize(s) }
        bind(s, 1, e.id); bind(s, 2, e.kind.rawValue); bind(s, 3, e.space.rawValue)
        bind(s, 4, e.created_at); bind(s, 5, e.updated_at); bind(s, 6, e.deleted_at)
        bind(s, 7, try JSONCoding.string(e.fields)); bind(s, 8, try JSONCoding.string(e.field_ts))
        guard sqlite3_step(s) == SQLITE_DONE else { throw StoreError(message: "write failed") }
    }

    // MARK: entities

    public func get(_ id: String) throws -> Entity? {
        let s = try prepare("SELECT id, kind, space, created_at, updated_at, deleted_at, fields, field_ts FROM entities WHERE id = ?")
        defer { sqlite3_finalize(s) }
        bind(s, 1, id)
        return sqlite3_step(s) == SQLITE_ROW ? rowToEntity(s) : nil
    }

    public func all(kind: Kind? = nil, includeDeleted: Bool = false) throws -> [Entity] {
        var sql = "SELECT id, kind, space, created_at, updated_at, deleted_at, fields, field_ts FROM entities"
        var clauses: [String] = []
        if kind != nil { clauses.append("kind = ?") }
        if !includeDeleted { clauses.append("(deleted_at IS NULL OR deleted_at = '')") }
        if !clauses.isEmpty { sql += " WHERE " + clauses.joined(separator: " AND ") }
        let s = try prepare(sql)
        defer { sqlite3_finalize(s) }
        if let k = kind { bind(s, 1, k.rawValue) }
        var out: [Entity] = []
        while sqlite3_step(s) == SQLITE_ROW { if let e = rowToEntity(s) { out.append(e) } }
        return out
    }

    public func count(kind: Kind) throws -> Int {
        let s = try prepare("SELECT COUNT(*) FROM entities WHERE kind = ? AND (deleted_at IS NULL OR deleted_at = '')")
        defer { sqlite3_finalize(s) }
        bind(s, 1, kind.rawValue)
        return sqlite3_step(s) == SQLITE_ROW ? Int(sqlite3_column_int64(s, 0)) : 0
    }

    /// Store a hub copy, merging per field against any local copy. Returns the stored entity.
    @discardableResult
    public func upsertFromHub(_ hub: Entity) throws -> Entity {
        if var local = try get(hub.id) {
            local.merge(hub: hub)
            try write(local)
            return local
        }
        try write(hub)
        return hub
    }

    /// Merge a page of hub changes in one transaction. Returns each merged entity, in order.
    public func upsertManyFromHub(_ hub: [Entity]) throws -> [Entity] {
        guard let d = db else { throw StoreError(message: "store closed") }
        try Self.exec(d, "BEGIN")
        do {
            let out = try hub.map { try upsertFromHub($0) }
            try Self.exec(d, "COMMIT")
            return out
        } catch {
            try? Self.exec(d, "ROLLBACK")
            throw error
        }
    }

    /// Replace the local copy wholesale (used after the hub rejects a patch).
    public func replace(_ e: Entity) throws { try write(e) }

    /// Apply a local patch immediately (LWW) and enqueue it in the outbox.
    @discardableResult
    public func applyLocal(_ patch: Patch, enqueue: Bool = true) throws -> Entity {
        var entity: Entity
        if let existing = try get(patch.id) {
            entity = existing
        } else {
            entity = Entity(id: patch.id, kind: patch.kind, space: patch.space ?? .personal, created_at: patch.ts)
        }
        entity.apply(patch)
        try write(entity)
        if enqueue {
            let s = try prepare("INSERT INTO outbox (entity_id, patch, created_at) VALUES (?,?,?)")
            defer { sqlite3_finalize(s) }
            bind(s, 1, patch.id); bind(s, 2, try JSONCoding.string(patch)); bind(s, 3, ISO.now())
            guard sqlite3_step(s) == SQLITE_DONE else { throw StoreError(message: "outbox insert failed") }
        }
        return entity
    }

    // MARK: outbox

    public struct OutboxItem: Sendable { public var rowid: Int64; public var patch: Patch }

    public func outbox(limit: Int = 500) throws -> [OutboxItem] {
        let s = try prepare("SELECT rowid, patch FROM outbox ORDER BY rowid ASC LIMIT ?")
        defer { sqlite3_finalize(s) }
        sqlite3_bind_int(s, 1, Int32(limit))
        var out: [OutboxItem] = []
        while sqlite3_step(s) == SQLITE_ROW {
            let rowid = sqlite3_column_int64(s, 0)
            if let json = column(s, 1), let p = try? JSONCoding.decode(Patch.self, from: json) { out.append(OutboxItem(rowid: rowid, patch: p)) }
        }
        return out
    }

    public func outboxCount() throws -> Int {
        let s = try prepare("SELECT COUNT(*) FROM outbox")
        defer { sqlite3_finalize(s) }
        return sqlite3_step(s) == SQLITE_ROW ? Int(sqlite3_column_int64(s, 0)) : 0
    }

    public func removeOutbox(rowids: [Int64]) throws {
        guard !rowids.isEmpty else { return }
        let s = try prepare("DELETE FROM outbox WHERE rowid IN (\(rowids.map { String($0) }.joined(separator: ",")))")
        defer { sqlite3_finalize(s) }
        _ = sqlite3_step(s)
    }

    /// Remove every queued patch for an entity (after the hub rejected one and we reloaded).
    public func removeOutbox(entityId: String) throws {
        let s = try prepare("DELETE FROM outbox WHERE entity_id = ?")
        defer { sqlite3_finalize(s) }
        bind(s, 1, entityId)
        _ = sqlite3_step(s)
    }

    /// Drop an entity the hub does not have (a create it refused), with anything still queued for it.
    public func remove(_ id: String) throws {
        try removeOutbox(entityId: id)
        let s = try prepare("DELETE FROM entities WHERE id = ?")
        defer { sqlite3_finalize(s) }
        bind(s, 1, id)
        _ = sqlite3_step(s)
    }

    /// After the hub answered from the beginning: drop every entity it did not send, except readings (left out of
    /// the feed), work items (a restored hub without its work key cannot send them; this copy is the one it needs) and
    /// those with edits still waiting to go up. Returns the ids removed.
    public func removeStale(keeping ids: Set<String>) throws -> [String] {
        let s = try prepare("SELECT id FROM entities WHERE kind != 'reading' AND space != 'work' AND id NOT IN (SELECT entity_id FROM outbox)")
        var stale: [String] = []
        while sqlite3_step(s) == SQLITE_ROW { if let id = column(s, 0), !ids.contains(id) { stale.append(id) } }
        sqlite3_finalize(s)
        for id in stale {
            let d = try prepare("DELETE FROM entities WHERE id = ?")
            bind(d, 1, id)
            _ = sqlite3_step(d)
            sqlite3_finalize(d)
        }
        return stale
    }

    // MARK: meta

    public func meta(_ key: String) throws -> String? {
        let s = try prepare("SELECT value FROM meta WHERE key = ?")
        defer { sqlite3_finalize(s) }
        bind(s, 1, key)
        return sqlite3_step(s) == SQLITE_ROW ? column(s, 0) : nil
    }

    public func setMeta(_ key: String, _ value: String?) throws {
        if let v = value {
            let s = try prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)")
            defer { sqlite3_finalize(s) }
            bind(s, 1, key); bind(s, 2, v)
            _ = sqlite3_step(s)
        } else {
            let s = try prepare("DELETE FROM meta WHERE key = ?")
            defer { sqlite3_finalize(s) }
            bind(s, 1, key)
            _ = sqlite3_step(s)
        }
    }

    public var cursor: Int {
        get throws { Int(try meta("seq") ?? "0") ?? 0 }
    }
    public func setCursor(_ seq: Int) throws { try setMeta("seq", String(seq)) }

    /// Wipe this device's copy but keep edits that have not reached the hub, with the rows they belong to, so they
    /// are sent first and the next edit to them still has a whole row. The cursor goes with the rest of meta.
    public func resetKeepingOutbox() throws {
        guard let db = db else { return }
        try Self.exec(db, "DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM outbox); DELETE FROM meta;")
    }

    /// Wipe everything. Used when the hub URL changes.
    public func reset() throws {
        guard let db = db else { return }
        try Self.exec(db, "DELETE FROM entities; DELETE FROM outbox; DELETE FROM meta;")
    }
}
