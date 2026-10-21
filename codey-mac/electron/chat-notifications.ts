// Pure decision logic for native macOS notifications. No Electron imports so
// it is unit-testable; main.ts supplies context (focus, enabled, chat title)
// and renders the returned decision with the Notification API.

// Structural subset of ChatStreamEvent — only the fields this module reads.
export interface NotifyEvent {
  type: string
  chatId: string
  response?: string
  message?: string
  choices?: string[]
  botStatus?: string
  failed?: boolean
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

// Flatten markdown into clean single-line plain text for notification bodies.
// macOS notifications don't render markdown, so raw `**bold**`, `## heads`,
// `- bullets`, links and code fences read as noise. We keep the words, drop
// the syntax, and collapse whitespace to a compact preview.
export function mdToPlainText(input: string): string {
  let s = input
  // Fenced code blocks: keep the inner code, drop the ``` fences/lang.
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code) => code)
  // Images ![alt](url) → alt, then links [text](url) → text.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // Strip leading block markers (headings, blockquotes, list bullets).
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  s = s.replace(/^\s*>\s?/gm, '')
  s = s.replace(/^\s*([-*_])\1{2,}\s*$/gm, '') // horizontal rules
  s = s.replace(/^\s*[-*+]\s+/gm, '')
  s = s.replace(/^\s*\d+\.\s+/gm, '')
  // Inline emphasis / code markers.
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2')
  s = s.replace(/(\*|_)(.*?)\1/g, '$2')
  s = s.replace(/~~(.*?)~~/g, '$1')
  s = s.replace(/`([^`]+)`/g, '$1')
  // Collapse all whitespace (incl. newlines) into single spaces.
  return s.replace(/\s+/g, ' ').trim()
}

function withTitle(base: string, chatTitle?: string): string {
  return chatTitle ? `${base} — ${chatTitle}` : base
}

export function decideNotification(ev: NotifyEvent, ctx: NotifyContext): NotificationDecision | null {
  if (!ctx.enabled || ctx.focused) return null
  if (ev.type === 'error') {
    return { chatId: ev.chatId, title: withTitle('Codey hit an error', ctx.chatTitle), body: truncate(mdToPlainText(ev.message ?? ''), MAX_BODY) }
  }
  if (ev.type !== 'done') return null
  const q = ev.userQuestion
  if (q && q.options.length >= 1) {
    const decision: NotificationDecision = {
      chatId: ev.chatId,
      title: withTitle('Codey needs your input', ctx.chatTitle),
      body: truncate(mdToPlainText(q.question), MAX_BODY),
    }
    if (!q.multiSelect) decision.actions = q.options.slice(0, MAX_ACTIONS).map(o => ({ label: o.label }))
    return decision
  }
  return { chatId: ev.chatId, title: withTitle('Codey finished', ctx.chatTitle), body: truncate(mdToPlainText(ev.response ?? ''), MAX_BODY) }
}

// Turn-end chime. Unlike the banner this is NOT focus-gated: the point is to
// hear the state change while looking at another window or another chat.
// A user-pressed stop gets no sound — the user already knows.
export type TurnSound = 'done' | 'input' | 'error'

export interface TurnSoundContext {
  enabled: boolean
  // Automation chats run unattended; their runs have their own opt-in banner.
  automation?: boolean
  // The chat is parked on a team question (pendingTeam). A free-text team
  // question carries no choices or userQuestion on the done event.
  awaitingInput?: boolean
}

export function decideTurnSound(ev: NotifyEvent, ctx: TurnSoundContext): TurnSound | null {
  if (!ctx.enabled || ctx.automation) return null
  if (ev.type === 'error') return 'error'
  if (ev.type !== 'done') return null
  // Team runs report a crash as `done` with `failed`.
  if (ev.failed || ev.botStatus === 'failed') return 'error'
  const asked = ctx.awaitingInput
    || ev.botStatus === 'askedUser'
    || (ev.userQuestion?.options.length ?? 0) >= 1
    || (ev.choices?.length ?? 0) >= 1
  return asked ? 'input' : 'done'
}

// macOS system sounds; always present under /System/Library/Sounds.
export const TURN_SOUND_FILES: Record<TurnSound, string> = {
  done: '/System/Library/Sounds/Glass.aiff',
  input: '/System/Library/Sounds/Ping.aiff',
  error: '/System/Library/Sounds/Basso.aiff',
}

export const SOUND_FILE_EXTENSIONS = ['aiff', 'aif', 'wav', 'mp3', 'm4a', 'aac', 'caf']

// Only an absolute path to an audio file reaches afplay: the path comes from
// the renderer (preview) or a hand-editable config, and a leading '-' would
// be read as an afplay option.
function isPlayableSoundPath(p: string): boolean {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase()
  return p.startsWith('/') && SOUND_FILE_EXTENSIONS.includes(ext)
}

// A user-picked file wins; a file that has since been moved or deleted falls
// back to the built-in sound rather than going silent.
export function resolveTurnSoundFile(sound: TurnSound, customFile: string | undefined, exists: (p: string) => boolean): string {
  return customFile && isPlayableSoundPath(customFile) && exists(customFile) ? customFile : TURN_SOUND_FILES[sound]
}

const TERMINAL_TYPES = new Set(['done', 'error', 'stopped'])

// Per-chat turn state: dedupes notifications (one per turn) and tells the
// action-button handler whether a new turn is already running (stale button).
export interface TurnTracker {
  observe(ev: { type: string; chatId: string; skillNotice?: boolean }): void
  markNotified(chatId: string): void
  alreadyNotified(chatId: string): boolean
  isInFlight(chatId: string): boolean
}

export function createTurnTracker(): TurnTracker {
  const notified = new Set<string>()
  const inFlight = new Set<string>()
  return {
    observe(ev) {
      // Skill suggestions/evolution notices are emitted by the fire-and-forget
      // post-run pass after `done`. They are notices, not a new running turn.
      if (ev.type === 'info' && ev.skillNotice) return
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
