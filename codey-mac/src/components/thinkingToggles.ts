// Per-message thinking disclosure overrides. ChatTab is remounted on every chat
// switch (App.tsx keys it by chat id), so its local `thinkingToggles` state
// reset and a thinking block the user collapsed would re-expand when they came
// back (defaultThinkingExpanded auto-opens in-flight thinking). We keep the
// explicit overrides in a module-level store keyed by message id so they
// survive that remount, mirroring terminalVisibility.ts.
const overrides = new Map<string, boolean>()

/** All explicit overrides, used to seed ChatTab's state on mount. */
export function getThinkingToggles(): Record<string, boolean> {
  return Object.fromEntries(overrides)
}

/** Remember a user's explicit expand/collapse for one message. */
export function rememberThinkingToggle(messageId: string, expanded: boolean): void {
  overrides.set(messageId, expanded)
}

// Test-only: reset the store between cases.
export function __resetThinkingToggles(): void {
  overrides.clear()
}
