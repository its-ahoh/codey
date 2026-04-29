import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import { apiService } from '../services/api'
import type { Chat, ChatSelection, ChatMessage, ToolCallEntry, FileAttachment } from '../types'
import type { ChatStreamEvent } from '../../../packages/gateway/src/chat-runner'

interface InFlight {
  assistantMessageId: string
  agentStatus: 'idle' | 'thinking' | 'working' | 'writing'
  queuedPosition?: number
}

interface State {
  chats: Record<string, Chat>
  order: string[]
  selectedChatId: string | null
  inFlight: Record<string, InFlight>
  collapsedWorkspaces: Record<string, true>
  workspaces: string[]
}

type Action =
  | { type: 'loaded'; chats: Chat[] }
  | { type: 'setWorkspaces'; workspaces: string[] }
  | { type: 'upsert'; chat: Chat }
  | { type: 'remove'; chatId: string }
  | { type: 'select'; chatId: string | null }
  | { type: 'toggleWorkspace'; workspaceName: string }
  | { type: 'startSend'; chatId: string; userMessage: ChatMessage; assistantMessageId: string }
  | { type: 'streamToken'; chatId: string; token: string }
  | { type: 'toolCall'; chatId: string; entry: ToolCallEntry; status: 'working' | 'writing' }
  | { type: 'queued'; chatId: string; position: number }
  | { type: 'completeSend'; chatId: string; assistantMessageId: string; content: string; tokens?: number; durationSec?: number }
  | { type: 'errorSend'; chatId: string; assistantMessageId: string; error: string }

function reorder(order: string[], chatId: string): string[] {
  return [chatId, ...order.filter(id => id !== chatId)]
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded': {
      const chats: Record<string, Chat> = {}
      const sorted = [...action.chats].sort((a, b) => b.updatedAt - a.updatedAt)
      for (const c of sorted) chats[c.id] = c
      return { ...state, chats, order: sorted.map(c => c.id) }
    }
    case 'setWorkspaces':
      return { ...state, workspaces: action.workspaces }
    case 'upsert': {
      const chats = { ...state.chats, [action.chat.id]: action.chat }
      const order = state.order.includes(action.chat.id) ? state.order : [action.chat.id, ...state.order]
      return { ...state, chats, order: reorder(order, action.chat.id) }
    }
    case 'remove': {
      const chats = { ...state.chats }
      delete chats[action.chatId]
      const order = state.order.filter(id => id !== action.chatId)
      const selectedChatId = state.selectedChatId === action.chatId ? (order[0] ?? null) : state.selectedChatId
      const inFlight = { ...state.inFlight }
      delete inFlight[action.chatId]
      return { ...state, chats, order, selectedChatId, inFlight }
    }
    case 'select':
      return { ...state, selectedChatId: action.chatId }
    case 'toggleWorkspace': {
      const collapsed = { ...state.collapsedWorkspaces }
      if (collapsed[action.workspaceName]) delete collapsed[action.workspaceName]
      else collapsed[action.workspaceName] = true
      return { ...state, collapsedWorkspaces: collapsed }
    }
    case 'startSend': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const assistantStub: ChatMessage = {
        id: action.assistantMessageId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [],
        isComplete: false,
      }
      const updated: Chat = {
        ...chat,
        messages: [...chat.messages, action.userMessage, assistantStub],
        updatedAt: Date.now(),
      }
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: updated },
        order: reorder(state.order, chat.id),
        inFlight: {
          ...state.inFlight,
          [chat.id]: { assistantMessageId: action.assistantMessageId, agentStatus: 'thinking' },
        },
      }
    }
    case 'streamToken': {
      const chat = state.chats[action.chatId]
      const fl = state.inFlight[action.chatId]
      if (!chat || !fl) return state
      const messages = chat.messages.map(m =>
        m.id === fl.assistantMessageId ? { ...m, content: m.content + action.token } : m
      )
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } },
        inFlight: { ...state.inFlight, [chat.id]: { ...fl, agentStatus: 'writing' } },
      }
    }
    case 'toolCall': {
      const chat = state.chats[action.chatId]
      const fl = state.inFlight[action.chatId]
      if (!chat || !fl) return state
      const messages = chat.messages.map(m =>
        m.id === fl.assistantMessageId
          ? { ...m, toolCalls: [...(m.toolCalls ?? []), action.entry] }
          : m
      )
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } },
        inFlight: { ...state.inFlight, [chat.id]: { ...fl, agentStatus: action.status } },
      }
    }
    case 'queued': {
      const fl = state.inFlight[action.chatId]
      if (!fl) return state
      return {
        ...state,
        inFlight: { ...state.inFlight, [action.chatId]: { ...fl, queuedPosition: action.position } },
      }
    }
    case 'completeSend': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const messages = chat.messages.map(m =>
        m.id === action.assistantMessageId
          ? { ...m, content: action.content, tokens: action.tokens, durationSec: action.durationSec, isComplete: true }
          : m
      )
      const inFlight = { ...state.inFlight }
      delete inFlight[action.chatId]
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } },
        order: reorder(state.order, chat.id),
        inFlight,
      }
    }
    case 'errorSend': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const messages = chat.messages.map(m =>
        m.id === action.assistantMessageId
          ? { ...m, content: action.error, isComplete: true }
          : m
      )
      const inFlight = { ...state.inFlight }
      delete inFlight[action.chatId]
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } },
        inFlight,
      }
    }
    default:
      return state
  }
}

interface ChatsContextValue {
  state: State
  createChat: (workspaceName: string) => Promise<Chat>
  selectChat: (chatId: string | null) => void
  renameChat: (chatId: string, title: string) => Promise<void>
  deleteChat: (chatId: string) => Promise<void>
  setSelection: (chatId: string, selection: ChatSelection) => Promise<void>
  sendMessage: (chatId: string, text: string, attachments?: FileAttachment[]) => Promise<void>
  stopChat: (chatId: string) => Promise<void>
  toggleWorkspace: (workspaceName: string) => void
  refreshWorkspaces: () => Promise<void>
}

const ChatsContext = createContext<ChatsContextValue | null>(null)

const LS_ACTIVE = 'codey.activeChatId'
const LS_COLLAPSED = 'codey.collapsedWorkspaces'

export const ChatsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(reducer, {
    chats: {},
    order: [],
    selectedChatId: null,
    inFlight: {},
    collapsedWorkspaces: (() => {
      try { return JSON.parse(localStorage.getItem(LS_COLLAPSED) ?? '{}') } catch { return {} }
    })(),
    workspaces: [],
  })

  const pendingAssistantId = useRef<Record<string, string>>({})

  useEffect(() => {
    ;(async () => {
      const [chats, workspaces] = await Promise.all([
        apiService.chats.list(),
        apiService.getWorkspaces(),
      ])
      dispatch({ type: 'loaded', chats })
      dispatch({ type: 'setWorkspaces', workspaces })
      const stored = localStorage.getItem(LS_ACTIVE)
      if (stored && chats.some(c => c.id === stored)) {
        dispatch({ type: 'select', chatId: stored })
      } else if (chats.length > 0) {
        dispatch({ type: 'select', chatId: chats[0].id })
      }
    })()
  }, [])

  useEffect(() => {
    if (state.selectedChatId) localStorage.setItem(LS_ACTIVE, state.selectedChatId)
    else localStorage.removeItem(LS_ACTIVE)
  }, [state.selectedChatId])

  useEffect(() => {
    localStorage.setItem(LS_COLLAPSED, JSON.stringify(state.collapsedWorkspaces))
  }, [state.collapsedWorkspaces])

  useEffect(() => {
    const off = apiService.chats.onEvent((ev: ChatStreamEvent) => {
      switch (ev.type) {
        case 'queued':
          dispatch({ type: 'queued', chatId: ev.chatId, position: ev.position })
          break
        case 'tool_start':
          dispatch({
            type: 'toolCall',
            chatId: ev.chatId,
            entry: { id: `tc-${Date.now()}-${Math.random()}`, type: 'tool_start', tool: ev.tool, message: ev.message, input: ev.input },
            status: 'working',
          })
          break
        case 'tool_end':
          dispatch({
            type: 'toolCall',
            chatId: ev.chatId,
            entry: { id: `tc-${Date.now()}-${Math.random()}`, type: 'tool_end', tool: ev.tool, message: ev.message, output: ev.output },
            status: 'working',
          })
          break
        case 'info':
          dispatch({
            type: 'toolCall',
            chatId: ev.chatId,
            entry: { id: `tc-${Date.now()}-${Math.random()}`, type: 'info', message: ev.message },
            status: 'working',
          })
          break
        case 'stream':
          dispatch({ type: 'streamToken', chatId: ev.chatId, token: ev.token })
          break
        case 'done': {
          const asstId = pendingAssistantId.current[ev.chatId]
          if (asstId) {
            dispatch({
              type: 'completeSend',
              chatId: ev.chatId,
              assistantMessageId: asstId,
              content: ev.response,
              tokens: ev.tokens,
              durationSec: ev.durationSec,
            })
            delete pendingAssistantId.current[ev.chatId]
          }
          break
        }
        case 'error': {
          const asstId = pendingAssistantId.current[ev.chatId]
          if (asstId) {
            dispatch({ type: 'errorSend', chatId: ev.chatId, assistantMessageId: asstId, error: ev.message })
            delete pendingAssistantId.current[ev.chatId]
          }
          break
        }
      }
    })
    return off
  }, [])

  const value = useMemo<ChatsContextValue>(() => ({
    state,
    async createChat(workspaceName) {
      const chat = await apiService.chats.create({ workspaceName })
      dispatch({ type: 'upsert', chat })
      dispatch({ type: 'select', chatId: chat.id })
      return chat
    },
    selectChat(chatId) { dispatch({ type: 'select', chatId }) },
    async renameChat(chatId, title) {
      const chat = await apiService.chats.rename(chatId, title)
      dispatch({ type: 'upsert', chat })
    },
    async deleteChat(chatId) {
      await apiService.chats.delete(chatId)
      dispatch({ type: 'remove', chatId })
    },
    async setSelection(chatId, selection) {
      const chat = await apiService.chats.updateSelection(chatId, selection)
      dispatch({ type: 'upsert', chat })
    },
    async sendMessage(chatId, text, attachments) {
      const assistantMessageId = `asst-${Date.now()}-${Math.random()}`
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}-${Math.random()}`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        isComplete: true,
      }
      pendingAssistantId.current[chatId] = assistantMessageId
      dispatch({ type: 'startSend', chatId, userMessage, assistantMessageId })
      try {
        await apiService.chats.send(chatId, text, attachments)
      } catch (err) {
        dispatch({ type: 'errorSend', chatId, assistantMessageId, error: `Error: ${(err as Error).message}` })
        delete pendingAssistantId.current[chatId]
      }
    },
    async stopChat(chatId) {
      try { await apiService.chats.stop(chatId) } catch { /* nothing in flight */ }
    },
    toggleWorkspace(workspaceName) { dispatch({ type: 'toggleWorkspace', workspaceName }) },
    async refreshWorkspaces() {
      const workspaces = await apiService.getWorkspaces()
      dispatch({ type: 'setWorkspaces', workspaces })
    },
  }), [state])

  return <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>
}

export function useChats(): ChatsContextValue {
  const ctx = useContext(ChatsContext)
  if (!ctx) throw new Error('useChats must be used inside <ChatsProvider>')
  return ctx
}
