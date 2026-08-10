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
