import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import EACore
#if os(iOS)
import UIKit
#endif

/// Shapes a tap throws: on or off, the palette, which shapes and images, how big and how many.
struct TapEffectsView: View {
    @ObservedObject private var feel = FeelController.shared
    @State private var editing: PaletteDraft?
    @State private var renaming: FeelPalette?
    @State private var renamingImage: FeelImage?
    @State private var newName = ""
    @State private var deleting: FeelPalette?
    @State private var deletingImage: FeelImage?
    @State private var photo: PhotosPickerItem?
    @State private var importing = false
    @State private var busy = false
    @State private var imageMessage: String?
    @State private var previewTick = 0

    private var s: FeelSettings { feel.settings }
    private var lastOn: Int { s.shapes.count + s.enabledImages.count }

    var body: some View {
        Form {
            SwiftUI.Section {
                Toggle("Shapes on taps and new things", isOn: Binding(get: { s.motion }, set: { feel.change(["motion": .bool($0)]) }))
                BurstPreview(style: feel.style, tick: previewTick)
            }
            .themedRow()

            SwiftUI.Section {
                ForEach(FeelTheme.order, id: \.self) { t in paletteRow(t, saved: nil) }
                ForEach(s.palettes) { p in paletteRow("custom:\(p.id)", saved: p) }
                if s.palettes.count < FeelPalette.maxCount {
                    Button { newPalette() } label: { Label("New palette", systemImage: "plus.circle") }
                }
            } header: {
                Text("Colors")
            } footer: {
                Text("Tap a palette to use it. Use the menu on a palette to edit, rename, copy or delete it.")
            }
            .themedRow()

            SwiftUI.Section {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 64), spacing: 8)], spacing: 8) {
                    ForEach(FeelShapeKind.allCases, id: \.self) { k in shapeToggle(k) }
                }
                .padding(.vertical, 4)
            } header: {
                Text("Shapes")
            } footer: {
                Text(lastOn <= 1 ? "Keep at least one shape or image on." : "Tap a shape to turn it on or off.")
            }
            .themedRow()

            imagesSection

            SwiftUI.Section("Size and amount") {
                sliderRow("Size", value: s.shape_size, field: "shape_size", small: "circle.fill", big: "circle.fill")
                sliderRow("Amount", value: s.density, field: "density", small: "circle.grid.2x1", big: "circle.grid.3x3.fill")
            }
            .themedRow()
        }
        .formStyle(.grouped)
        .themedScreen()
        .navigationTitle("Tap effects")
        .sheet(item: $editing) { d in PaletteEditor(draft: d) }
        .alert("Rename", isPresented: Binding(get: { renaming != nil || renamingImage != nil }, set: { if !$0 { renaming = nil; renamingImage = nil } })) {
            TextField("Name", text: $newName)
            Button("Save") {
                if var p = renaming { p.name = FeelID.name(newName, fallback: p.name); feel.savePalette(p) }
                if let i = renamingImage { feel.renameImage(i.id, to: newName) }
                renaming = nil; renamingImage = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil; renamingImage = nil }
        }
        .confirmationDialog("Delete \(deleting?.name ?? deletingImage?.name ?? "")?",
                            isPresented: Binding(get: { deleting != nil || deletingImage != nil }, set: { if !$0 { deleting = nil; deletingImage = nil } }),
                            titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let p = deleting { feel.deletePalette(p.id) }
                if let i = deletingImage { removeImage(i) }
                deleting = nil; deletingImage = nil
            }
        }
        .onChange(of: photo) { _, item in if let item { addPhoto(item) } }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.png, .webP, .image]) { result in
            if case .success(let url) = result { addFile(url) }
        }
    }

    // MARK: palettes

    private func paletteRow(_ choice: String, saved: FeelPalette?) -> some View {
        let selected = s.theme == choice
        let name = saved?.name ?? FeelTheme.name(choice)
        return HStack(spacing: 10) {
            Button {
                feel.change(["theme": .string(choice)])
                previewTick += 1
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "checkmark").foregroundStyle(.tint).opacity(selected ? 1 : 0).frame(width: 18)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(name).lineLimit(1)
                        SwatchRow(colors: feel.colors(for: choice))
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(selected ? .isSelected : [])
            Menu {
                if let p = saved {
                    Button { editing = PaletteDraft(palette: p, isNew: false) } label: { Label("Edit", systemImage: "slider.horizontal.3") }
                    Button { newName = p.name; renaming = p } label: { Label("Rename", systemImage: "pencil") }
                    Button { duplicate(name: p.name, colors: p.colors) } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
                    Button(role: .destructive) { deleting = p } label: { Label("Delete", systemImage: "trash") }
                } else {
                    Button { customize(name: name, choice: choice) } label: { Label("Customize", systemImage: "slider.horizontal.3") }
                }
            } label: {
                Image(systemName: "ellipsis.circle").font(.title3).foregroundStyle(.secondary)
                    .frame(width: 36, height: 36).contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("More for \(name)")
        }
    }

    private func newPalette() {
        let start = s.paletteHexes.isEmpty ? FeelTheme.palettes["aurora"]! : s.paletteHexes
        editing = PaletteDraft(palette: FeelPalette(id: "", name: "My colors", colors: start), isNew: true)
    }

    private func customize(name: String, choice: String) {
        let colors = choice == "mono" ? feel.colors(for: choice).map(FeelController.hex) : FeelTheme.hexes(theme: choice, palettes: s.palettes)
        editing = PaletteDraft(palette: FeelPalette(id: "", name: FeelID.copyName(name, taken: s.palettes.map(\.name)), colors: colors), isNew: true)
    }

    private func duplicate(name: String, colors: [String]) {
        feel.newPalette(name: FeelID.copyName(name, taken: s.palettes.map(\.name)), colors: colors)
    }

    // MARK: shapes

    private func shapeToggle(_ k: FeelShapeKind) -> some View {
        let on = s.shapes.contains(k.rawValue)
        let color = feel.palette.first ?? .accentColor
        return Button {
            guard !(on && lastOn <= 1) else { return }
            let next = on ? s.shapes.filter { $0 != k.rawValue } : FeelShapeKind.allCases.map(\.rawValue).filter { $0 == k.rawValue || s.shapes.contains($0) }
            feel.change(["shapes": .array(next.map { .string($0) })])
            previewTick += 1
        } label: {
            VStack(spacing: 2) {
                FeelShapeIcon(kind: k, color: on ? color : .secondary.opacity(0.5), size: 22)
                Text(k.title).font(.caption2).foregroundStyle(on ? .primary : .secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 64)
            .background(RoundedRectangle(cornerRadius: 10).fill(on ? AnyShapeStyle(.tint.opacity(0.15)) : AnyShapeStyle(.clear)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(on ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary.opacity(0.3)), lineWidth: on ? 2 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(k.title)
        .accessibilityValue(on ? "On" : "Off")
    }

    // MARK: images

    private var imagesSection: some View {
        SwiftUI.Section {
            ForEach(s.images) { img in imageRow(img) }
            if s.images.count < FeelImage.maxCount {
                PhotosPicker(selection: $photo, matching: .images) {
                    Label("Add image from Photos", systemImage: "photo.badge.plus")
                }
                .disabled(busy)
                Button { importing = true } label: { Label("Add image from Files", systemImage: "folder.badge.plus") }
                    .disabled(busy)
            }
            if busy { ProgressView().frame(maxWidth: .infinity) }
            if let m = imageMessage { Text(m).font(.caption).foregroundStyle(.secondary) }
        } header: {
            Text("Images")
        } footer: {
            Text("Images with transparent backgrounds look best.")
        }
        .themedRow()
    }

    private func imageRow(_ img: FeelImage) -> some View {
        HStack(spacing: 12) {
            ZStack {
                Checkerboard().clipShape(RoundedRectangle(cornerRadius: 8))
                if let i = feel.images.image(img.id) {
                    i.resizable().scaledToFit().padding(4)
                } else {
                    ProgressView()
                }
            }
            .frame(width: 52, height: 52)
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.secondary.opacity(0.3)))
            Toggle(img.name, isOn: Binding(get: { img.enabled }, set: { on in
                if !on && lastOn <= 1 { return }
                feel.setImage(img.id, enabled: on)
                previewTick += 1
            }))
            Menu {
                Button { newName = img.name; renamingImage = img } label: { Label("Rename", systemImage: "pencil") }
                Button(role: .destructive) { deletingImage = img } label: { Label("Delete", systemImage: "trash") }
            } label: {
                Image(systemName: "ellipsis.circle").font(.title3).foregroundStyle(.secondary)
                    .frame(width: 36, height: 36).contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("More for \(img.name)")
        }
    }

    private func addPhoto(_ item: PhotosPickerItem) {
        busy = true
        imageMessage = nil
        Task {
            defer { busy = false; photo = nil }
            guard let data = try? await item.loadTransferable(type: Data.self) else { imageMessage = "Could not read that photo."; return }
            await upload(data, name: "Image \(s.images.count + 1)")
        }
    }

    private func addFile(_ url: URL) {
        busy = true
        imageMessage = nil
        Task {
            defer { busy = false }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { imageMessage = "Could not read that file."; return }
            await upload(data, name: url.deletingPathExtension().lastPathComponent)
        }
    }

    private func upload(_ data: Data, name: String) async {
        guard let png = ImageShrinker.png(from: data) else { imageMessage = "That file is not an image this app can read."; return }
        do {
            try await feel.addImage(png: png, name: name)
            previewTick += 1
        } catch {
            imageMessage = (error as? HubError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func removeImage(_ img: FeelImage) {
        busy = true
        Task {
            defer { busy = false }
            do { try await feel.deleteImage(img.id) } catch { imageMessage = (error as? HubError)?.errorDescription ?? error.localizedDescription }
        }
    }

    // MARK: sliders

    private func sliderRow(_ label: String, value: Double, field: String, small: String, big: String) -> some View {
        HStack {
            Text(label).frame(width: 70, alignment: .leading)
            Image(systemName: small).font(.caption2).foregroundStyle(.secondary)
            Slider(value: Binding(get: { value }, set: { feel.change([field: .number(($0 * 20).rounded() / 20)], debounce: true) }), in: 0.5...2) { editing in
                if !editing { previewTick += 1 }
            }
            Image(systemName: big).font(.body).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

/// A row of color dots.
struct SwatchRow: View {
    var colors: [Color]
    var size: CGFloat = 16

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(colors.enumerated()), id: \.offset) { _, c in
                Circle().fill(c).frame(width: size, height: size)
                    .overlay(Circle().strokeBorder(.primary.opacity(0.15), lineWidth: 0.5))
            }
        }
        .accessibilityHidden(true)
    }
}

/// Light and dark squares, so a translucent image shows what is see-through.
struct Checkerboard: View {
    var square: CGFloat = 8

    var body: some View {
        Canvas { ctx, size in
            ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(white: 0.92)))
            let cols = Int(ceil(size.width / square)), rows = Int(ceil(size.height / square))
            for r in 0..<rows {
                for c in 0..<cols where (r + c) % 2 == 1 {
                    ctx.fill(Path(CGRect(x: CGFloat(c) * square, y: CGFloat(r) * square, width: square, height: square)), with: .color(Color(white: 0.75)))
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// A box that bursts in the middle whenever `tick` changes or it is tapped, drawn with the given style.
struct BurstPreview: View {
    var style: FeelShapes.Style
    var tick: Int
    var height: CGFloat = 120
    @State private var shapes = FeelShapes()
    @State private var size: CGSize = .zero

    var body: some View {
        FeelCanvas(shapes: shapes)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .background(RoundedRectangle(cornerRadius: 12).fill(.secondary.opacity(0.08)))
            .overlay {
                Text("Preview").font(.caption).foregroundStyle(.secondary).padding(8)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
            .onChange(of: tick) { _, _ in fire() }
            .onAppear { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { fire() } }
            .accessibilityHidden(true)
    }

    private func fire() {
        guard size.width > 0 else { return }
        shapes.burst(.create, at: CGPoint(x: size.width / 2, y: size.height / 2), style: FeelShapes.Style(
            items: style.items, colors: style.colors, size: style.size, density: style.density * 0.5))
    }
}

// MARK: palette editor

struct PaletteDraft: Identifiable {
    var palette: FeelPalette
    var isNew: Bool
    var id: String { isNew ? "new" : palette.id }
}

/// Name, up to eight colors as large swatches (tap to change, drag to reorder), and a live preview burst.
struct PaletteEditor: View {
    @ObservedObject private var feel = FeelController.shared
    @Environment(\.dismiss) private var dismiss
    @State private var p: FeelPalette
    @State private var tick = 0
    private let isNew: Bool

    init(draft: PaletteDraft) {
        _p = State(initialValue: draft.palette)
        isNew = draft.isNew
    }

    private var colors: [Color] { p.colors.compactMap(FeelController.color) }

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    TextField("Name", text: $p.name)
                }
                .themedRow()
                SwiftUI.Section {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 68), spacing: 14)], spacing: 14) {
                        ForEach(Array(p.colors.enumerated()), id: \.offset) { i, hex in swatch(i, hex) }
                        if p.colors.count < FeelPalette.maxColors {
                            Button { add() } label: {
                                Circle().strokeBorder(.secondary, style: StrokeStyle(lineWidth: 2, dash: [5]))
                                    .frame(width: 60, height: 60)
                                    .overlay(Image(systemName: "plus").font(.title2).foregroundStyle(.secondary))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Add a color")
                        }
                    }
                    .padding(.vertical, 6)
                } header: {
                    Text("Colors")
                } footer: {
                    Text("Tap a color to change it. Drag one onto another to reorder. Up to \(FeelPalette.maxColors).")
                }
                .themedRow()
                SwiftUI.Section {
                    BurstPreview(style: FeelShapes.Style(items: feel.style.items, colors: colors, size: feel.settings.shape_size,
                                                         density: feel.settings.density), tick: tick, height: 140)
                }
                .themedRow()
            }
            .formStyle(.grouped)
            .themedScreen()
            .navigationTitle(isNew ? "New palette" : "Edit palette")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(p.colors.isEmpty) }
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 520)
        #endif
    }

    private func swatch(_ i: Int, _ hex: String) -> some View {
        let binding = Binding<Color>(get: { FeelController.color(hex) ?? .gray }, set: { c in
            guard p.colors.indices.contains(i) else { return }
            p.colors[i] = FeelController.hex(c)
        })
        return ZStack(alignment: .topTrailing) {
            #if os(iOS)
            Button {
                ColorSheet.present(binding.wrappedValue) { c in binding.wrappedValue = c } done: { tick += 1 }
            } label: {
                Circle().fill(binding.wrappedValue).frame(width: 60, height: 60)
                    .overlay(Circle().strokeBorder(.primary.opacity(0.2), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Color \(i + 1)")
            #else
            VStack(spacing: 4) {
                Circle().fill(binding.wrappedValue).frame(width: 52, height: 52)
                    .overlay(Circle().strokeBorder(.primary.opacity(0.2), lineWidth: 1))
                ColorPicker("Color \(i + 1)", selection: binding, supportsOpacity: false).labelsHidden()
            }
            #endif
            if p.colors.count > 1 {
                Button { remove(i) } label: {
                    Image(systemName: "xmark.circle.fill").font(.title3).symbolRenderingMode(.palette)
                        .foregroundStyle(.white, .gray)
                }
                .buttonStyle(.plain)
                .offset(x: 6, y: -6)
                .accessibilityLabel("Remove color \(i + 1)")
            }
        }
        .draggable(String(i))
        .dropDestination(for: String.self) { items, _ in
            guard let from = items.first.flatMap(Int.init), p.colors.indices.contains(from), from != i else { return false }
            withAnimation { p.colors.move(fromOffsets: IndexSet(integer: from), toOffset: i > from ? i + 1 : i) }
            return true
        }
        .contextMenu {
            if p.colors.count > 1 { Button(role: .destructive) { remove(i) } label: { Label("Remove", systemImage: "trash") } }
        }
    }

    private func add() {
        let pool = FeelTheme.order.flatMap { FeelTheme.palettes[$0] ?? [] }
        let next = pool.first { !p.colors.contains($0) } ?? "#7C5CFF"
        p.colors.append(next)
        tick += 1
    }

    private func remove(_ i: Int) {
        guard p.colors.count > 1, p.colors.indices.contains(i) else { return }
        _ = withAnimation { p.colors.remove(at: i) }
        tick += 1
    }

    private func save() {
        p.name = FeelID.name(p.name, fallback: "My colors")
        if isNew {
            feel.newPalette(name: p.name, colors: p.colors, select: true)
        } else {
            feel.savePalette(p, select: true)
        }
        feel.tryIt()
        dismiss()
    }
}

#if os(iOS)
/// The system color picker as a sheet over whatever is on screen, reporting every change as it happens.
@MainActor
enum ColorSheet {
    private static var current: Coordinator?

    static func present(_ color: Color, change: @escaping (Color) -> Void, done: @escaping () -> Void) {
        guard let top = topController() else { return }
        let picker = UIColorPickerViewController()
        picker.supportsAlpha = false
        picker.selectedColor = UIColor(color)
        let c = Coordinator(change: change, done: done)
        picker.delegate = c
        current = c
        if let sheet = picker.sheetPresentationController { sheet.detents = [.medium(), .large()] }
        top.present(picker, animated: true)
    }

    private static func topController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        var vc = scene?.windows.first { $0.isKeyWindow }?.rootViewController
        while let next = vc?.presentedViewController { vc = next }
        return vc
    }

    final class Coordinator: NSObject, UIColorPickerViewControllerDelegate {
        let change: (Color) -> Void
        let done: () -> Void
        init(change: @escaping (Color) -> Void, done: @escaping () -> Void) { self.change = change; self.done = done }

        func colorPickerViewController(_ vc: UIColorPickerViewController, didSelect color: UIColor, continuously: Bool) {
            change(Color(uiColor: color))
        }

        func colorPickerViewControllerDidFinish(_ vc: UIColorPickerViewController) {
            done()
            ColorSheet.current = nil
        }
    }
}
#endif
