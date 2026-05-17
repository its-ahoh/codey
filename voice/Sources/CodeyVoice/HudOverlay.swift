import Cocoa

/// Floating status pill shown above all apps and spaces while voice input is
/// active. Visible when the helper is recording or transcribing so the user
/// always knows whether their speech is being captured, even when Codey itself
/// is minimized or hidden behind another app.
final class HudOverlay {
    enum Mode {
        case recording
        case transcribing
        case success
        case error(String)
    }

    private var panel: NSPanel?
    private var dotLayer: CAShapeLayer?
    private var label: NSTextField?
    private var spinner: NSProgressIndicator?
    private var hideWorkItem: DispatchWorkItem?

    func show(_ mode: Mode) {
        ensurePanel()
        guard let panel = panel, let label = label, let dotLayer = dotLayer, let spinner = spinner else { return }

        hideWorkItem?.cancel()
        hideWorkItem = nil

        switch mode {
        case .recording:
            label.stringValue = "Listening…"
            label.textColor = NSColor.labelColor
            dotLayer.isHidden = false
            dotLayer.fillColor = NSColor.systemRed.cgColor
            startDotPulse()
            spinner.stopAnimation(nil)
            spinner.isHidden = true
        case .transcribing:
            label.stringValue = "Transcribing…"
            label.textColor = NSColor.labelColor
            dotLayer.isHidden = true
            stopDotPulse()
            spinner.isHidden = false
            spinner.startAnimation(nil)
        case .success:
            label.stringValue = "✓ Inserted"
            label.textColor = NSColor.systemGreen
            dotLayer.isHidden = true
            stopDotPulse()
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            scheduleHide(after: 1.0)
        case .error(let msg):
            label.stringValue = "✕ \(msg)"
            label.textColor = NSColor.systemRed
            dotLayer.isHidden = true
            stopDotPulse()
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            scheduleHide(after: 2.5)
        }

        if !panel.isVisible {
            positionPanel(panel)
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.12
                panel.animator().alphaValue = 1.0
            }
        }
    }

    func hide() {
        hideWorkItem?.cancel()
        hideWorkItem = nil
        guard let panel = panel, panel.isVisible else { return }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.18
            panel.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            self?.panel?.orderOut(nil)
            self?.stopDotPulse()
        }
    }

    private func scheduleHide(after seconds: TimeInterval) {
        let work = DispatchWorkItem { [weak self] in self?.hide() }
        hideWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    // MARK: - Panel construction

    private func ensurePanel() {
        if panel != nil { return }

        let width: CGFloat = 220
        let height: CGFloat = 44
        let rect = NSRect(x: 0, y: 0, width: width, height: height)
        let p = NSPanel(
            contentRect: rect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        p.isFloatingPanel = true
        p.hidesOnDeactivate = false
        p.level = .statusBar
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        p.backgroundColor = .clear
        p.isOpaque = false
        p.hasShadow = true
        p.ignoresMouseEvents = true
        p.isReleasedWhenClosed = false

        // Background blur with rounded corners
        let blur = NSVisualEffectView(frame: rect)
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = height / 2
        blur.layer?.masksToBounds = true
        blur.layer?.borderWidth = 0.5
        blur.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.4).cgColor
        p.contentView = blur

        // Red recording dot
        let dotSize: CGFloat = 10
        let dot = CAShapeLayer()
        dot.path = CGPath(
            ellipseIn: CGRect(x: 0, y: 0, width: dotSize, height: dotSize),
            transform: nil
        )
        dot.fillColor = NSColor.systemRed.cgColor
        dot.frame = CGRect(x: 16, y: (height - dotSize) / 2, width: dotSize, height: dotSize)
        blur.layer?.addSublayer(dot)
        self.dotLayer = dot

        // Spinner (shown during transcribing)
        let spin = NSProgressIndicator(frame: NSRect(x: 14, y: (height - 16) / 2, width: 16, height: 16))
        spin.style = .spinning
        spin.controlSize = .small
        spin.isHidden = true
        blur.addSubview(spin)
        self.spinner = spin

        // Label
        let labelRect = NSRect(x: 38, y: 0, width: width - 50, height: height)
        let lbl = NSTextField(labelWithString: "")
        lbl.frame = labelRect
        lbl.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        lbl.textColor = NSColor.labelColor
        lbl.alignment = .left
        lbl.cell?.lineBreakMode = .byTruncatingTail
        lbl.cell?.usesSingleLineMode = true
        blur.addSubview(lbl)
        self.label = lbl

        self.panel = p
    }

    private func positionPanel(_ panel: NSPanel) {
        guard let screen = NSScreen.main else { return }
        let frame = panel.frame
        let screenFrame = screen.visibleFrame
        let x = screenFrame.midX - frame.width / 2
        let y = screenFrame.minY + 80
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    // MARK: - Dot pulse animation

    private func startDotPulse() {
        guard let dot = dotLayer else { return }
        dot.removeAnimation(forKey: "pulse")
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 1.0
        pulse.toValue = 0.35
        pulse.duration = 0.7
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        dot.add(pulse, forKey: "pulse")
    }

    private func stopDotPulse() {
        dotLayer?.removeAnimation(forKey: "pulse")
        dotLayer?.opacity = 1.0
    }
}
