import Cocoa

/// Floating status pill shown above all apps and spaces while voice input is
/// active. Visible when the helper is recording or transcribing so the user
/// always knows whether their speech is being captured, even when Codey itself
/// is minimized or hidden behind another app.
///
/// `.dictation` is the special "nowhere to paste" mode: we display the full
/// transcript in a wider card, copy it to the clipboard, and wait for the
/// user to click-to-dismiss (mouse events are enabled only in that mode).
final class HudOverlay {
    enum Mode {
        case recording
        case transcribing
        /// Live partial transcript shown while a streaming-capable API is
        /// returning deltas. Replaces the spinner with the text so far so the
        /// user sees progress before injection happens at the end.
        case partial(String)
        case success
        case error(String)
        case dictation(String)
    }

    private var panel: NSPanel?
    private var label: NSTextField?
    private var spinner: NSProgressIndicator?
    private var hideWorkItem: DispatchWorkItem?

    private let pillHeight: CGFloat = 44
    private let pillSidePadding: CGFloat = 16
    /// Hard floor for sanity (avoid 0-width panels); pill auto-fits content
    /// otherwise — no artificial inflation when text is short.
    private let pillMinWidth: CGFloat = 80
    private let pillMaxWidth: CGFloat = 600
    private let dictationMaxWidth: CGFloat = 460
    private let dictationPadding: CGFloat = 16

    // ── Recording-mode waveform meter ────────────────────────────────
    /// 5-bar scrolling level meter. Each new RMS level shifts older bars left.
    private var meterBars: [CALayer] = []
    private var meterLevels: [CGFloat] = Array(repeating: 0, count: 5)
    private let meterBarCount = 5
    private let meterBarWidth: CGFloat = 3
    private let meterBarGap: CGFloat = 3
    private let meterMaxHeight: CGFloat = 32
    private let meterMinHeight: CGFloat = 3

    func show(_ mode: Mode) {
        ensurePanel()
        guard let panel = panel, let label = label, let spinner = spinner else { return }

        hideWorkItem?.cancel()
        hideWorkItem = nil

        switch mode {
        case .recording:
            label.stringValue = "Listening…"
            label.textColor = NSColor.labelColor
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            setMeterVisible(true)
            // Reset to flat baseline so first level update animates up.
            meterLevels = Array(repeating: 0, count: meterBarCount)
            renderMeter()
            applyPillLayout()
            panel.ignoresMouseEvents = true
        case .transcribing:
            label.stringValue = "Transcribing…"
            label.textColor = NSColor.labelColor
            setMeterVisible(false)
            spinner.isHidden = false
            spinner.startAnimation(nil)
            applyPillLayout()
            panel.ignoresMouseEvents = true
        case .partial(let text):
            // Strip the spinner once the server starts producing words — the
            // text itself is the progress indicator. Truncate for the pill so
            // long sentences don't blow past `pillMaxWidth`.
            let display = text.count > 80
                ? "…" + text.suffix(80)
                : text
            label.stringValue = display.isEmpty ? "Transcribing…" : display
            label.textColor = NSColor.labelColor
            setMeterVisible(false)
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            applyPillLayout()
            panel.ignoresMouseEvents = true
        case .success:
            label.stringValue = "✓ Inserted"
            label.textColor = NSColor.systemGreen
            setMeterVisible(false)
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            applyPillLayout()
            panel.ignoresMouseEvents = true
            scheduleHide(after: 1.0)
        case .error(let msg):
            label.stringValue = "✕ \(msg)"
            label.textColor = NSColor.systemRed
            setMeterVisible(false)
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            applyPillLayout()
            panel.ignoresMouseEvents = true
            scheduleHide(after: 2.5)
        case .dictation(let text):
            // Side effect: stash the transcript on the clipboard so the user
            // can paste it manually wherever they end up. The HUD copy is a
            // backup display, not the primary delivery mechanism.
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)

            spinner.stopAnimation(nil)
            spinner.isHidden = true
            label.textColor = NSColor.labelColor
            label.stringValue = "\(text)\n\n✓ Copied — click to dismiss"
            setMeterVisible(false)
            applyDictationLayout()
            panel.ignoresMouseEvents = false
            // No scheduled hide — user dismisses by clicking.
        }

        if !panel.isVisible {
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

        let rect = NSRect(x: 0, y: 0, width: pillMinWidth, height: pillHeight)
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

        let blur = NSVisualEffectView(frame: rect)
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = pillHeight / 2
        blur.layer?.masksToBounds = true
        blur.layer?.borderWidth = 0.5
        blur.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.4).cgColor
        p.contentView = blur

        // Click-to-dismiss for the dictation card. Active even in pill modes,
        // but those have ignoresMouseEvents = true so clicks pass through.
        let click = NSClickGestureRecognizer(target: self, action: #selector(handleClick))
        blur.addGestureRecognizer(click)

        // Waveform meter: a row of small rounded bars. Heights are driven by
        // updateLevel(); the array is treated as a sliding window (newest
        // sample on the right) so it looks like the wave scrolls past.
        for _ in 0..<meterBarCount {
            let bar = CALayer()
            bar.backgroundColor = NSColor.white.cgColor
            bar.cornerRadius = meterBarWidth / 2
            bar.isHidden = true
            blur.layer?.addSublayer(bar)
            meterBars.append(bar)
        }

        let spin = NSProgressIndicator(frame: NSRect(x: 14, y: (pillHeight - 16) / 2, width: 16, height: 16))
        spin.style = .spinning
        spin.controlSize = .small
        spin.isHidden = true
        blur.addSubview(spin)
        self.spinner = spin

        let lbl = NSTextField(labelWithString: "")
        lbl.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        lbl.textColor = NSColor.labelColor
        lbl.alignment = .left
        lbl.cell?.lineBreakMode = .byTruncatingTail
        lbl.cell?.usesSingleLineMode = true
        blur.addSubview(lbl)
        self.label = lbl

        self.panel = p
    }

    /// Drive the recording-mode waveform from an RMS level (0..1). Cheap
    /// no-op when the meter isn't visible. Must be called on main.
    func updateLevel(_ level: Float) {
        guard !meterBars.isEmpty, !meterBars[0].isHidden else { return }
        // Slide window left, append newest sample on the right.
        meterLevels.removeFirst()
        meterLevels.append(CGFloat(max(0, min(1, level))))
        renderMeter()
    }

    private func setMeterVisible(_ visible: Bool) {
        for bar in meterBars { bar.isHidden = !visible }
    }

    /// Lay out the meter bars inside the pill. Called after applyPillLayout
    /// has set the panel width, and from updateLevel to refresh heights.
    private func renderMeter() {
        guard let panel = panel, !meterBars.isEmpty, !meterBars[0].isHidden else { return }
        let totalWidth = meterTotalWidth()
        // Mirror the layout math from applyPillLayout: the icon sits at the
        // left edge of the centered content group. Re-derive that origin.
        guard let label = label else { return }
        label.sizeToFit()
        let labelWidth = ceil(label.frame.width)
        let gap: CGFloat = 8
        let contentWidth = totalWidth + gap + labelWidth
        let originX = floor((panel.frame.width - contentWidth) / 2)

        CATransaction.begin()
        CATransaction.setAnimationDuration(0.08)
        for (i, bar) in meterBars.enumerated() {
            // sqrt curve makes low-volume speech move the bars visibly while
            // still letting loud bursts reach near the top — overall response
            // feels punchier than linear without saturating instantly.
            let lv = sqrt(meterLevels[i])
            let h = max(meterMinHeight, lv * meterMaxHeight)
            let x = originX + CGFloat(i) * (meterBarWidth + meterBarGap)
            let y = (pillHeight - h) / 2
            bar.frame = CGRect(x: x, y: y, width: meterBarWidth, height: h)
        }
        CATransaction.commit()
    }

    private func meterTotalWidth() -> CGFloat {
        let n = CGFloat(meterBarCount)
        return n * meterBarWidth + (n - 1) * meterBarGap
    }

    @objc private func handleClick() {
        // Only dictation mode opts into mouse events, so any click here is a
        // dismiss request. Cancel the pasteboard restore that paste-injection
        // schedules — irrelevant here since no paste happened.
        hide()
    }

    // MARK: - Layouts

    /// Single-line pill: icon (dot or spinner) + status text. Panel width
    /// auto-fits the natural text width plus side padding, clamped to
    /// [pillMinWidth, pillMaxWidth] — so short labels don't leave huge empty
    /// gutters and long labels (errors, long state) don't get prematurely
    /// truncated by a fixed-width frame.
    private func applyPillLayout() {
        guard let panel = panel, let label = label, let spinner = spinner,
              let blur = panel.contentView as? NSVisualEffectView else { return }

        label.cell?.usesSingleLineMode = true
        label.cell?.lineBreakMode = .byTruncatingTail
        label.maximumNumberOfLines = 1
        label.preferredMaxLayoutWidth = 0

        // Pick the active icon for this mode: meter (recording) > spinner
        // (transcribing) > nothing (success/error).
        let meterVisible = !meterBars.isEmpty && !meterBars[0].isHidden
        let iconWidth: CGFloat
        if meterVisible { iconWidth = meterTotalWidth() }
        else if !spinner.isHidden { iconWidth = 16 }
        else { iconWidth = 0 }
        let showIcon = iconWidth > 0
        let gap: CGFloat = showIcon ? 8 : 0

        label.sizeToFit()
        let naturalLabelWidth = ceil(label.frame.width)
        let labelHeight = ceil(label.frame.height)

        let contentWidth = iconWidth + gap + naturalLabelWidth
        let desired = contentWidth + pillSidePadding * 2
        let panelWidth = min(pillMaxWidth, max(pillMinWidth, desired))
        // Cap hit → truncate label to exact available room so byTruncatingTail
        // gives an ellipsis instead of clipping.
        let availableLabelWidth = panelWidth - pillSidePadding * 2 - iconWidth - gap
        let finalLabelWidth = min(naturalLabelWidth, availableLabelWidth)

        resizePanel(width: panelWidth, height: pillHeight)
        blur.layer?.cornerRadius = pillHeight / 2

        let usedContentWidth = iconWidth + gap + finalLabelWidth
        var x = floor((panelWidth - usedContentWidth) / 2)
        if meterVisible {
            // Bar frames are set by renderMeter(); just advance the cursor.
            x += iconWidth + gap
        } else if !spinner.isHidden {
            spinner.frame = NSRect(x: x, y: (pillHeight - 16) / 2, width: 16, height: 16)
            x += iconWidth + gap
        }
        label.frame = NSRect(x: x, y: (pillHeight - labelHeight) / 2, width: finalLabelWidth, height: labelHeight)
        if meterVisible { renderMeter() }
    }

    /// Multi-line card: wraps text up to dictationMaxWidth, height grows to fit.
    private func applyDictationLayout() {
        guard let panel = panel, let label = label,
              let blur = panel.contentView as? NSVisualEffectView else { return }

        label.cell?.usesSingleLineMode = false
        label.cell?.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = 0

        let textWidth = dictationMaxWidth - dictationPadding * 2
        label.preferredMaxLayoutWidth = textWidth
        let labelSize = label.sizeThatFits(NSSize(width: textWidth, height: .greatestFiniteMagnitude))
        let labelHeight = ceil(labelSize.height)
        let totalHeight = labelHeight + dictationPadding * 2

        resizePanel(width: dictationMaxWidth, height: totalHeight)
        blur.layer?.cornerRadius = 14

        label.frame = NSRect(x: dictationPadding, y: dictationPadding, width: textWidth, height: labelHeight)
    }

    private func resizePanel(width: CGFloat, height: CGFloat) {
        guard let panel = panel, let screen = NSScreen.main,
              let blur = panel.contentView as? NSVisualEffectView else { return }
        let screenFrame = screen.visibleFrame
        let x = screenFrame.midX - width / 2
        let y = screenFrame.minY + 80
        panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true)
        blur.frame = NSRect(x: 0, y: 0, width: width, height: height)
    }

}
