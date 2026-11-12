import Foundation

/// Tailscale inside Aeneas, for someone who chose Tailscale and does not run the Tailscale app on this device.
/// Set at launch by an app that carries Tailscale's library (EALink); nil in the Watch, widgets and tests.
public enum TailnetBridge {
    /// A URLSession whose requests go through the app's own Tailscale connection, or nil when the person has not
    /// signed in to Tailscale in Aeneas (the system's own network, and the Tailscale app if it is on, carry them).
    nonisolated(unsafe) public static var session: (@Sendable () -> URLSession?)?
}

public enum Tailnet {
    /// A hub reached through Tailscale (its address is on a `ts.net` name).
    public static func isTailnetHub(_ urlString: String) -> Bool {
        guard let host = URLComponents(string: urlString.trimmingCharacters(in: .whitespaces))?.host?.lowercased() else { return false }
        return host.hasSuffix(".ts.net")
    }
}
