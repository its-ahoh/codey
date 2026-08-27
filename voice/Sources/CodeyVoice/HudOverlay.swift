import Cocoa

/// Floating status pill shown above all apps and spaces while voice input is
/// active. Visible when the helper is recording or transcribing so the user
/// always knows whether their speech is being captured, even when Codey itself
/// is minimized or hidden behind another app.
///
/// `.dictation` is the special "nowhere to paste" mode: we display the full
/// transcript in a wider card, copy it to the clipboard, and auto-dismiss
/// after a few seconds (a click dismisses it sooner; mouse events are enabled
/// only in that mode).
final class HudOverlay {
    enum Mode {
        case recording
        case transcribing
        /// The optional cleanup pass, after the words exist but before they
        /// land. Its own label rather than a longer `.transcribing`: the wait
        /// has a different cause and a different worst case, and "still
        /// transcribing" would read as the recognizer having stalled.
        case polishing
        /// Live partial transcript shown while a streaming-capable API is
        /// returning deltas. Replaces the spinner with the text so far so the
        /// user sees progress before injection happens at the end.
        case partial(String)
        case success
        /// A press that was refused because the on-device model is not loaded
        /// yet. Spinner rather than a cross: nothing failed, the answer is
        /// "not yet".
        case notice(String)
        case error(String)
        case dictation(String)
        /// The conversation capsule. Distinct from the dictation pill on
        /// purpose: a conversation is ongoing and two-way, so it gets the live
        /// rainbow rather than a static chrome.
        case conversation(ConversationPhase)

        var isPolishing: Bool {
            if case .polishing = self { return true }
            return false
        }
    }

    /// Mirrors the three states Electron reports for a converse turn. The
    /// labels match what the former `VoiceHud.tsx` showed, so the wording users
    /// already know does not change.
    enum ConversationPhase: String {
        case listening
        case thinking
        case speaking

        var label: String {
            switch self {
            case .listening: return "Listening"
            case .thinking:  return "Thinking"
            case .speaking:  return "Speaking"
            }
        }
    }

    private var panel: NSPanel?
    private var label: NSTextField?
    private var spinner: NSProgressIndicator?
    private var hideWorkItem: DispatchWorkItem?
    /// The currently desired visibility, set by `show()`/`hide()`. A hide's
    /// fade-out completion checks this before calling `orderOut`: if a `show()`
    /// ran during the ~0.18s fade it will have flipped this back to `true`, so the
    /// stale teardown is skipped instead of yanking the panel out from under us.
    private var wantVisible = false
    /// Lazily attached to the panel's content view the first time a
    /// conversation capsule is shown. Kept around afterwards — a converse turn
    /// is a repeated action and rebuilding the gradient each time is waste.
    private var capsuleLayer: RainbowCapsuleLayer?
    private var isCapsuleMode = false
    /// Size/radius the blur view's `maskImage` was last drawn for, so a resize
    /// that changes neither skips the redraw.
    private var maskedSize: CGSize = .zero
    private var maskedRadius: CGFloat = -1

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
    private let meterMaxHeight: CGFloat = 26
    private let meterMinHeight: CGFloat = 3

    /// Whether the panel is actually on screen and not fading out. Callers use
    /// this to re-assert a phase that something else hid out from under them.
    var isOnScreen: Bool {
        guard let panel = panel, panel.isVisible else { return false }
        return wantVisible
    }

    func show(_ mode: Mode) {
        ensurePanel()
        guard let panel = panel, let label = label, let spinner = spinner else { return }

        hideWorkItem?.cancel()
        hideWorkItem = nil
        // Mark the panel as wanted on-screen so an in-flight hide fade-out's
        // completion won't orderOut the panel we're about to (re)show.
        wantVisible = true

        switch mode {
        case .recording:
            setCapsuleMode(false)
            label.stringValue = "Listening"
            label.textColor = NSColor.labelColor
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            setMeterVisible(true)
            // Reset to flat baseline so first level update animates up.
            meterLevels = Array(repeating: 0, count: meterBarCount)
            renderMeter()
            applyPillLayout()
            panel.ignoresMouseEvents = true
        case .transcribing, .polishing:
            setCapsuleMode(false)
            label.stringValue = mode.isPolishing ? "Polishing" : "Transcribing"
            label.textColor = NSColor.labelColor
            setMeterVisible(false)
            spinner.isHidden = false
            spinner.startAnimation(nil)
            applyPillLayout()
            panel.ignoresMouseEvents = true
        case .partial(let text):
            setCapsuleMode(false)
            // Strip the spinner once the server starts producing words — the
            // text itself is the progress indicator. Truncate for the pill so
            // long sentences don't blow past `pillMaxWidth`.
            let display = text.count > 80
                ? "…" + text.suffix(80)
                : text
            label.stringValue = display.isEmpty ? "Transcribing" : display
            label.textColor = NSColor.labelColor
            setMeterVisible(false)
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            applyPillLayout()
            panel.ignoresMouseEvents = true
        case .success:
            setCapsuleMode(false)
            label.stringValue = "✓ Inserted"
            label.textColor = NSColor.systemGreen
            setMeterVisible(false)
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            applyPillLayout()
            panel.ignoresMouseEvents = true
            scheduleHide(after: 1.0)
        case .notice(let msg):
            setCapsuleMode(false)
            label.stringValue = msg
            label.textColor = NSColor.secondaryLabelColor
            setMeterVisible(false)
            spinner.isHidden = false
            spinner.startAnimation(nil)
            applyPillLayout()
            panel.ignoresMouseEvents = true
            scheduleHide(after: 2.5)
        case .error(let msg):
            setCapsuleMode(false)
            label.stringValue = "✕ \(msg)"
            label.textColor = NSColor.systemRed
            setMeterVisible(false)
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            applyPillLayout()
            panel.ignoresMouseEvents = true
            scheduleHide(after: 2.5)
        case .dictation(let text):
            setCapsuleMode(false)
            // Side effect: stash the transcript on the clipboard so the user
            // can paste it manually wherever they end up. The HUD copy is a
            // backup display, not the primary delivery mechanism.
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)

            spinner.stopAnimation(nil)
            spinner.isHidden = true
            label.textColor = NSColor.labelColor
            label.stringValue = "\(text)\n\n✓ Copied"
            setMeterVisible(false)
            applyDictationLayout()
            // Mouse events stay on so a click can dismiss it early, but the
            // card no longer waits for one: the text is already on the
            // clipboard, so making the user confirm buys nothing and leaves a
            // panel floating over whatever they do next.
            panel.ignoresMouseEvents = false
            scheduleHide(after: 5.0)
        case .conversation(let phase):
            label.stringValue = phase.label
            label.textColor = NSColor.white
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            // The meter stands in for the level while listening and speaking.
            // Thinking has no audio to show, so the rainbow carries it alone.
            setMeterVisible(phase != .thinking)
            if phase != .thinking {
                meterLevels = Array(repeating: 0, count: meterBarCount)
                renderMeter()
            }
            setCapsuleMode(true)
            applyPillLayout()
            panel.ignoresMouseEvents = true
        }

        // Robustly assert top-of-stack visibility. If a previous auto-hide left
        // the panel mid-fade (visible but alpha < 1), we must cancel that fade by
        // animating alpha back to 1 — gating only on `!isVisible` would skip that
        // and let the fade complete, hiding an active HUD.
        let wasVisible = panel.isVisible
        let needsFadeIn = !wasVisible || panel.alphaValue < 1.0
        if !wasVisible { panel.alphaValue = 0 }
        panel.orderFrontRegardless()
        if needsFadeIn {
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
        wantVisible = false
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.18
            panel.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            // Skip the teardown if a show() re-asserted visibility mid-fade.
            guard let self = self, !self.wantVisible else { return }
            self.panel?.orderOut(nil)
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
        applyMask(to: blur, size: rect.size, radius: pillHeight / 2)

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

    /// Swap the panel between the plain HUD chrome (blur + hairline border) and
    /// the conversation capsule (rainbow outline over a dark fill). The capsule
    /// layer sits behind the meter bars and label, which are subviews/sublayers
    /// of the same content view.
    private func setCapsuleMode(_ on: Bool) {
        guard isCapsuleMode != on,
              let blur = panel?.contentView as? NSVisualEffectView,
              let host = blur.layer else { isCapsuleMode = on; return }
        isCapsuleMode = on

        if on {
            let capsule = capsuleLayer ?? RainbowCapsuleLayer()
            capsule.contentsScale = panel?.backingScaleFactor ?? 2
            capsule.frame = blur.bounds
            if capsule.superlayer == nil {
                host.insertSublayer(capsule, at: 0)
            }
            capsule.isHidden = false
            capsuleLayer = capsule
            // The capsule paints its own fill and edge, so the HUD's blur and
            // hairline would only muddy it. We strip the hairline and any
            // background, but keep the view itself visible: the capsule's
            // opaque fill fully covers the blur material underneath, and hiding
            // the view would take the capsule, the meter bars and the label
            // down with it since they all live in the same layer tree.
            host.backgroundColor = NSColor.clear.cgColor
            host.borderWidth = 0
            // Meter bars are white in both modes, which reads on the dark fill.
        } else {
            capsuleLayer?.isHidden = true
            host.backgroundColor = nil
            host.borderWidth = 0.5
        }
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

    // MARK: - Shape

    /// Clip the blur view to the rounded shape with an explicit `maskImage`.
    ///
    /// `layer.cornerRadius` is not enough on its own: a `.behindWindow`
    /// visual-effect view's material is composited by the window server, not
    /// drawn into that layer, so the corner radius is not a reliable clip. When
    /// the blur degrades to a flat opaque fill — Accessibility's "Reduce
    /// transparency"/"Increase contrast", screen sharing, or any session where
    /// background blur is unavailable — the material paints the full rectangle
    /// and a box shows up around the pill. `maskImage` is honoured on every one
    /// of those paths, and it also makes the window shadow follow the rounded
    /// shape instead of the bounding box.
    ///
    /// Redrawn at the exact view size on each shape change (cheap, and it only
    /// happens when the panel resizes) rather than using a stretched cap-inset
    /// image, whose center slice would collapse at the pill's height.
    private func applyMask(to blur: NSVisualEffectView, size: CGSize, radius: CGFloat) {
        guard size.width > 0, size.height > 0 else { return }
        if maskedSize == size, maskedRadius == radius, blur.maskImage != nil { return }
        let r = max(0, min(radius, min(size.width, size.height) / 2))
        let image = NSImage(size: size, flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: r, yRadius: r).fill()
            return true
        }
        blur.maskImage = image
        maskedSize = size
        maskedRadius = radius
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
        applyMask(to: blur, size: CGSize(width: panelWidth, height: pillHeight), radius: pillHeight / 2)

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

        // The capsule rides along with the panel: applyPillLayout may have
        // resized the panel, so the capsule must follow or the rainbow ring
        // ends up offset from the pill.
        if let capsule = capsuleLayer, isCapsuleMode {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            capsule.frame = CGRect(x: 0, y: 0, width: panelWidth, height: pillHeight)
            CATransaction.commit()
        }
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
        applyMask(to: blur, size: CGSize(width: dictationMaxWidth, height: totalHeight), radius: 14)

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
