import React, { createContext, useContext, useEffect, useMemo, useReducer } from 'react'
import { apiService } from '../services/api'
import type { QQStreamEvent } from '../services/api'

export interface QQMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  error?: boolean
}

export interface QQThread {
  messages: QQMessage[]
  inFlight: boolean
  activity?: string // latest tool/status line while running
}

interface State {
  threads: Record<string, QQThread>
}

type Action =
  | { type: 'startAsk'; chatId: string; userMsg: QQMessage; assistantId: string }
  | { type: 'token'; chatId: string; token: string }
  | { type: 'activity'; chatId: string; message: string }
  | { type: 'done'; chatId: string; content: string }
  | { type: 'error'; chatId: string; message: string }
  | { type: 'stopped'; chatId: string }

const EMPTY: QQThread = { messages: [], inFlight: false }

function reducer(state: State, action: Action): State {
  const t = state.threads[action.chatId] ?? EMPTY
  switch (action.type) {
    case 'startAsk':
      return {
        threads: {
          ...state.threads,
          [action.chatId]: {
            messages: [
              ...t.messages,
              action.userMsg,
              { id: action.assistantId, role: 'assistant', content: '', streaming: true },
            ],
            inFlight: true,
            activity: undefined,
          },
        },
      }
    case 'token': {
      const msgs = t.messages.map(m =>
        m.streaming ? { ...m, content: m.content + action.token } : m,
      )
      return { threads: { ...state.threads, [action.chatId]: { ...t, messages: msgs } } }
    }
    case 'activity':
      return { threads: { ...state.threads, [action.chatId]: { ...t, activity: action.message } } }
    case 'done': {
      const msgs = t.messages.map(m =>
        m.streaming ? { ...m, content: action.content || m.content, streaming: false } : m,
      )
      return { threads: { ...state.threads, [action.chatId]: { messages: msgs, inFlight: false } } }
    }
    case 'stopped': {
      const msgs = t.messages.map(m => (m.streaming ? { ...m, streaming: false } : m))
      return { threads: { ...state.threads, [action.chatId]: { messages: msgs, inFlight: false } } }
    }
    case 'error': {
      const msgs = t.messages.map(m =>
        m.streaming ? { ...m, content: action.message, streaming: false, error: true } : m,
      )
      return { threads: { ...state.threads, [action.chatId]: { messages: msgs, inFlight: false } } }
    }
    default:
      return state
  }
}

interface QuickQuestionContextValue {
  getThread: (chatId: string) => QQThread
  ask: (chatId: string, question: string) => Promise<void>
  stop: (chatId: string) => Promise<void>
}

const Ctx = createContext<QuickQuestionContextValue | null>(null)

export const QuickQuestionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(reducer, { threads: {} })

  useEffect(() => {
    const off = apiService.qq.onEvent((ev: QQStreamEvent) => {
      switch (ev.type) {
        case 'stream':
          dispatch({ type: 'token', chatId: ev.chatId, token: ev.token })
          break
        case 'tool':
          dispatch({ type: 'activity', chatId: ev.chatId, message: ev.message })
          break
        case 'done':
          dispatch({ type: 'done', chatId: ev.chatId, content: ev.response })
          break
        case 'stopped':
          dispatch({ type: 'stopped', chatId: ev.chatId })
          break
        case 'error':
          dispatch({ type: 'error', chatId: ev.chatId, message: ev.message })
          break
      }
    })
    return off
  }, [])

  const value = useMemo<QuickQuestionContextValue>(() => ({
    getThread: (chatId) => state.threads[chatId] ?? EMPTY,
    async ask(chatId, question) {
      const q = question.trim()
      if (!q) return
      const thread = state.threads[chatId] ?? EMPTY
      if (thread.inFlight) return
      const history = thread.messages
        .filter(m => !m.error && m.content)
        .map(m => ({ role: m.role, content: m.content }))
      const userMsg: QQMessage = {
        id: `qq-u-${Date.now()}-${Math.random()}`,
        role: 'user',
        content: q,
      }
      const assistantId = `qq-a-${Date.now()}-${Math.random()}`
      dispatch({ type: 'startAsk', chatId, userMsg, assistantId })
      try {
        await apiService.qq.ask(chatId, q, history)
      } catch (err) {
        dispatch({ type: 'error', chatId, message: `Error: ${(err as Error).message}` })
      }
    },
    async stop(chatId) {
      try { await apiService.qq.stop(chatId) } catch { /* nothing in flight */ }
    },
  }), [state])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useQuickQuestion(): QuickQuestionContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useQuickQuestion must be used inside <QuickQuestionProvider>')
  return ctx
}
