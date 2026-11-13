import { useEffect, useSyncExternalStore } from 'react'
import type { ChatMessage } from '@codey/core'

/**
 * Sign-in state, shared by every card and the Agents tab.
 *
 * It is keyed by agent, not by message: three failed chats waiting on Claude
 * Code are waiting on one login, and all three cards must move together.
 */

export type LoginProgress = {
  agent: string
  phase: 'starting' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'
  command: string
  url?: string
  output?: string
}

export type SignInState = Record<string, LoginProgress>

export function signInReducer(state: SignInState, progress: LoginProgress): SignInState {
  if (progress.phase === 'cancelled') {
    const { [progress.agent]: _gone, ...rest } = state
    return rest
  }
  // The page link arrives once; later events for the same run must not drop it.
  const url = progress.url ?? (progress.phase === 'waiting' ? state[progress.agent]?.url : undefined)
  return { ...state, [progress.agent]: { ...progress, ...(url ? { url } : {}) } }
}

export type CardView = 'idle' | 'running' | 'succeeded' | 'failed'

export function cardView(progress: LoginProgress | undefined): CardView {
  if (!progress) return 'idle'
  if (progress.phase === 'starting' || progress.phase === 'waiting') return 'running'
  return progress.phase === 'succeeded' ? 'succeeded' : progress.phase === 'failed' ? 'failed' : 'idle'
}

export type RetryPlan =
  | { kind: 'auto'; userMessageId: string }
  | { kind: 'manual'; userMessageId: string }
  | { kind: 'none' }

/**
 * What to do with the failed turn once sign-in succeeds. Re-send on our own
 * only when nothing has happened since: a newer user message or a running
 * turn means the user has moved on, and they get a button instead.
 */
export function retryPlan(
  messages: Array<Pick<ChatMessage, 'id' | 'role'>>,
  failedMessageId: string,
  opts: { busy: boolean },
): RetryPlan {
  const index = messages.findIndex(m => m.id === failedMessageId)
  if (index < 0) return { kind: 'none' }
  let userMessageId: string | undefined
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { userMessageId = messages[i].id; break }
  }
  if (!userMessageId) return { kind: 'none' }
  const newerUser = messages.slice(index + 1).some(m => m.role === 'user')
  return { kind: opts.busy || newerUser ? 'manual' : 'auto', userMessageId }
}

let snapshot: SignInState = {}
const listeners = new Set<() => void>()
let unsubscribeIpc: (() => void) | null = null

const publish = (next: SignInState) => {
  snapshot = next
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  if (!unsubscribeIpc) {
    unsubscribeIpc = window.codey.agents.onLoginProgress(p => publish(signInReducer(snapshot, p)))
  }
  return () => { listeners.delete(l) }
}

export function useAgentSignIn(agent: string): LoginProgress | undefined {
  return useSyncExternalStore(subscribe, () => snapshot)[agent]
}

/** Start (or join) the login. Progress arrives through the store. */
export function startSignIn(agent: string): void {
  void window.codey.agents.login(agent)
}

export function cancelSignIn(agent: string): void {
  void window.codey.agents.loginCancel(agent)
}

/** Forget a finished result, so a card on a later failure starts at idle. */
export function clearSignIn(agent: string): void {
  if (!snapshot[agent]) return
  const { [agent]: _gone, ...rest } = snapshot
  publish(rest)
}

type AuthStatus = 'signed-in' | 'signed-out' | 'api-key' | 'unknown'
let authSnapshot: Record<string, AuthStatus> | null = null
const authListeners = new Set<() => void>()

export async function refreshAuthStatus(): Promise<void> {
  try {
    const r = await window.codey.agents.authStatus()
    if (r.ok) {
      authSnapshot = r.data
      for (const l of authListeners) l()
    }
  } catch { /* a status line is not worth an error banner */ }
}

/** Sign-in state per agent for Settings; null until the first answer. */
export function useAuthStatus(enabled: boolean): Record<string, AuthStatus> | null {
  useEffect(() => { if (enabled) void refreshAuthStatus() }, [enabled])
  return useSyncExternalStore(
    l => { authListeners.add(l); return () => { authListeners.delete(l) } },
    () => authSnapshot,
  )
}
