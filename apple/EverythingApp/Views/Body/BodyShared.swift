import SwiftUI
import EACore

/// Small formatting and display pieces shared by the Pet, Food and Sensors screens.
enum BodyFmt {
    /// "now", "12 min ago", "3 h ago", "2 days ago"; future dates read "in 3 days".
    static func ago(_ date: Date, now: Date = Date()) -> String {
        let s = now.timeIntervalSince(date)
        if s < 0 { return inDays(date, now: now) }
        let m = Int(s / 60)
        if m < 1 { return "now" }
        if m < 60 { return "\(m) min ago" }
        let h = m / 60
        if h < 24 { return "\(h) h ago" }
        let d = h / 24
        return d == 1 ? "1 day ago" : "\(d) days ago"
    }

    /// Calendar days from today: "today", "tomorrow", "in 5 days", "2 days ago".
    static func inDays(_ date: Date, now: Date = Date()) -> String {
        let cal = Calendar.current
        let n = cal.dateComponents([.day], from: cal.startOfDay(for: now), to: cal.startOfDay(for: date)).day ?? 0
        switch n {
        case 0: return "today"
        case 1: return "tomorrow"
        case -1: return "yesterday"
        case ..<0: return "\(-n) days ago"
        default: return "in \(n) days"
        }
    }

    static func number(_ v: Double) -> String { JSONValue.number(v).displayString }

    static func money(_ v: Double) -> String {
        v.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD").precision(.fractionLength(v.rounded() == v ? 0 : 2)))
    }

    /// Parses "12", "12.5" and "12,5"; empty or junk is nil.
    static func parse(_ s: String) -> Double? {
        let t = s.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard !t.isEmpty, let v = Double(t), v.isFinite else { return nil }
        return v
    }

    static func day(_ d: Date) -> String { d.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()) }
}

/// A status pill: icon, text and color together, so the state never rests on color alone.
struct BodyStatusPill: View {
    var text: String
    var symbol: String
    var color: Color

    var body: some View {
        Label(text, systemImage: symbol)
            .font(.subheadline.weight(.semibold))
            .labelStyle(.titleAndIcon)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(color.opacity(0.16), in: Capsule())
            .foregroundStyle(color)
            .fixedSize()
    }
}

/// A small grey capsule for a type or kind.
struct BodyTag: View {
    var text: String
    var color: Color = .secondary
    var body: some View {
        Text(text)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color == .secondary ? Color.primary : color)
            .fixedSize()
    }
}

/// A short message that clears itself, with an optional Undo.
struct BodyFlash: Equatable {
    var id = UUID()
    var text: String
    var undoId: String?
}

struct BodyFlashRow: View {
    var flash: BodyFlash
    var undo: (() -> Void)?
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            Text(flash.text).font(.subheadline)
            Spacer(minLength: 4)
            if let u = undo { Button("Undo", action: u).buttonStyle(.borderless) }
        }
    }
}

/// Error text in red with an icon.
struct BodyErrorRow: View {
    var text: String
    var body: some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.subheadline)
            .foregroundStyle(.red)
    }
}
