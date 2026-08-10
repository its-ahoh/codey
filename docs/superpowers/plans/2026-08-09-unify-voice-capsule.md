# Unify the Voice Capsules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the Electron conversation-capsule window and draw the conversation capsule from the CodeyVoice helper's existing AppKit panel, keeping the scrolling rainbow outline and adding an inward rainbow bleed.

**Architecture:** The helper's `HudOverlay` gains a `conversation` mode backed by a new `RainbowCapsuleLayer`. Electron stops owning a `BrowserWindow` for the capsule and instead forwards two new stdin commands (`hud-state`, `hud-level`) to the helper. Every upstream call site in `main.ts` keeps its current shape, so the "should there be a capsule" decision stays exactly where it is today.

**Tech Stack:** Swift 5 / AppKit / Core Animation (helper), TypeScript / Electron 41 (app), Vitest (tests).

**Spec:** `docs/superpowers/specs/2026-08-09-unify-voice-capsule-design.md`

---

## Before you start

**Node version.** The default `node` on this machine is v16 and cannot run
vitest or tsc. Every npm command in this plan must run under Node 22:

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
node --version   # must print v22.17.1
```

**Swift builds** are run from `voice/` with `make helper`. The first build after
a clean checkout resolves WhisperKit from the network and takes several minutes;
later builds are fast.

**Branch:** work on `unify-voice-capsule` (already created, holds the spec).

**Order matters.** Swift comes first (Tasks 1-4). If you delete the Electron
window before the helper can draw the capsule, the intermediate commits have no
capsule at all.

---

## File Structure

**Create**

- `voice/Sources/CodeyVoice/RainbowCapsuleLayer.swift` — owns the rainbow
  gradient, its scrolling animation, the outline mask and the inward-bleed mask.
  Knows nothing about voice state; it draws a capsule of a given size.
- `codey-mac/electron/voice-hud.ts` — pure stdin command encoding, no Electron
  imports, mirroring how `electron/capture.ts` is structured.
- `codey-mac/electron/voice-hud.test.ts` — tests for the above.

**Modify**

- `voice/Sources/CodeyVoice/HudOverlay.swift` — new `Mode.conversation` case,
  capsule layout, capsule level meter.
- `voice/Sources/CodeyVoice/VoiceCoordinator.swift:335` — two new stdin commands
  in `handleExternalCommand`.
- `codey-mac/electron/main.ts` — delete the capsule window; `showVoiceHud` /
  `hideVoiceHud` become stdin senders.
- `codey-mac/src/main.tsx` — drop the `#/voice-hud` route.

**Delete**

- `codey-mac/src/components/VoiceHud.tsx`

---

## Task 1: RainbowCapsuleLayer

The visual core. Build it standalone before wiring any state into it.

**Files:**
- Create: `voice/Sources/CodeyVoice/RainbowCapsuleLayer.swift`

- [ ] **Step 1: Write the layer**

Create `voice/Sources/CodeyVoice/RainbowCapsuleLayer.swift`:

```swift
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
        bleedGradient.mask = bleedMask
        addSublayer(bleedGradient)

        outlineMask.fillColor = NSColor.clear.cgColor
        outlineMask.strokeColor = NSColor.black.cgColor
        outlineGradient.mask = outlineMask
        addSublayer(outlineGradient)
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

        // Twice as wide as the capsule so a half-width slide loops seamlessly:
        // the stop list starts and ends on the same colour.
        let wide = CGRect(x: 0, y: 0, width: box.width * 2, height: box.height)
        bleedGradient.frame = wide
        outlineGradient.frame = wide

        bleedMask.frame = wide
        bleedMask.contents = Self.bleedMaskImage(size: box.size)
        bleedMask.contentsGravity = .left
        bleedMask.contentsScale = contentsScale

        outlineMask.frame = wide
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
    /// `bleedDepth` points in. Used as an alpha mask, so only luminance and
    /// alpha matter. Drawn once per size change rather than per frame.
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
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }

        ctx.setFillColor(gray: 0, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

        // Concentric strokes stepping inward, each dimmer than the last. Simple
        // and exact at these sizes; a blur would cost more and look the same.
        let steps = max(1, Int(bleedDepth.rounded()))
        for step in 0..<steps {
            let t = CGFloat(step) / CGFloat(steps)          // 0 at edge, →1 inward
            let alpha = bleedPeakAlpha * (1 - t)
            let inset = CGFloat(step) + 0.5
            let rect = CGRect(x: 0, y: 0, width: size.width, height: size.height)
                .insetBy(dx: inset, dy: inset)
            guard rect.width > 0, rect.height > 0 else { break }
            let radius = rect.height / 2
            ctx.setStrokeColor(gray: alpha, alpha: 1)
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
```

- [ ] **Step 2: Build the helper**

```bash
cd voice && make helper
```

Expected: `[voice] Built helper: ./CodeyVoice`, no errors. A build failure here
is a compile error in the file above — fix it before moving on. Nothing is wired
up yet, so there is nothing to run.

- [ ] **Step 3: Commit**

```bash
git add voice/Sources/CodeyVoice/RainbowCapsuleLayer.swift
git commit -m "Add the rainbow capsule layer for the voice HUD"
```

---

## Task 2: HudOverlay conversation mode

**Files:**
- Modify: `voice/Sources/CodeyVoice/HudOverlay.swift`

- [ ] **Step 1: Add the mode and its phases**

In `HudOverlay.swift`, extend the `Mode` enum (currently at line 12). Add the
new case after `case dictation(String)`:

```swift
        case dictation(String)
        /// The conversation capsule. Distinct from the dictation pill on
        /// purpose: a conversation is ongoing and two-way, so it gets the live
        /// rainbow rather than a static chrome.
        case conversation(ConversationPhase)
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
```

- [ ] **Step 2: Add the capsule layer as a stored property**

Next to the other stored properties (after `private var wantVisible = false`,
line 32):

```swift
    /// Lazily attached to the panel's content view the first time a
    /// conversation capsule is shown. Kept around afterwards — a converse turn
    /// is a repeated action and rebuilding the gradient each time is waste.
    private var capsuleLayer: RainbowCapsuleLayer?
    private var isCapsuleMode = false
```

- [ ] **Step 3: Handle the new case in `show(_:)`**

In `show(_:)`, add a branch to the `switch mode` (after the `case .dictation`
block that ends with the `// No scheduled hide` comment, around line 129):

```swift
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
```

- [ ] **Step 4: Turn capsule mode off for every other mode**

Every other case must restore the plain pill chrome, otherwise a dictation pill
right after a converse turn inherits the rainbow. Add `setCapsuleMode(false)` as
the first line of the `.recording`, `.transcribing`, `.partial`, `.success`,
`.error` and `.dictation` cases in `show(_:)`. For example `.recording` becomes:

```swift
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
```

- [ ] **Step 5: Write `setCapsuleMode`**

Add below `setMeterVisible` (line 248):

```swift
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
            // hairline would only muddy it.
            blur.isHidden = true
            host.backgroundColor = NSColor.clear.cgColor
            host.borderWidth = 0
            // Meter bars are white in both modes, which reads on the dark fill.
        } else {
            capsuleLayer?.isHidden = true
            blur.isHidden = false
            host.backgroundColor = nil
            host.borderWidth = 0.5
        }
    }
```

- [ ] **Step 6: Keep the capsule sized with the panel**

`applyPillLayout` resizes the panel, so the capsule must follow. At the end of
`applyPillLayout` (after the `if meterVisible { renderMeter() }` line, line 344),
add:

```swift
        if let capsule = capsuleLayer, isCapsuleMode {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            capsule.frame = CGRect(x: 0, y: 0, width: panelWidth, height: pillHeight)
            CATransaction.commit()
        }
```

- [ ] **Step 7: Build**

```bash
cd voice && make helper
```

Expected: builds clean. Still not reachable at runtime — the stdin command that
triggers it lands in Task 3.

- [ ] **Step 8: Commit**

```bash
git add voice/Sources/CodeyVoice/HudOverlay.swift
git commit -m "Teach HudOverlay to draw the conversation capsule"
```

---

## Task 3: stdin commands in VoiceCoordinator

**Files:**
- Modify: `voice/Sources/CodeyVoice/VoiceCoordinator.swift:335`

- [ ] **Step 1: Parse the two new commands**

`handleExternalCommand` currently switches on the whole trimmed line. The new
commands carry an argument, so split first. Replace the method (line 335) with:

```swift
    func handleExternalCommand(_ command: String) {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: " ", maxSplits: 1).map(String.init)
        guard let verb = parts.first else { return }
        let argument = parts.count > 1 ? parts[1] : ""

        switch verb {
        // Composer buttons remain available even when their global-hotkey
        // switches are off; those switches only control registration.
        case "conversation-toggle": handleCaptureToggle(destination: .conversation)
        case "composer-dictation-toggle": handleCaptureToggle(destination: .composerDictation)
        case "conversation-cancel", "composer-dictation-cancel":
            if state == .recording && captureDestination.composerMode != nil {
                cancelRecording()
            } else if state == .transcribing && captureDestination.composerMode != nil {
                conversationCaptureGeneration += 1
                state = .idle
                statusItem?.updateState(.idle)
                emitConversationEvent(type: "state", payload: ["state": "idle"])
            } else if state == .speaking {
                endSpeaking()
            }
        // Electron drives the conversation capsule: it is the only side that
        // knows whether a turn came from the hotkey (capsule) or the composer
        // button (no capsule), and the only side that sees the speaking phase.
        case "hud-state": applyConversationHud(argument)
        case "hud-level":
            guard !dictationCaptureInFlight, let level = Float(argument) else { break }
            hud.updateLevel(level)
        default: break
        }
    }

    /// A dictation capture owns the panel outright. Conversation commands are
    /// dropped while one is running rather than fighting over it — the two
    /// cannot legitimately overlap, since there is one microphone.
    private var dictationCaptureInFlight: Bool {
        captureDestination == .dictation && state != .idle
    }

    private func applyConversationHud(_ raw: String) {
        guard !dictationCaptureInFlight else { return }
        switch raw {
        case "listening": hud.show(.conversation(.listening))
        case "thinking":  hud.show(.conversation(.thinking))
        case "speaking":  hud.show(.conversation(.speaking))
        default:          hud.hide()   // "idle", "hidden", anything unrecognized
        }
    }
```

- [ ] **Step 2: Make `CaptureDestination` comparable**

`dictationCaptureInFlight` compares `captureDestination` with `==`. The enum
(line 15) has associated-value-free cases, so add `Equatable` to its declaration:

```swift
    private enum CaptureDestination: Equatable {
```

- [ ] **Step 3: Build**

```bash
cd voice && make helper
```

Expected: builds clean.

- [ ] **Step 4: Verify by hand, before Electron changes**

The helper reads commands on stdin, so it can be driven directly:

```bash
cd voice && (echo "hud-state listening"; sleep 3; echo "hud-level 0.6"; sleep 3; echo "hud-state thinking"; sleep 3; echo "hud-state speaking"; sleep 3; echo "hud-state idle"; sleep 1) | ./CodeyVoice
```

Expected: a capsule appears bottom-centre with a scrolling rainbow outline and
the rainbow bleeding inward, reading "Listening", then "Thinking" (no meter),
then "Speaking", then disappearing. If the colours look wrong, adjust
`RainbowCapsuleLayer.outlineWidth` / `bleedDepth` / `bleedPeakAlpha` and rebuild.

Note: the helper will also complain about the gateway being unreachable. That is
expected when running it standalone and does not affect the HUD.

- [ ] **Step 5: Commit**

```bash
git add voice/Sources/CodeyVoice/VoiceCoordinator.swift
git commit -m "Drive the conversation capsule from stdin commands"
```

---

## Task 4: Pure command encoding in Electron (TDD)

**Files:**
- Create: `codey-mac/electron/voice-hud.ts`
- Test: `codey-mac/electron/voice-hud.test.ts`

- [ ] **Step 1: Write the failing test**

Create `codey-mac/electron/voice-hud.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hudStateCommand, hudLevelCommand } from './voice-hud'

describe('hudStateCommand', () => {
  it('maps the three live phases onto helper commands', () => {
    expect(hudStateCommand('recording')).toBe('hud-state listening')
    expect(hudStateCommand('transcribing')).toBe('hud-state thinking')
    expect(hudStateCommand('speaking')).toBe('hud-state speaking')
  })

  it('treats every non-live value as a request to hide', () => {
    expect(hudStateCommand('idle')).toBe('hud-state idle')
    expect(hudStateCommand('hidden')).toBe('hud-state idle')
    expect(hudStateCommand('')).toBe('hud-state idle')
    expect(hudStateCommand('nonsense')).toBe('hud-state idle')
  })
})

describe('hudLevelCommand', () => {
  it('emits a fixed-precision level', () => {
    expect(hudLevelCommand(0.5)).toBe('hud-level 0.500')
    expect(hudLevelCommand(0)).toBe('hud-level 0.000')
  })

  it('clamps out-of-range readings instead of forwarding them', () => {
    expect(hudLevelCommand(1.8)).toBe('hud-level 1.000')
    expect(hudLevelCommand(-0.3)).toBe('hud-level 0.000')
  })

  it('refuses a level that is not a finite number', () => {
    // Swift parses this line with Float(); a "NaN" argument would parse to a
    // NaN and poison the meter's sliding window.
    expect(hudLevelCommand(NaN)).toBeNull()
    expect(hudLevelCommand(Infinity)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
npm test -w codey-mac -- voice-hud
```

Expected: FAIL — `Failed to resolve import "./voice-hud"`.

- [ ] **Step 3: Write the module**

Create `codey-mac/electron/voice-hud.ts`:

```typescript
// Pure encoding for the conversation-capsule commands sent to the CodeyVoice
// helper over stdin. No Electron imports so it is unit-testable; main.ts owns
// the child-process glue. Same split as capture.ts.
//
// The capsule itself lives in the helper (HudOverlay.swift). Electron stays the
// side that decides *whether* there should be one, because only it knows a turn
// came from the hotkey rather than the composer button.

/** Renderer/helper state names → the helper's three capsule phases. */
const PHASE: Record<string, string> = {
  recording: 'listening',
  transcribing: 'thinking',
  speaking: 'speaking',
}

export function hudStateCommand(state: string): string {
  return `hud-state ${PHASE[state] ?? 'idle'}`
}

/**
 * Levels arrive ~20x/s from either the helper's own audio tap or the
 * renderer's meter. Returns null for anything the Swift side's `Float(_:)`
 * would turn into a NaN — a poisoned sample sticks in the meter's sliding
 * window for five frames.
 */
export function hudLevelCommand(level: number): string | null {
  if (!Number.isFinite(level)) return null
  const clamped = Math.min(1, Math.max(0, level))
  return `hud-level ${clamped.toFixed(3)}`
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm test -w codey-mac -- voice-hud
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/voice-hud.ts codey-mac/electron/voice-hud.test.ts
git commit -m "Add pure encoding for the voice capsule stdin commands"
```

---

## Task 5: Retire the Electron capsule window

The deletion. Every call site of `showVoiceHud` / `hideVoiceHud` keeps its
current shape; only the two functions change what they do.

**Files:**
- Modify: `codey-mac/electron/main.ts:297-406`, `main.ts:2660-2671`
- Modify: `codey-mac/src/main.tsx`
- Delete: `codey-mac/src/components/VoiceHud.tsx`

- [ ] **Step 1: Replace the window block**

In `main.ts`, delete everything from the `// ── Voice conversation capsule ──`
comment (line 297) through the end of `hideVoiceHud` (line 406) **except** the
three `nativeConverse*` / `nativeDictationActive` state variables, which other
code reads. Replace that whole block with:

```typescript
// ── Voice conversation capsule ──────────────────────────────────────
// The capsule is drawn by the CodeyVoice helper (HudOverlay.swift), the same
// AppKit panel that shows dictation status. It used to be a second, Electron
// BrowserWindow; that window had to call setVisibleOnAllWorkspaces to float
// over other Spaces, which transforms the process type between UIElement and
// Foreground and knocked the user's focus out of whatever app they were in on
// the first converse hotkey press of each launch.
//
// Electron still decides *whether* a capsule appears — it is the only side that
// knows a turn came from the hotkey rather than the composer button, and the
// only side that sees the speaking phase.
let nativeConverseActive = false
let nativeDictationActive = false
// Direct Fn events originate in the Helper and are hotkey turns. Composer
// clicks override this before sending their stdin command.
let nativeConverseFromHotkey = true

function showVoiceHud(state: string) {
  sendVoiceHudCommand(hudStateCommand(state))
}

function hideVoiceHud() {
  sendVoiceHudCommand(hudStateCommand('idle'))
}

function sendVoiceHudCommand(command: string | null) {
  if (!command) return
  if (!sendVoiceHelperCommand(command)) {
    // No helper means no capsule, but it also means capture is already broken;
    // one log line beats a dialog the user cannot act on.
    sendToRenderer('gateway-log', `[voice] helper unavailable, capsule skipped: ${command}`)
  }
}
```

- [ ] **Step 2: Import the encoders**

`main.ts` already imports from `./capture`. Add the new import next to it:

```typescript
import { hudStateCommand, hudLevelCommand } from './voice-hud'
```

- [ ] **Step 3: Forward the level instead of messaging a window**

Two call sites send levels to the deleted window.

In `handleVoiceHelperLine` (line 1306), replace:

```typescript
        if (voiceHudWindow?.isVisible()) voiceHudWindow.webContents.send('voice:hudLevel', event.level)
```

with:

```typescript
        // Round trip: the helper reported this level, and we hand it straight
        // back for the capsule. Worth it to keep one control point for the
        // meter across both the native and browser capture paths.
        if (nativeConverseFromHotkey) sendVoiceHudCommand(hudLevelCommand(event.level))
```

In the `voice:hudLevel` IPC handler (line 2660), replace the body:

```typescript
  ipcMain.on('voice:hudLevel', (_e, level: number) => {
    sendVoiceHudCommand(hudLevelCommand(level))
  })
```

The neighbouring `voice:hudState` handler (line 2666) needs **no** change: it
already routes through `showVoiceHud` / `hideVoiceHud`, which now send stdin.
That is the point of keeping those two function names.

- [ ] **Step 4: Drop the global Escape grab**

Delete `registerVoiceHudEscape` and `unregisterVoiceHudEscape` along with the
`voiceHudOwnsEscapeShortcut` variable (they were inside the block replaced in
Step 1, so this is only about their remaining callers). Search for both names
and remove every call:

```bash
grep -n "VoiceHudEscape\|voiceHudOwnsEscapeShortcut\|voiceHudWindow" codey-mac/electron/main.ts
```

Expected after the edits: no matches. The helper's own `installEscMonitor`
(`VoiceCoordinator.swift:371`) already handles Esc during a turn, and only while
one is active — unlike the global accelerator, which took Escape away from every
other app for the duration.

- [ ] **Step 5: Delete the renderer capsule**

```bash
git rm codey-mac/src/components/VoiceHud.tsx
```

Then in `codey-mac/src/main.tsx`, remove the `VoiceHud` import, the `isVoiceHud`
constant, and its branch, leaving:

```typescript
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { CaptureWindow } from './components/CaptureWindow'

// Auxiliary BrowserWindows load the same bundle behind a hash route.
const hash = window.location.hash
const isCapture = hash.startsWith('#/capture')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isCapture ? <CaptureWindow /> : <App />}
  </React.StrictMode>
)
```

- [ ] **Step 6: Typecheck and run the whole suite**

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
cd codey-mac && npx tsc --noEmit -p tsconfig.electron.json && npx tsc --noEmit -p tsconfig.json
```

Expected: no output from either. A `Cannot find name 'voiceHudWindow'` here means
a call site was missed in Step 1 or 4.

```bash
npm test -w codey-mac
```

Expected: all tests pass.

- [ ] **Step 7: Check nothing still references the deleted route**

```bash
grep -rn "voice-hud\|VoiceHud" codey-mac/src codey-mac/electron
```

Expected: only `codey-mac/electron/voice-hud.ts` and its test. Any hit in
`src/` is a leftover — remove it.

- [ ] **Step 8: Commit**

```bash
git add -A codey-mac
git commit -m "Draw the conversation capsule in the voice helper, not a window"
```

---

## Task 6: Verify on real hardware

None of this can be checked by reading code or running the suite. Do not report
the work as done until these have actually been run.

**Files:** none

- [ ] **Step 1: Build and launch**

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
cd voice && make helper
cd ../codey-mac && npm run build && npm start
```

- [ ] **Step 2: Work through the checklist**

Enable voice conversation in Settings → Whisper and assign a non-Fn converse
hotkey. Then, with a chat selected:

1. Put another app in front and type in it. Press the converse hotkey. **Focus
   must stay where it was** — no Space switch, no Dock flicker. This is the bug
   the whole change exists for; check it first and check it on the *first* press
   after launching.
2. The capsule appears bottom-centre of the display holding the cursor.
3. The rainbow outline scrolls, and the colour bleeds inward from the edge. If
   the bleed is too subtle or too strong, adjust `bleedDepth` /
   `bleedPeakAlpha` in `RainbowCapsuleLayer.swift` and rebuild.
4. Labels advance Listening → Thinking → Speaking, and the meter moves while
   listening.
5. Enter a fullscreen app and press the hotkey: the capsule is visible over it.
   Switch to another Space and repeat.
6. Press Esc mid-turn: the turn cancels. Then, with no turn active, press Esc in
   another app — it must behave normally there.
7. Click the composer's mic button instead of using the hotkey: **no** floating
   capsule, and the in-composer status still updates.
8. Run a dictation turn (the `voice.hotkey` binding): the plain pill appears,
   with no rainbow left over from the converse turn.

- [ ] **Step 3: Record the result**

Write down which of the eight passed. If a tunable changed, commit it:

```bash
git add voice/Sources/CodeyVoice/RainbowCapsuleLayer.swift
git commit -m "Tune the capsule bleed after a look on hardware"
```

---

## Notes for the implementer

- **Do not** "fix" the old `setVisibleOnAllWorkspaces` call by adding
  `skipTransformProcessType`. The window is being deleted; a patch there is
  wasted work and would make the diff confusing.
- `VoiceCoordinator.startConverse` (line 519) has no callers and is dead in the
  current build. Leave it alone — removing it is a separate change with its own
  reasoning.
- The Swift package has no test target. Do not add one for this change; the
  automated coverage that makes sense here is the Electron encoding, and it is
  in Task 4.
