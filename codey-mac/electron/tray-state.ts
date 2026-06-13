// Pure reducer + summary for the menu-bar tray state. No Electron imports so
// it is unit-testable; main.ts feeds it chat events and renders the summary
// into a Tray menu.

export interface ChatTrayState { inFlight: boolean; needsAttention: boolean }
export type TrayStateMap = Record<string, ChatTrayState>

export interface TrayEvent { type: string; chatId: string; userQuestion?: unknown }

const TERMINAL = new Set(['done', 'error', 'stopped'])

export function applyEvent(state: TrayStateMap, ev: TrayEvent): TrayStateMap {
  if (!ev || typeof ev.chatId !== 'string') return state
  const id = ev.chatId
  if (!TERMINAL.has(ev.type)) {
    // Any non-terminal event = a (new) turn is running; clear stale attention.
    return { ...state, [id]: { inFlight: true, needsAttention: false } }
  }
  if (ev.type === 'error') {
    return { ...state, [id]: { inFlight: false, needsAttention: true } }
  }
  if (ev.type === 'done' && ev.userQuestion) {
    return { ...state, [id]: { inFlight: false, needsAttention: true } }
  }
  // plain done / stopped — a completed turn has no outstanding ask.
  return { ...state, [id]: { inFlight: false, needsAttention: false } }
}

export function clearAttention(state: TrayStateMap, chatId: string): TrayStateMap {
  const prev = state[chatId]
  if (!prev || !prev.needsAttention) return state
  return { ...state, [chatId]: { ...prev, needsAttention: false } }
}

export interface TraySummary { header: string; needsAttention: string[]; running: string[] }

export function summarize(state: TrayStateMap): TraySummary {
  const needsAttention: string[] = []
  const running: string[] = []
  for (const [id, s] of Object.entries(state)) {
    if (s.needsAttention) needsAttention.push(id)
    else if (s.inFlight) running.push(id)
  }
  const parts: string[] = []
  if (needsAttention.length) parts.push(`${needsAttention.length} needs attention`)
  if (running.length) parts.push(`${running.length} running`)
  return { header: parts.length ? parts.join(' · ') : 'Idle', needsAttention, running }
}
