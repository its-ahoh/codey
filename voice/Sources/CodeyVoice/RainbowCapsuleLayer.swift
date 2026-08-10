import Cocoa
import QuartzCore

/// The conversation capsule's skin: a dark rounded-rect fill, a rainbow that
/// scrolls horizontally around the outline, and the same rainbow bleeding a
/// short way inward from the edge.
///
/// Ported from the CSS this replaces (the former `VoiceHud.tsx`), which layered
/// two backgrounds — a solid fill clipped to padding-box and a 200%-wide
/// gradient clipped to border-box — and animated `background-position`. Here the
/// outline and the bleed are two masked copies of one gradient driven by one
/// animation, so they cannot drift out of phase the way two CSS layers could.
///
/// Owns no voice state. Callers set `frame` and the layer redraws.
final class RainbowCapsuleLayer: CALayer {

    // ── Tunables ─────────────────────────────────────────────────────
    // Set from a real-hardware look, not from theory. Adjust these first.

    /// Outline thickness. Was 2pt in CSS; widened because the capsule needs to
    /// read at a glance from across the desk.
    static var outlineWidth: CGFloat = 2.5
    /// How far the rainbow bleeds inward from the edge before it is fully
    /// transparent.
    static var bleedDepth: CGFloat = 8
    /// Bleed opacity at the edge, falling to 0 at `bleedDepth`.
    static var bleedPeakAlpha: CGFloat = 0.45
    /// Seconds for the rainbow to travel one full cycle.
    static var scrollDuration: CFTimeInterval = 4

    /// Carried over unchanged from the CSS gradient stops so the colours users
    /// already know do not shift.
    private static let rainbow: [CGColor] = [
        NSColor(srgbRed: 1.00, green: 0.37, blue: 0.43, alpha: 1).cgColor, // #ff5f6d
        NSColor(srgbRed: 1.00, green: 0.76, blue: 0.44, alpha: 1).cgColor, // #ffc371
        NSColor(srgbRed: 0.28, green: 0.90, blue: 0.69, alpha: 1).cgColor, // #47e6b1
        NSColor(srgbRed: 0.22, green: 0.64, blue: 0.96, alpha: 1).cgColor, // #38a3f5
        NSColor(srgbRed: 0.66, green: 0.42, blue: 0.96, alpha: 1).cgColor, // #a86bf5
        NSColor(srgbRed: 1.00, green: 0.37, blue: 0.43, alpha: 1).cgColor, // #ff5f6d
    ]

    private static let fillColor = NSColor(srgbRed: 0.145, green: 0.133, blue: 0.114, alpha: 1).cgColor // #25221d

    private let fillLayer = CALayer()

    // Each rainbow band is a static, unanimated container clipped to a fixed
    // shape (the mask), holding an animated gradient child that slides
    // underneath it. The mask is defined in the container's own local
    // coordinate space, so — unlike a mask set directly on the layer being
    // animated — it never moves: only the color scrolls, the clip stays put.
    private let bleedContainer = CALayer()
    private let outlineContainer = CALayer()
    private let bleedGradient = CAGradientLayer()
    private let outlineGradient = CAGradientLayer()
    private let bleedMask = CALayer()
    private let outlineMask = CAShapeLayer()

    private static let scrollKey = "codey.rainbow.scroll"

    override init() {
        super.init()
        setUp()
    }

    override init(layer: Any) {
        super.init(layer: layer)
        setUp()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setUp()
    }

    private func setUp() {
        masksToBounds = true

        fillLayer.backgroundColor = Self.fillColor
        addSublayer(fillLayer)

        for gradient in [bleedGradient, outlineGradient] {
            gradient.colors = Self.rainbow
            gradient.startPoint = CGPoint(x: 0, y: 0.5)
            gradient.endPoint = CGPoint(x: 1, y: 0.5)
        }

        bleedContainer.mask = bleedMask
        bleedContainer.masksToBounds = true
        bleedContainer.addSublayer(bleedGradient)
        addSublayer(bleedContainer)

        outlineMask.fillColor = NSColor.clear.cgColor
        outlineMask.strokeColor = NSColor.black.cgColor
        outlineContainer.mask = outlineMask
        outlineContainer.masksToBounds = true
        outlineContainer.addSublayer(outlineGradient)
        addSublayer(outlineContainer)
    }

    override func layoutSublayers() {
        super.layoutSublayers()
        let box = bounds
        guard box.width > 0, box.height > 0 else { return }
        let radius = box.height / 2
        cornerRadius = radius

        // Implicit animations would make every resize crossfade; the capsule
        // resizes whenever its label changes, which reads as a wobble.
        CATransaction.begin()
        CATransaction.setDisableActions(true)

        fillLayer.frame = box
        fillLayer.cornerRadius = radius

        // Containers stay put at the capsule's own size — their masks are
        // static, so the visible shape never moves.
        bleedContainer.frame = box
        outlineContainer.frame = box

        // Twice as wide as the capsule so a half-width slide loops seamlessly:
        // the stop list starts and ends on the same colour. These are the only
        // layers that get the scroll animation.
        let wide = CGRect(x: 0, y: 0, width: box.width * 2, height: box.height)
        bleedGradient.frame = wide
        outlineGradient.frame = wide

        // Masks are sized to `box`, not `wide` — they belong to the static
        // containers, so they describe the fixed clip shape once, not a
        // shape that needs to repeat across a scrolling span.
        bleedMask.frame = box
        bleedMask.contents = Self.bleedMaskImage(size: box.size)
        bleedMask.contentsScale = contentsScale

        outlineMask.frame = box
        outlineMask.lineWidth = Self.outlineWidth
        // Inset by half the line width so the stroke sits fully inside bounds
        // instead of being clipped in half by masksToBounds.
        let strokeInset = Self.outlineWidth / 2
        let strokeRect = box.insetBy(dx: strokeInset, dy: strokeInset)
        outlineMask.path = CGPath(
            roundedRect: strokeRect,
            cornerWidth: max(0, radius - strokeInset),
            cornerHeight: max(0, radius - strokeInset),
            transform: nil
        )

        CATransaction.commit()
        restartScrollIfNeeded()
    }

    /// A capsule-shaped ring that is opaque at the edge and transparent
    /// `bleedDepth` points in. Used as an alpha mask — `CALayer.mask` reads the
    /// image's alpha channel only, so the falloff must be encoded as alpha, not
    /// as grey levels (a context with no alpha channel would make every pixel
    /// fully opaque regardless of colour, masking nothing). Drawn once per size
    /// change rather than per frame.
    private static func bleedMaskImage(size: CGSize) -> CGImage? {
        guard size.width > 0, size.height > 0 else { return nil }
        let width = Int(size.width.rounded(.up))
        let height = Int(size.height.rounded(.up))
        guard let ctx = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }

        ctx.clear(CGRect(x: 0, y: 0, width: width, height: height))

        // Concentric strokes stepping inward, each more transparent than the
        // last. Simple and exact at these sizes; a blur would cost more and
        // look the same.
        let steps = max(1, Int(bleedDepth.rounded()))
        for step in 0..<steps {
            let t = CGFloat(step) / CGFloat(steps)          // 0 at edge, →1 inward
            let alpha = bleedPeakAlpha * (1 - t)
            let inset = CGFloat(step) + 0.5
            let rect = CGRect(x: 0, y: 0, width: size.width, height: size.height)
                .insetBy(dx: inset, dy: inset)
            guard rect.width > 0, rect.height > 0 else { break }
            let radius = rect.height / 2
            ctx.setStrokeColor(gray: 0, alpha: alpha)
            ctx.setLineWidth(1)
            ctx.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil))
            ctx.strokePath()
        }
        return ctx.makeImage()
    }

    /// Slide both gradients left by one capsule width and loop. Skipped when the
    /// user has asked the system to reduce motion — the same intent as the CSS
    /// `prefers-reduced-motion` rule this replaces.
    private func restartScrollIfNeeded() {
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        for gradient in [bleedGradient, outlineGradient] {
            gradient.removeAnimation(forKey: Self.scrollKey)
            guard !reduceMotion, bounds.width > 0 else { continue }
            let slide = CABasicAnimation(keyPath: "position.x")
            slide.byValue = -bounds.width
            slide.duration = Self.scrollDuration
            slide.repeatCount = .infinity
            slide.isRemovedOnCompletion = false
            // Without this the animation stalls whenever the panel is ordered
            // out and back in, leaving a frozen rainbow.
            slide.fillMode = .forwards
            gradient.add(slide, forKey: Self.scrollKey)
        }
    }
}
