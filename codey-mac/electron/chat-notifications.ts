// Pure decision logic for native macOS notifications. No Electron imports so
// it is unit-testable; main.ts supplies context (focus, enabled, chat title)
// and renders the returned decision with the Notification API.

// Structural subset of ChatStreamEvent — only the fields this module reads.
export interface NotifyEvent {
  type: string
  chatId: string
  response?: string
  message?: string
  userQuestion?: {
    question: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }
}

export interface NotifyContext {
  focused: boolean
  enabled: boolean
  chatTitle?: string
}

export interface NotificationDecision {
  chatId: string
  title: string
  body: string
  actions?: Array<{ label: string }>
}

const MAX_BODY = 180
const MAX_ACTIONS = 4

export function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

function withTitle(base: string, chatTitle?: string): string {
  return chatTitle ? `${base} — ${chatTitle}` : base
}

export function decideNotification(ev: NotifyEvent, ctx: NotifyContext): NotificationDecision | null {
  if (!ctx.enabled || ctx.focused) return null
  if (ev.type === 'error') {
    return { chatId: ev.chatId, title: withTitle('Codey hit an error', ctx.chatTitle), body: truncate(ev.message ?? '', MAX_BODY) }
  }
  if (ev.type !== 'done') return null
  const q = ev.userQuestion
  if (q && q.options.length >= 1) {
    const decision: NotificationDecision = {
      chatId: ev.chatId,
      title: withTitle('Codey needs your input', ctx.chatTitle),
      body: truncate(q.question, MAX_BODY),
    }
    if (!q.multiSelect) decision.actions = q.options.slice(0, MAX_ACTIONS).map(o => ({ label: o.label }))
    return decision
  }
  return { chatId: ev.chatId, title: withTitle('Codey finished', ctx.chatTitle), body: truncate(ev.response ?? '', MAX_BODY) }
}

const TERMINAL_TYPES = new Set(['done', 'error', 'stopped'])

// Per-chat turn state: dedupes notifications (one per turn) and tells the
// action-button handler whether a new turn is already running (stale button).
export interface TurnTracker {
  observe(ev: { type: string; chatId: string }): void
  markNotified(chatId: string): void
  alreadyNotified(chatId: string): boolean
  isInFlight(chatId: string): boolean
}

export function createTurnTracker(): TurnTracker {
  const notified = new Set<string>()
  const inFlight = new Set<string>()
  return {
    observe(ev) {
      if (TERMINAL_TYPES.has(ev.type)) {
        inFlight.delete(ev.chatId)
      } else {
        // Any non-terminal event means a turn is running; that's a NEW turn,
        // so clear the previous turn's notified flag.
        inFlight.add(ev.chatId)
        notified.delete(ev.chatId)
      }
    },
    markNotified: (chatId) => { notified.add(chatId) },
    alreadyNotified: (chatId) => notified.has(chatId),
    isInFlight: (chatId) => inFlight.has(chatId),
  }
}
