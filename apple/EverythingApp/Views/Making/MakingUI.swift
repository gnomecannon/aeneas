import SwiftUI
import EACore
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// A status pill: symbol, word and color together, so status never rests on color alone.
struct MakingBadge: View {
    var text: String
    var symbol: String
    var color: Color

    var body: some View {
        Label(text, systemImage: symbol)
            .labelStyle(.titleAndIcon)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.16), in: Capsule())
            .foregroundStyle(color)
            .fixedSize()
    }
}

extension MakingBadge {
    static func project(_ status: String) -> MakingBadge {
        switch status {
        case "parked": return MakingBadge(text: "Parked", symbol: "pause.circle.fill", color: .orange)
        case "done": return MakingBadge(text: "Done", symbol: "checkmark.circle.fill", color: .secondary)
        default: return MakingBadge(text: "Active", symbol: "play.circle.fill", color: .green)
        }
    }

    static func music(_ status: String) -> MakingBadge {
        switch status {
        case "wip": return MakingBadge(text: "In progress", symbol: "hammer.fill", color: .orange)
        case "done": return MakingBadge(text: "Done", symbol: "checkmark.circle.fill", color: .green)
        default: return MakingBadge(text: "Idea", symbol: "lightbulb.fill", color: .purple)
        }
    }

    static func quiz(_ r: QuizResult?) -> MakingBadge {
        switch r {
        case .right: return MakingBadge(text: "Right", symbol: "checkmark.circle.fill", color: .green)
        case .revealed: return MakingBadge(text: "Revealed", symbol: "eye.circle.fill", color: .orange)
        case .wrong: return MakingBadge(text: "Wrong", symbol: "xmark.circle.fill", color: .red)
        case nil: return MakingBadge(text: "Not asked", symbol: "circle", color: .secondary)
        }
    }
}

enum MakingClipboard {
    static func copy(_ s: String) {
        #if os(iOS)
        UIPasteboard.general.string = s
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
        #endif
    }
}

/// A command in a monospaced block with a Copy button that says Copied for a moment.
struct MakingCommandBlock: View {
    var command: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(command)
                    .font(.body.monospaced())
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(12)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            Button {
                MakingClipboard.copy(command)
                copied = true
                Task {
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    copied = false
                }
            } label: {
                Label(copied ? "Copied" : "Copy command", systemImage: copied ? "checkmark" : "doc.on.doc")
            }
            .buttonStyle(.bordered)
            .accessibilityLabel(copied ? "Copied" : "Copy the command")
        }
    }
}

/// Small markdown renderer for resume cards and plan notes: headings, bullets and inline styles.
struct MakingMarkdown: View {
    var text: String

    private enum Line: Hashable { case heading(String), bullet(String), text(String), gap }

    private var lines: [Line] {
        var out: [Line] = []
        var inFence = false
        for raw in StyleGuard.dashes(text).components(separatedBy: "\n") {
            let t = raw.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("```") { inFence.toggle(); continue }
            if inFence { out.append(.text("`\(raw)`")); continue }
            if t.isEmpty { if out.last != .gap && !out.isEmpty { out.append(.gap) }; continue }
            if t.hasPrefix("#") { out.append(.heading(t.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces))); continue }
            if t.hasPrefix("- ") || t.hasPrefix("* ") { out.append(.bullet(String(t.dropFirst(2)))); continue }
            out.append(.text(t))
        }
        return out
    }

    private func inline(_ s: String) -> Text {
        if let a = try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) { return Text(a) }
        return Text(s)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                switch l {
                case .heading(let s): inline(s).font(.headline).padding(.top, 4)
                case .bullet(let s):
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\u{2022}").foregroundStyle(.secondary)
                        inline(s)
                    }
                case .text(let s): inline(s)
                case .gap: Color.clear.frame(height: 4)
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A red line with a symbol for a failed action.
struct MakingErrorLine: View {
    var text: String
    var body: some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.callout)
            .foregroundStyle(.red)
    }
}
