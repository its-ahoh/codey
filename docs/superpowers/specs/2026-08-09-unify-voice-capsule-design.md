# Unify the dictation and conversation voice capsules

Date: 2026-08-09
Status: approved, not yet implemented

## Problem

Codey shows a floating status capsule while voice input is active. There are two
of them, built two different ways:

| | dictation capsule | conversation capsule |
|---|---|---|
| Implementation | `voice/Sources/CodeyVoice/HudOverlay.swift` — AppKit `NSPanel` | `codey-mac/electron/main.ts:325 createVoiceHudWindow()` + `codey-mac/src/components/VoiceHud.tsx` |
| Process | CodeyVoice helper (`LSUIElement`, accessory) | Codey.app main process (foreground, has a Dock icon) |
| Cross-Space / over-fullscreen | `collectionBehavior` set at construction | `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` |
| Avoids stealing focus | `.nonactivatingPanel` + `orderFrontRegardless()` | `focusable: false` + `showInactive()` |

The Electron path has a user-visible defect. `main.ts:352` calls
`setVisibleOnAllWorkspaces` without `skipTransformProcessType`, which per
Electron's own typings "will hide the window and dock for a short time every
time it is called" — it runs `TransformProcessType` between
`UIElementApplication` and `ForegroundApplication` on the whole process. Codey
is a foreground app, so that transition makes macOS re-pick the frontmost
application and the user's focus jumps away from whatever they were doing.

It only happens once per app launch because the capsule window is created
lazily on the first converse hotkey press (`main.ts:386`) and reused after
that. The dictation capsule has never shown this symptom: it lives in an
accessory process with no foreground/accessory transition to make, and it
declares `collectionBehavior` directly instead of going through Electron's
helper.

We are not patching the Electron call. We are removing the second
implementation and letting the conversation capsule use the one that already
works.

## Key insight: the seam already exists

`VoiceCoordinator.swift` forks at every state transition:

```swift
if destination.composerMode != nil {
    hud.hide()                                    // yield to Electron's capsule
    emitConversationEvent(type: "state", payload: ["state": "recording"])
} else {
    hud.show(.recording)                          // dictation draws its own pill
}
```

The helper is already wired to display a conversation capsule; the branch
deliberately suppresses it. This change flips that branch from "who draws it"
to "what it looks like". `emitConversationEvent` stays — the renderer still
needs conversation state to drive the in-composer UI.

## Design

### Swift: HudOverlay

- Add `case conversation(ConversationPhase)` to `HudOverlay.Mode`, with
  `ConversationPhase` = `.listening | .thinking | .speaking`. These map 1:1 onto
  the labels in `VoiceHud.tsx:19` (`recording→Listening`,
  `transcribing→Thinking`, `speaking→Speaking`), so the wording users see does
  not change.
- Add `RainbowCapsuleLayer` in its own file. `HudOverlay` assembles it; it owns
  no voice state. Composition, bottom to top:
  1. Base: `#25221d` rounded rect (matches the current CSS fill).
  2. Inward bleed: a rainbow `CAGradientLayer` masked by an edge-opaque →
     centre-transparent gradient mask.
  3. Outline: the same rainbow gradient masked by a `CAShapeLayer` that strokes
     the rounded-rect path with no fill.
  - Layers 2 and 3 are driven by a single `CABasicAnimation` on `position.x`,
    4s linear, repeating, so the outline and the bleed stay in phase. The CSS
    version has only one rainbow layer, so this constraint is new.
  - Honour `NSWorkspace.shared.accessibilityDisplayShouldReduceMotion` by
    skipping the animation, matching the existing
    `@media (prefers-reduced-motion: reduce)` rule.
- Rainbow stops carry over unchanged from `VoiceHud.tsx:87-88`:
  `#ff5f6d, #ffc371, #47e6b1, #38a3f5, #a86bf5, #ff5f6d`.

### Visual tuning

Two deliberate changes from today's look, both requested:

- Inward bleed: depth 8px from the edge, peak alpha 0.45.
- Outline width: 2px → 2.5px.

Both are named constants at the top of `RainbowCapsuleLayer` so they can be
adjusted after a look on real hardware.

### When the capsule shows: Electron stays the sole decider

Electron already owns the "should there be a capsule" decision, in exactly two
places, and both already gate correctly:

- native/local turns: `main.ts:1297`, gated on `nativeConverseFromHotkey`
- browser turns (non-local provider): the renderer's `voice:hudState` IPC,
  gated by `ChatTab.tsx:1663`'s `voice.fromHotkey` check

So `showVoiceHud` / `hideVoiceHud` become thin stdin senders and every call site
upstream stays untouched. Composer-button turns get no capsule for the same
reason they get none today: neither gate fires.

This drops a piece an earlier draft of this spec called for — a
`conversation-toggle hotkey` command variant letting the helper decide for
itself. It is unnecessary. The helper does not need to know why a turn started;
it needs to draw what it is told to draw.

Two facts confirm Electron must stay the driver:

- `VoiceCoordinator.startConverse` (line 519) has no callers. The helper's
  `.speaking` state is unreachable in the current build — a conversation reply
  and its TTS live in Electron. Only Electron knows when a turn is speaking.
- The level signal already round-trips through Electron on local turns
  (`onLevel` → `emitConversationEvent` → `main.ts:1306`). One source for the
  meter is worth more than saving a hop on a 20 Hz signal over a local pipe.

### stdin protocol

`VoiceCoordinator.handleExternalCommand` gains two commands:

- `hud-state <listening|thinking|speaking|idle>` — `idle` hides
- `hud-level <0..1>`

Both are ignored while a **dictation** capture is in flight
(`captureDestination == .dictation && state != .idle`), so a stray command
cannot pull the pill out from under dictation. A local-provider conversation
does not trip the guard: its `captureDestination` is `.conversation`.

When `sendVoiceHelperCommand` returns false (helper not running), skip silently
and write one `[voice]` log line — recording is already failing in that case.

`HudOverlay` keeps a single `NSPanel` for both the dictation pill and the
conversation capsule. The two cannot logically co-occur: one microphone, one
capture at a time.

### Electron: deletions

- `voiceHudWindow`, `createVoiceHudWindow`, `showVoiceHud`, `hideVoiceHud`,
  `positionVoiceHud` (`main.ts:301-406`)
- `registerVoiceHudEscape` / `unregisterVoiceHudEscape`. This also drops a
  global `Escape` grab that currently takes the key away from every other app
  while a turn is live. The helper's `installEscMonitor`
  (`VoiceCoordinator.swift:371`) already handles Esc for both the recording and
  speaking states, and only while a capture is active.
- `src/components/VoiceHud.tsx` and the `#/voice-hud` branch in `src/main.tsx`
- `ipcMain` handlers `voice:hudState` and `voice:hudLevel` become stdin
  forwarders. Their preload signatures do not change, so the renderer is
  unaffected.

The offending `setVisibleOnAllWorkspaces` call disappears along with the window
it configured. The bug is not fixed; its home is removed.

## Testing

`voice/` has no test target, so coverage splits:

**Automated (vitest, alongside `codey-mac/electron/capture.test.ts`)**

Command encoding moves into a pure `electron/voice-hud.ts` module with no
Electron imports, following the pattern `electron/capture.ts` established, so it
can be tested directly:

- `hudStateCommand` maps each renderer state onto the right stdin line, and maps
  `idle` / `hidden` / unknown values onto `hud-state idle`.
- `hudLevelCommand` clamps to `0..1` and emits a fixed-precision level, so a
  `NaN` or out-of-range reading can never produce a malformed line.
- `main.ts`'s senders degrade without throwing when the helper is absent.

**Manual, on real hardware — cannot be automated, will not be claimed as verified**

1. First converse hotkey press after launch: focus stays in the app you were
   using, no Space switch, Dock icon does not flicker.
2. Capsule appears bottom-centre of the display under the cursor.
3. Capsule is visible over a fullscreen app and on a different Space.
4. Rainbow outline scrolls; the inward bleed reads as intended at 8px / 0.45.
5. Esc during a turn cancels it, and Esc still works normally in other apps
   while no turn is active.
6. Composer mic button produces no floating capsule.

## Risks

Conversation capsule display becomes entirely dependent on the helper process.
Today, under an API provider, the Electron window would still render the capsule
if the helper had died. After this change it will not. Accepted — a dead helper
already breaks half of voice — but it is a real narrowing of behaviour.

The gradient's appearance cannot be verified by reading code. Expect one round
of constant tuning after the first real-hardware look.
