import Foundation

/// A request to the shared image service through the hub (`POST /images/plan`, `POST /images/jobs`).
/// Unset fields are left out, so the service's defaults apply; set ones are requirements, refused rather than changed.
public struct ImageRequestBody: Codable, Equatable, Sendable {
    public var prompt: String
    public var operation: String?
    public var references: [String]?
    public var width: Int?
    public var height: Int?
    public var aspect: String?
    /// "from_prompt" or 0 (stylized) to 100 (photographic).
    public var realism: JSONValue?
    public var seamless: String?
    public var transparent: Bool?
    public var quality: String?
    public var hardware: String?
    public var count: Int?
    public var seed: Int?
    public var exact_prompt: Bool?
    public init(prompt: String) { self.prompt = prompt }
}

public struct ImageSize: Codable, Equatable, Sendable { public var width: Int; public var height: Int }
public struct ImageCrop: Codable, Equatable, Sendable { public var left: Int; public var top: Int; public var width: Int; public var height: Int }
public struct ImageGeneration: Codable, Equatable, Sendable { public var width: Int; public var height: Int; public var steps: Int?; public var crop: ImageCrop? }
public struct ImageModel: Codable, Equatable, Sendable { public var id: String?; public var precision: String?; public var license: String? }

public struct ImagePlan: Codable, Equatable, Sendable {
    public var workflow: String?
    public var model: ImageModel?
    public var prompt_original: String?
    public var prompt_expanded: String?
    public var prompt_adapted: Bool?
    public var output: ImageSize
    public var generation: ImageGeneration?
    public var routing_reason: String?
    public var eligible_workers: [String]?
    public var notes: [String]?
    public var seed: Int?
    public var queue_reason: String?
    public var request: ImageRequestBody?
}

public struct ImageJob: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var status: String
    public var status_label: String
    public var reason: String?
    public var progress: Double?
    public var error: String?
    public var image_id: String?
    public var gallery_id: String?
    public var created_at: Double?
    public var plan: ImagePlan
    public var request: ImageRequestBody?
    public var measured: JSONValue?
    public var isActive: Bool { status == "queued" || status == "running" }
}

public struct ImageJobsResponse: Codable, Sendable { public var jobs: [ImageJob] }

public struct ImageCapabilities: Codable, Sendable {
    public var enabled: Bool
    public var unavailable_features: [String: String]?
    public var api_version: String?
    /// The workers one may pick by hand, as the hub names them (EA_IMAGE_WORKERS); absent or empty: only Auto.
    public var hardware: [ImageWorker]?
}

/// An image service worker one may pick by hand: the id the service knows, and the label people see.
public struct ImageWorker: Codable, Equatable, Hashable, Sendable {
    public var id: String
    public var label: String
    public init(id: String, label: String) { self.id = id; self.label = label }
}

extension Array where Element == ImageWorker {
    /// A worker's label, or its id when the hub gives none.
    public func label(for id: String) -> String { first { $0.id == id }?.label ?? id }

    /// Where a plan may run: one worker's label, or the eligible ones (every known one when the plan names none)
    /// joined with "or"; "Auto" when nothing is known.
    public func whereLabel(_ eligible: [String]) -> String {
        let ids = eligible.isEmpty ? map(\.id) : eligible
        return ids.isEmpty ? "Auto" : ids.map { label(for: $0) }.joined(separator: " or ")
    }
}

extension HubClient {
    public func imageCapabilities() async throws -> ImageCapabilities { try await get("images/capabilities", as: ImageCapabilities.self) }
    public func imagePlan(_ body: ImageRequestBody) async throws -> ImagePlan { try await post("images/plan", body, as: ImagePlan.self) }
    public func imageSubmit(_ body: ImageRequestBody) async throws -> [ImageJob] { try await post("images/jobs", body, as: ImageJobsResponse.self).jobs }
    public func imageJobs(limit: Int = 30) async throws -> [ImageJob] { try await get("images/jobs", query: ["limit": String(limit)], as: ImageJobsResponse.self).jobs }
    public func imageJob(_ id: String) async throws -> ImageJob { try await get("images/jobs/\(id)", as: ImageJob.self) }
    public func imageCancel(_ id: String) async throws { _ = try await send("POST", "images/jobs/\(id)/cancel", body: Data("{}".utf8)) }
    /// Answer the assistant's photos_request with this iPhone's photos.
    public func sendPhotos(requestId: String, photos: [DevicePhoto]) async throws {
        struct B: Encodable { var photos: [DevicePhoto] }
        _ = try await send("POST", "ai/photos/\(requestId)", body: try JSONCoding.data(B(photos: photos)))
    }
    /// Add a picture to the gallery's Saved bin (25 MB at most). `source`: uploaded, downloaded or photos.
    public func uploadImage(_ data: Data, source: String = "uploaded", name: String? = nil) async throws -> Entity {
        try decode(Entity.self, try await send("POST", "images/library", query: ["source": source, "name": name], body: data))
    }
}
