import SwiftUI
import EACore
#if os(macOS)
import AppKit
#endif

// The Mac's Mail list as the web's (gnomecannon/aeneas#29): one column of boxes, a little apart, where a mail opens in
// place (MailView). The iPhone and iPad keep their own list, which draws its rows and headings itself: there these
// modifiers change nothing.

extension View {
    /// A heading over a part of the mail list (a day, Needs you, Back later today). On the Mac it is the web's: small,
    /// gray, with room above it.
    @ViewBuilder func mailHeading() -> some View {
        #if os(macOS)
        self.font(.subheadline.weight(.semibold)).foregroundStyle(.secondary).padding(.top, 12).padding(.horizontal, 4)
        #else
        self
        #endif
    }

    /// A note under a part of the mail list (Needs you's "It can be wrong").
    @ViewBuilder func mailFootnote() -> some View {
        #if os(macOS)
        self.font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 4)
        #else
        self
        #endif
    }

    /// On the Mac a row of the mail list is a box of its own (`boxed`), as on the web; a row inside a bundle's box is
    /// not. The keyboard's row has a bar in the accent on its left, a selected one a tint of it. `padded`: an open mail,
    /// with room around it.
    @ViewBuilder func mailBox(cursor: Bool = false, picked: Bool = false, padded: Bool = false, boxed: Bool = true) -> some View {
        #if os(macOS)
        modifier(MailBoxStyle(cursor: cursor, picked: picked, padded: padded, boxed: boxed))
        #else
        self
        #endif
    }

    /// A line of the Mac's list that is not a box (a note, a setting), in line with the headings.
    @ViewBuilder func mailInset() -> some View {
        #if os(macOS)
        self.padding(.horizontal, 4)
        #else
        self
        #endif
    }

    /// Room inside a box of the Mac's list that is not a MailMacRow (a Needs you row, a trip), the same as a row's.
    @ViewBuilder func mailRowPadding() -> some View {
        #if os(macOS)
        self.padding(.horizontal, 10).padding(.vertical, 7)
        #else
        self
        #endif
    }

    /// Words that can be selected and copied, except in an open mail's heading in place in the list, which is a button.
    @ViewBuilder func mailSelectable(_ on: Bool) -> some View {
        if on { textSelection(.enabled) } else { self }
    }
}

/// An open mail's title on its own page; none in place in the list, where the place's name stays the window's title.
struct MailPageTitle: ViewModifier {
    var title: String
    var shown: Bool

    func body(content: Content) -> some View {
        if shown { content.navigationTitle(title) } else { content }
    }
}

/// The heading of an open mail. In place in the list (the Mac) it is a button that closes the mail again, as the web's
/// is, with a chevron saying so; on its own page it is only the heading.
struct MailOpenHeading<Content: View>: View {
    var inline: Bool
    var close: () -> Void
    @ViewBuilder var content: () -> Content

    var body: some View {
        if inline {
            Button(action: close) {
                HStack(alignment: .top, spacing: 8) {
                    content()
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.up").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary).padding(.top, 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Close this mail")
            .accessibilityHint("Closes this mail")
        } else {
            content()
        }
    }
}

#if os(macOS)
struct MailBoxStyle: ViewModifier {
    var cursor: Bool
    var picked: Bool
    var padded: Bool
    var boxed: Bool
    @Environment(\.eaTheme) private var theme

    func body(content: Content) -> some View {
        let accent = theme?.accent ?? Color.accentColor
        let shape = RoundedRectangle(cornerRadius: boxed ? 8 : 0, style: .continuous)
        content
            .padding(padded ? 14 : 0)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                if picked { shape.fill(accent.opacity(0.12)) } else if boxed { shape.fill(theme?.surface ?? Color.secondary.opacity(0.08)) }
            }
            .overlay(alignment: .leading) { if cursor { Rectangle().fill(accent).frame(width: 3) } }
            .clipShape(shape)
            .overlay { if boxed { shape.strokeBorder(Color.secondary.opacity(0.22)) } }
    }
}

/// A row of the Mac's mail list, as the web's: a click opens it in place (or closes it again); Command-click selects or
/// unselects a thread, and Shift-click selects every one up to it. Pointed at, a thread's circle turns into a checkbox
/// (every thread's while anything is selected), and its quick actions show over its time.
struct MailMacRow<Label: View, Actions: View>: View {
    var cursor = false
    var picked = false
    /// Something is selected: every thread's circle is a checkbox.
    var picking = false
    /// A thread, which can be selected; a bundle's row, a reminder, a folder's mail or a hit only opens.
    var selectable = true
    /// A box of its own (false: a row inside a bundle's box).
    var boxed = true
    var press: (_ command: Bool, _ shift: Bool) -> Void
    @ViewBuilder var label: () -> Label
    @ViewBuilder var actions: () -> Actions
    @State private var hovering = false
    @Environment(\.eaTheme) private var theme

    var body: some View {
        Button {
            let keys = NSEvent.modifierFlags
            press(keys.contains(.command), keys.contains(.shift))
        } label: {
            label()
                .padding(.horizontal, 10).padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(hovering ? Color.primary.opacity(0.05) : .clear)
        // Exactly over the circle: the row's 10 points, the unread dot's 8 and the 10 between them.
        .overlay(alignment: .topLeading) {
            if selectable && (hovering || picking || picked) { checkbox.padding(.leading, 28).padding(.top, 9) }
        }
        .overlay(alignment: .topTrailing) {
            if hovering {
                HStack(spacing: 0) { actions() }
                    .buttonStyle(.borderless)
                    .labelStyle(.iconOnly)
                    .padding(.horizontal, 4).padding(.vertical, 2)
                    .background(.background, in: RoundedRectangle(cornerRadius: 7))
                    .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color.secondary.opacity(0.22)))
                    .padding(.top, 5).padding(.trailing, 8)
            }
        }
        .mailBox(cursor: cursor, picked: picked, boxed: boxed)
        .onHover { hovering = $0 }
    }

    /// Select or unselect: the circle with a dim check, in the accent with a white one when selected.
    private var checkbox: some View {
        let accent = theme?.accent ?? Color.accentColor
        return Button {
            press(true, NSEvent.modifierFlags.contains(.shift))
        } label: {
            ZStack {
                Circle().fill(picked ? AnyShapeStyle(accent) : AnyShapeStyle(.background))
                Circle().strokeBorder(picked ? accent : Color.secondary, lineWidth: 2)
                Image(systemName: "checkmark")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(picked ? AnyShapeStyle(.white) : AnyShapeStyle(Color.secondary.opacity(0.6)))
            }
            .frame(width: 38, height: 38)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(picked ? "Unselect" : "Select")
        .accessibilityLabel(picked ? "Unselect" : "Select")
        .accessibilityAddTraits(picked ? .isSelected : [])
    }
}
#endif
