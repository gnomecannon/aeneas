import SwiftUI
import EACore
#if os(iOS)
import UIKit
#else
import AppKit
#endif

// The Mail screen's rows. Every word of a mail is shown with Text(verbatim:): never read as Markdown or HTML.

/// A thread as one row: who wrote ("Alex, me (3)"), the subject and first words, when, unread in bold with a dot, and
/// a pin when pinned.
struct MailThreadRow: View {
    var thread: MailThread
    var logos: [String: String]
    var shown: [Mail.Bundle]

    var body: some View {
        let s = thread.summary
        let unread = thread.isUnread
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(unread ? AnyShapeStyle(MailWord(key: .place("inbox"))) : AnyShapeStyle(Color.clear))
                .frame(width: 8, height: 8)
                .padding(.top, 15)
                .accessibilityHidden(true)
            MailAvatar(mail: s, logos: logos, shown: shown)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(verbatim: thread.people)
                        .fontWeight(unread ? .bold : .regular)
                        .lineLimit(1)
                    if thread.pinned {
                        Image(systemName: "pin.fill").font(.caption).foregroundStyle(MailWord(key: .place("inbox"))).accessibilityLabel("Pinned")
                    }
                    if let n = s.attachments {
                        Image(systemName: "paperclip").font(.caption).foregroundStyle(.secondary)
                            .accessibilityLabel(n == 1 ? "An attachment" : "\(n) attachments")
                    }
                    if s.triage?.needs_reply == true && s.state == .inbox {
                        Text("Reply?").font(.caption2.weight(.semibold)).foregroundStyle(MailWord(key: .place("inbox")))
                            .help("Your hub's model thinks this needs a reply")
                    }
                    Spacer(minLength: 6)
                    Text(verbatim: when(s)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(verbatim: s.subject.isEmpty ? "(no subject)" : s.subject)
                    .font(.subheadline)
                    .fontWeight(unread ? .semibold : .regular)
                    .lineLimit(1)
                if !s.preview.isEmpty {
                    Text(verbatim: s.preview).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                // Its first card's facts, as text (Track is on the open mail).
                if let c = s.cards?.first, !Mail.cardLine(c).isEmpty {
                    HStack(spacing: 5) {
                        MailCardIcon(card: c, size: 16)
                        Text(verbatim: Mail.cardLine(c)).font(.caption).foregroundStyle(MailWord(key: .place(Mail.cardBundle(c)))).lineLimit(1)
                    }
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityHint(unread ? "Unread" : "")
    }

    private func when(_ s: MailSummary) -> String {
        if s.state == .snoozed, let u = s.snooze_until { return "Until \(Mail.whenLabel(u))" }
        return Mail.whenLabel(s.at)
    }
}

/// A sender's circle: the brand's logo when iCloud verified it; for other mail a system sent, the sender's initials on
/// its bundle's color; for a person, or mail in no bundle, initials on gray.
struct MailAvatar: View {
    var mail: MailSummary
    var logos: [String: String]
    var shown: [Mail.Bundle]
    var size: CGFloat = 38

    var body: some View {
        Group {
            if let image = logo {
                image.resizable().scaledToFit().clipShape(Circle())
            } else if mail.automated, let b = Mail.bundleOf(mail, in: shown) {
                Circle().fill(MailFill(key: b.colorKey)).overlay(initials.foregroundStyle(.white))
            } else {
                Circle().fill(Color.secondary.opacity(0.22)).overlay(initials.foregroundStyle(.primary))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var initials: some View {
        Text(verbatim: Mail.initials(mail.from)).font(.system(size: size * 0.38, weight: .semibold))
    }

    /// The verified logo, drawn by the system's image decoder from the hub's SVG bytes (never as a page). Nil where
    /// the system cannot draw it: then the initials show.
    private var logo: Image? {
        guard let d = mail.logo_domain, let data = Mail.logoData(logos[d]) else { return nil }
        #if os(iOS)
        return UIImage(data: data).map { Image(uiImage: $0) }
        #else
        return NSImage(data: data).map { Image(nsImage: $0) }
        #endif
    }
}

/// A bundle as one row: its icon on its color, its name in its color, how many are new (else how many), who they are
/// from, and when the newest came. Tapping opens it in place.
struct MailBundleRow: View {
    var bundle: Mail.Bundle
    var mails: [MailThread]
    var open: Bool

    var body: some View {
        let unread = mails.filter(\.isUnread).count
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(unread > 0 ? AnyShapeStyle(MailWord(key: .place("inbox"))) : AnyShapeStyle(Color.clear))
                .frame(width: 8, height: 8)
                .padding(.top, 15)
                .accessibilityHidden(true)
            RoundedRectangle(cornerRadius: 10)
                .fill(MailFill(key: bundle.colorKey))
                .overlay(Image(systemName: bundle.symbol).font(.system(size: 16, weight: .semibold)).foregroundStyle(.white))
                .frame(width: 38, height: 38)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(verbatim: bundle.name).fontWeight(.bold).foregroundStyle(MailWord(key: bundle.colorKey))
                    Text(unread > 0 ? "\(unread) new" : "\(mails.count)")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 7).padding(.vertical, 1)
                        .foregroundStyle(.white)
                        .background(Capsule().fill(MailFill(key: bundle.colorKey)))
                    Spacer(minLength: 6)
                    Text(verbatim: mails.first.map { Mail.whenLabel($0.summary.at) } ?? "").font(.caption).foregroundStyle(.secondary)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                Text(verbatim: line).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityHint(open ? "Hides its mail" : "Shows its mail")
    }

    /// The Trips row says the next trip not over yet ("Trip to JFK, Dec 3 to 6"), else who the mail is from.
    private var line: String {
        if bundle.id == "trips", let next = Mail.trips(mails, members: { $0.members }).first, next.end.addingTimeInterval(86_400) >= Date() {
            return "\(next.name), \(Mail.tripDates(start: next.start, end: next.end))"
        }
        return Mail.sendersLine(mails)
    }
}

/// A reminder that is due, among the mail: its title and when it came due. Swipe for Done and Snooze; a tap opens it
/// in Tasks.
struct MailReminderRow: View {
    var reminder: Mail.DueReminder
    var now: Date

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Color.clear.frame(width: 8, height: 8)
            Circle()
                .fill(MailFill(key: .place("snoozed")))
                .overlay(Image(systemName: "bell").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white))
                .frame(width: 38, height: 38)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(verbatim: reminder.title).fontWeight(.bold).lineLimit(2)
                    Spacer(minLength: 6)
                    Text(verbatim: Mail.whenLabel(ISO.string(reminder.at), now: now)).font(.caption).foregroundStyle(.secondary)
                }
                Text("Reminder").font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// Mail text with the https addresses written in it as links (the address itself is the link's text), opened outside
/// the app; an address in another alphabet's letters has its real host beside it. Plain text otherwise, never Markdown.
struct MailLinkedText: View {
    var text: String

    var body: some View {
        Text(attributed)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var attributed: AttributedString {
        var out = AttributedString()
        for (i, line) in text.components(separatedBy: "\n").enumerated() {
            if i > 0 { out += AttributedString("\n") }
            for p in Mail.textParts(line) {
                var run = AttributedString(p.text)
                if let h = p.href, let url = URL(string: h) {
                    run.link = url
                    run.underlineStyle = .single
                }
                out += run
                if let w = p.warnHost {
                    // In bold rather than a color, so it reads on any page.
                    var warn = AttributedString(" (\(w))")
                    warn.inlinePresentationIntent = .stronglyEmphasized
                    out += warn
                }
            }
        }
        return out
    }
}
