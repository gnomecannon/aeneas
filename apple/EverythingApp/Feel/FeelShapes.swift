import SwiftUI
import EACore
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// The shapes in one window. Each burst is a handful of precomputed particles drawn by `FeelOverlay`
/// until its time runs out; with no bursts left the overlay's timeline pauses, so nothing runs while idle.
@MainActor @Observable
final class FeelShapes {
    enum Kind { case tap, create, complete, trail }

    /// What a particle draws: one of the eight shapes in a palette color, or an uploaded image in its own colors.
    enum Item {
        case shape(FeelShapeKind)
        case image(Image)
    }

    /// Everything a burst needs from the setting, gathered once when it starts.
    struct Style {
        var items: [Item]
        var colors: [Color]
        var size: CGFloat = 1
        var density: CGFloat = 1
    }

    struct Particle {
        var item: Int
        var filled: Bool
        var size: CGFloat
        var color: Int
        var angle: CGFloat
        var distance: CGFloat
        var spin: CGFloat
        var rotation: CGFloat
    }

    struct Burst: Identifiable {
        let id: Int
        let origin: CGPoint
        let start: Date
        let duration: Double
        let gravity: CGFloat
        let ring: CGFloat       // 0 for none
        let colors: [Color]
        let items: [Item]
        let particles: [Particle]
    }

    private(set) var bursts: [Burst] = []
    @ObservationIgnored var size: CGSize = .zero
    @ObservationIgnored private var nextId = 0

    func burst(_ kind: Kind, at point: CGPoint, style: Style) {
        guard !style.colors.isEmpty else { return }
        let items = style.items.isEmpty ? [Item.shape(.circle)] : style.items
        let n = items.count, c = style.colors.count
        let k = style.size, d = style.density
        func count(_ r: ClosedRange<Int>) -> Int { max(1, Int((Double(Int.random(in: r)) * Double(d)).rounded())) }
        nextId += 1
        let b: Burst
        switch kind {
        case .tap:
            b = Burst(id: nextId, origin: point, start: Date(), duration: 0.55, gravity: 0, ring: 0, colors: style.colors, items: items,
                      particles: Self.scatter(count: count(6...10), size: (6 * k)...(14 * k), distance: 30...70, items: n, colors: c))
        case .create:
            b = Burst(id: nextId, origin: point, start: Date(), duration: 0.9, gravity: 70, ring: 130, colors: style.colors, items: items,
                      particles: Self.scatter(count: count(24...36), size: (7 * k)...(15 * k), distance: 80...180, items: n, colors: c))
        case .complete:
            b = Burst(id: nextId, origin: point, start: Date(), duration: 0.85, gravity: 0, ring: 110, colors: style.colors, items: items,
                      particles: Self.starburst(rays: max(6, Int((14 * Double(d)).rounded())), size: k, items: n, colors: c))
        case .trail:
            b = Burst(id: nextId, origin: point, start: Date(), duration: 0.45, gravity: 0, ring: 0, colors: style.colors, items: items,
                      particles: Self.scatter(count: Int.random(in: 1...2), size: (5 * k)...(9 * k), distance: 8...22, items: n, colors: c))
        }
        bursts.append(b)
        if bursts.count > 16 { bursts.removeFirst(bursts.count - 16) }
        let id = b.id
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64((b.duration + 0.05) * 1_000_000_000))
            self?.bursts.removeAll { $0.id == id }
        }
    }

    private static func scatter(count: Int, size: ClosedRange<CGFloat>, distance: ClosedRange<CGFloat>, items: Int, colors: Int) -> [Particle] {
        let offset = CGFloat.random(in: 0...(2 * .pi))
        return (0..<count).map { i in
            Particle(item: Int.random(in: 0..<items), filled: Bool.random(), size: .random(in: size), color: Int.random(in: 0..<colors),
                     angle: offset + CGFloat(i) / CGFloat(count) * 2 * .pi + .random(in: -0.3...0.3),
                     distance: .random(in: distance), spin: .random(in: -4...4), rotation: .random(in: 0...(2 * .pi)))
        }
    }

    /// Two rings of rays, evenly spaced and alternating color and shape, for a finished thing.
    private static func starburst(rays: Int, size k: CGFloat, items: Int, colors: Int) -> [Particle] {
        let offset = CGFloat.random(in: 0...(2 * .pi))
        var out: [Particle] = []
        for i in 0..<rays {
            let a = offset + CGFloat(i) / CGFloat(rays) * 2 * .pi
            out.append(Particle(item: i % items, filled: true, size: 11 * k, color: i % colors, angle: a, distance: 120, spin: 0, rotation: a))
            out.append(Particle(item: (i + 1) % items, filled: i % 3 != 0, size: 8 * k, color: (i + 1) % colors,
                                angle: a + .pi / CGFloat(rays), distance: 70, spin: 3, rotation: a))
        }
        return out
    }
}

/// Mounted over the root view: draws the bursts and tracks touches for the window it is in.
struct FeelOverlay: View {
    @State private var shapes = FeelShapes()

    var body: some View {
        FeelCanvas(shapes: shapes)
            .background(FeelAnchor(shapes: shapes))
            .onGeometryChange(for: CGSize.self) { $0.size } action: { shapes.size = $0 }
            .allowsHitTesting(false)
            .ignoresSafeArea()
            .accessibilityHidden(true)
            .onAppear { FeelController.shared.attachShapes(shapes) }
    }
}

/// Draws one `FeelShapes`. Also used for the previews in Settings.
struct FeelCanvas: View {
    let shapes: FeelShapes

    var body: some View {
        let bursts = shapes.bursts
        TimelineView(.animation(minimumInterval: nil, paused: bursts.isEmpty)) { tl in
            Canvas { ctx, _ in
                for b in bursts { Self.draw(b, at: tl.date, in: ctx) }
            }
        }
    }

    private typealias Burst = FeelShapes.Burst

    private static func draw(_ b: Burst, at now: Date, in ctx: GraphicsContext) {
        let t = min(1, max(0, now.timeIntervalSince(b.start) / b.duration))
        if t >= 1 { return }
        let ease = CGFloat(1 - pow(1 - t, 3))
        let fade = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45
        if b.ring > 0 {
            let r = b.ring * CGFloat(1 - pow(1 - t, 2))
            var c = ctx
            c.opacity = (1 - t) * 0.9
            let rect = CGRect(x: b.origin.x - r, y: b.origin.y - r, width: 2 * r, height: 2 * r)
            c.stroke(Path(ellipseIn: rect), with: .color(b.colors[0]), lineWidth: 1 + 4 * CGFloat(1 - t))
        }
        let scale = 1 - 0.35 * CGFloat(t)
        for p in b.particles {
            let x = b.origin.x + cos(p.angle) * p.distance * ease
            let y = b.origin.y + sin(p.angle) * p.distance * ease + b.gravity * CGFloat(t * t)
            var c = ctx
            c.opacity = fade
            c.translateBy(x: x, y: y)
            c.rotate(by: .radians(Double(p.rotation + p.spin * ease)))
            let size = p.size * scale
            switch b.items[p.item % b.items.count] {
            case .image(let img):
                // Images keep their own colors and are drawn a little larger so they read as pictures.
                let s = size * 2.5
                c.draw(img, in: CGRect(x: -s / 2, y: -s / 2, width: s, height: s))
            case .shape(let kind):
                let color = b.colors[p.color % b.colors.count]
                FeelShapePath.draw(kind, size: size, filled: p.filled, color: color, in: &c)
            }
        }
    }
}

/// The eight shapes, centred on the origin.
enum FeelShapePath {
    static func draw(_ kind: FeelShapeKind, size: CGFloat, filled: Bool, color: Color, in c: inout GraphicsContext) {
        let path = path(kind, size: size)
        switch kind {
        case .ring: c.stroke(path, with: .color(color), lineWidth: max(1.4, size * 0.18))
        case .spark: c.fill(path, with: .color(color))
        default:
            if filled { c.fill(path, with: .color(color)) } else { c.stroke(path, with: .color(color), lineWidth: 1.6) }
        }
    }

    static func path(_ kind: FeelShapeKind, size: CGFloat) -> Path {
        let r = size / 2
        switch kind {
        case .triangle: return polygon(sides: 3, radius: r * 1.15)
        case .square: return Path(CGRect(x: -r, y: -r, width: size, height: size))
        case .circle: return Path(ellipseIn: CGRect(x: -r, y: -r, width: size, height: size))
        case .hexagon: return polygon(sides: 6, radius: r)
        case .diamond:
            var p = Path()
            p.move(to: CGPoint(x: 0, y: -r * 1.3)); p.addLine(to: CGPoint(x: r * 0.8, y: 0))
            p.addLine(to: CGPoint(x: 0, y: r * 1.3)); p.addLine(to: CGPoint(x: -r * 0.8, y: 0)); p.closeSubpath()
            return p
        case .star: return star(points: 5, outer: r * 1.25, inner: r * 0.52)
        case .ring:
            let rr = r * 1.05
            return Path(ellipseIn: CGRect(x: -rr, y: -rr, width: 2 * rr, height: 2 * rr))
        case .spark: return star(points: 4, outer: r * 1.35, inner: r * 0.3)
        }
    }

    private static func polygon(sides: Int, radius: CGFloat) -> Path {
        var p = Path()
        for i in 0..<sides {
            let a = -CGFloat.pi / 2 + CGFloat(i) / CGFloat(sides) * 2 * .pi
            let pt = CGPoint(x: cos(a) * radius, y: sin(a) * radius)
            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
        }
        p.closeSubpath()
        return p
    }

    private static func star(points: Int, outer: CGFloat, inner: CGFloat) -> Path {
        var p = Path()
        for i in 0..<(points * 2) {
            let a = -CGFloat.pi / 2 + CGFloat(i) / CGFloat(points * 2) * 2 * .pi
            let r = i % 2 == 0 ? outer : inner
            let pt = CGPoint(x: cos(a) * r, y: sin(a) * r)
            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
        }
        p.closeSubpath()
        return p
    }
}

/// One shape drawn as a burst would draw it, for the shape grid in Settings.
struct FeelShapeIcon: View {
    var kind: FeelShapeKind
    var color: Color
    var size: CGFloat = 26

    var body: some View {
        Canvas { ctx, sz in
            var c = ctx
            c.translateBy(x: sz.width / 2, y: sz.height / 2)
            FeelShapePath.draw(kind, size: size, filled: true, color: color, in: &c)
        }
        .frame(width: size * 1.8, height: size * 1.8)
        .accessibilityHidden(true)
    }
}

// MARK: touch tracking

#if os(iOS)
/// Watches every touch a window delivers, from down to up, without taking part in gesture handling at all: the
/// window's own `sendEvent` runs first and untouched, then each touch's phase is reported. Nothing can be delayed,
/// cancelled or blocked, and moves keep coming while a list scrolls. (A gesture recognizer that stays possible to
/// follow the whole touch stops iOS switches from toggling, so this observes instead.)
@MainActor
enum FeelTouchObserver {
    private static var anchors = NSMapTable<UIWindow, FeelAnchorView>.weakToWeakObjects()
    private static var installed = false

    static func register(_ anchor: FeelAnchorView, in window: UIWindow) {
        anchors.setObject(anchor, forKey: window)
        install()
    }

    static func unregister(_ anchor: FeelAnchorView) {
        for w in anchors.keyEnumerator().allObjects.compactMap({ $0 as? UIWindow }) where anchors.object(forKey: w) === anchor {
            anchors.removeObject(forKey: w)
        }
    }

    private static func install() {
        guard !installed else { return }
        installed = true
        let cls: AnyClass = UIWindow.self
        let original = #selector(UIWindow.sendEvent(_:))
        let replacement = #selector(UIWindow.ea_sendEvent(_:))
        guard let a = class_getInstanceMethod(cls, original), let b = class_getInstanceMethod(cls, replacement) else { return }
        if class_addMethod(cls, original, method_getImplementation(b), method_getTypeEncoding(b)) {
            class_replaceMethod(cls, replacement, method_getImplementation(a), method_getTypeEncoding(a))
        } else {
            method_exchangeImplementations(a, b)
        }
    }

    static func observe(_ event: UIEvent, in window: UIWindow) {
        guard event.type == .touches, let anchor = anchors.object(forKey: window), let touches = event.allTouches else { return }
        let feel = FeelController.shared
        for t in touches where t.window === window || t.window == nil {
            let key = ObjectIdentifier(t)
            switch t.phase {
            case .began: feel.pressBegan(key, at: t.location(in: anchor), in: anchor.shapes)
            case .moved: feel.pressMoved(key, to: t.location(in: anchor))
            case .ended, .cancelled: feel.pressEnded(key)
            default: break
            }
        }
    }
}

extension UIWindow {
    @objc func ea_sendEvent(_ event: UIEvent) {
        ea_sendEvent(event)   // the original, after the exchange
        MainActor.assumeIsolated { FeelTouchObserver.observe(event, in: self) }
    }
}

/// Sits behind the overlay with its exact frame; registers the window it lands in so its touches are followed.
final class FeelAnchorView: UIView {
    weak var shapes: FeelShapes?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        detach()
        if let w = window { FeelTouchObserver.register(self, in: w) }
    }

    func detach() { FeelTouchObserver.unregister(self) }
}

struct FeelAnchor: UIViewRepresentable {
    let shapes: FeelShapes
    func makeUIView(context: Context) -> FeelAnchorView {
        let v = FeelAnchorView()
        v.isUserInteractionEnabled = false
        v.backgroundColor = .clear
        v.shapes = shapes
        return v
    }
    func updateUIView(_ v: FeelAnchorView, context: Context) { v.shapes = shapes }
    static func dismantleUIView(_ v: FeelAnchorView, coordinator: ()) { v.detach() }
}
#elseif os(macOS)
/// Sits behind the overlay with its exact frame so a click's window point converts to overlay coordinates.
final class FeelAnchorView: NSView {
    weak var shapes: FeelShapes?
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { FeelController.shared.register(self) }
    }
}

struct FeelAnchor: NSViewRepresentable {
    let shapes: FeelShapes
    func makeNSView(context: Context) -> FeelAnchorView {
        let v = FeelAnchorView()
        v.shapes = shapes
        return v
    }
    func updateNSView(_ v: FeelAnchorView, context: Context) { v.shapes = shapes }
}
#endif
