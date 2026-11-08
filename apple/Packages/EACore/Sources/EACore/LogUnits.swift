import Foundation

/// One unit per measure on the screens, read the way the hub reads logs (hub/src/health.ts): weight is lb unless the
/// unit is kg, sleep is minutes unless the unit says hours. The Logs screen used to show a kg weight as lb and mix
/// it into the lb chart, and read a sleep logged in hours as minutes.
public enum LogUnits {
    public static let lbPerKg = 2.20462

    private static func unit(_ e: Entity) -> String { e.str("unit").trimmingCharacters(in: .whitespaces).lowercased() }

    public static func isKg(_ e: Entity) -> Bool { ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms"].contains(unit(e)) }
    public static func inHours(_ e: Entity) -> Bool { ["h", "hr", "hrs", "hour", "hours"].contains(unit(e)) }

    /// The weight's own unit, for showing it as it was logged.
    public static func weightUnit(_ e: Entity) -> String { isKg(e) ? "kg" : "lb" }

    /// A weight in lb, for a chart of every reading.
    public static func weightLb(_ e: Entity) -> Double? {
        guard let v = e.number("value") else { return nil }
        return isKg(e) ? v * lbPerKg : v
    }

    /// Sleep in minutes.
    public static func sleepMinutes(_ e: Entity) -> Double? {
        guard let v = e.number("value") else { return nil }
        return inHours(e) ? v * 60 : v
    }

    /// A log's value as the Logs screen shows it: sleep as hours and minutes, a weight with its own unit.
    public static func valueText(_ e: Entity) -> String {
        let type = e.str("type")
        if type == LogType.sleep.rawValue, let m = sleepMinutes(e) {
            let total = Int(m.rounded())
            return "\(total / 60) h \(total % 60) min"
        }
        if let n = e.number("value") {
            let s = n == n.rounded() ? Int(n).formatted() : String(format: "%.1f", n)
            return type == LogType.weight.rawValue ? "\(s) \(weightUnit(e))" : s
        }
        return e.str("value")
    }
}
