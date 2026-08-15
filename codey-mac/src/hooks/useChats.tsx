import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import { apiService } from '../services/api'
import type { Chat, ChatSelection, ChatMessage, ChecklistItem, ToolCallEntry, FileAttachment, TaskBrief, TeamRunSummary } from '../types'
import type { ChatStreamEvent } from '../../../packages/gateway/src/chat-runner'
import { activityForTool, type AgentActivity } from '../components/agentActivity'

interface InFlight {
  assistantMessageId: string
  userMessageId: string
  agentStatus: AgentActivity
  queuedPosition?: number
  thinking?: string
  thinkingByStep?: Record<number, string>
}

export interface State {
  chats: Record<string, Chat>
  order: string[]
  selectedChatId: string | null
  inFlight: Record<string, InFlight>
  collapsedWorkspaces: Record<string, true>
  workspaces: string[]
  // When a turn is interrupted, the prompt text is stashed here so ChatTab
  // can repopulate the input box for the matching chat.
  pendingRestores: Record<string, string>
  unreadChats: Record<string, true>
  pendingPermissions: Record<string, string[]>
}

type Action =
  | { type: 'loaded'; chats: Chat[] }
  | { type: 'setWorkspaces'; workspaces: string[] }
  | { type: 'upsert'; chat: Chat }
  // Adopt a turn that was started outside the renderer (quick-capture or a
  // paired channel): insert the fetched chat, append an assistant stub, and
  // open an inFlight entry so its live events render. See onEvent adoption.
  | { type: 'adoptInFlight'; chat: Chat; assistantMessageId: string }
  | { type: 'remove'; chatId: string }
  | { type: 'select'; chatId: string | null }
  | { type: 'toggleWorkspace'; workspaceName: string }
  | { type: 'startSend'; chatId: string; userMessage: ChatMessage; assistantMessageId: string; agent?: ChatMessage['agent']; model?: string }
  | { type: 'streamToken'; chatId: string; token: string; messageId?: string }
  | { type: 'thinkingToken'; chatId: string; token: string; step?: number; messageId?: string }
  | { type: 'toolCall'; chatId: string; entry: ToolCallEntry; status: AgentActivity; messageId?: string }
  | { type: 'patchChecklist'; chatId: string; items: ChecklistItem[] }
  | { type: 'queued'; chatId: string; position: number }
  | { type: 'completeSend'; chatId: string; assistantMessageId: string; content: string; thinking?: string; tokens?: number; durationSec?: number; agent?: ChatMessage['agent']; model?: string; title?: string; choices?: string[]; userQuestion?: ChatMessage['userQuestion']; fallback?: ChatMessage['fallback']; teamTurnId?: string }
  | { type: 'errorSend'; chatId: string; assistantMessageId: string; error: string }
  | { type: 'stoppedSend'; chatId: string; text: string }
  | { type: 'clearRestore'; chatId: string }
  | { type: 'patchContextPanelOpen'; chatId: string; open: boolean | null }
  | { type: 'patchSoloAdvisor'; chatId: string; enabled: boolean }
  | { type: 'patchTaskBrief'; chatId: string; brief: TaskBrief }
  | { type: 'patchPullRequest'; chatId: string; pullRequest: NonNullable<Chat['pullRequest']> }
  | { type: 'permissionRequest'; chatId: string; toolNames: string[] }
  | { type: 'dismissPermission'; chatId: string }
  | { type: 'teamStart'; chatId: string; teamTurnId: string; teamName: string; mode: 'sequential' | 'graph' | 'auto' | 'parallel'; workers?: Array<{ messageId: string; step: number; worker: string; agent?: ChatMessage['agent']; model?: string }> }
  | { type: 'workerStart'; chatId: string; teamTurnId: string; messageId: string; step: number; worker: string; agent?: ChatMessage['agent']; model?: string; reason?: string }
  | { type: 'workerEnd'; chatId: string; messageId: string; step: number; status: 'running' | 'done' | 'failed' | 'askedUser' }
  | { type: 'teamEnd'; chatId: string; teamTurnId: string; summary: TeamRunSummary; taskBrief?: TaskBrief }

function reorder(order: string[], chatId: string): string[] {
  return [chatId, ...order.filter(id => id !== chatId)]
}

const EXTERNAL_TURN_EVENTS = new Set([
  'tool_start', 'tool_end', 'info', 'stream', 'thinking',
  'team_start', 'worker_start', 'worker_end', 'team_end',
])

/**
 * Decide whether a live event proves that a turn started outside the renderer.
 * Post-run skill notices deliberately arrive after `done`; treating one as a
 * new turn creates an assistant stub that can never receive a terminal event.
 */
export function shouldAdoptExternalTurn(
  ev: ChatStreamEvent,
  hasPendingAssistant: boolean,
  adoptionInProgress: boolean,
): boolean {
  if (hasPendingAssistant || adoptionInProgress) return false
  if (ev.type === 'info' && ev.skillNotice) return false
  return EXTERNAL_TURN_EVENTS.has(ev.type)
}

function mkWorkerStub(teamTurnId: string, teamName: string, mode: ChatMessage['teamMode'], id: string, step: number, worker: string, reason?: string, agent?: ChatMessage['agent'], model?: string): ChatMessage {
  return { id, role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [], isComplete: false, teamTurnId, teamName, teamMode: mode, step, worker, workerStatus: 'running', advisorReason: reason, agent, model }
}

export function reducer(state: State, action: Action): State {
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
      // When an assistant message is in flight, the server's view does not
      // include the streaming content (or even the placeholder). A blind
      // overwrite would erase the in-progress message until 'done' fires —
      // making the bubble appear to vanish whenever any field on the chat
      // is touched mid-stream (e.g. toggling the context panel).
      // Preserve the in-flight assistant message in that case.
      const fl = state.inFlight[action.chat.id]
      const existing = state.chats[action.chat.id]
      let next = action.chat
      if (fl && existing) {
        const inFlightMsg = existing.messages.find(m => m.id === fl.assistantMessageId)
        if (inFlightMsg && !next.messages.some(m => m.id === fl.assistantMessageId)) {
          next = { ...next, messages: [...next.messages, inFlightMsg] }
        }
      }
      const chats = { ...state.chats, [action.chat.id]: next }
      const order = state.order.includes(action.chat.id) ? state.order : [action.chat.id, ...state.order]
      return { ...state, chats, order: reorder(order, action.chat.id) }
    }
    case 'adoptInFlight': {
      // Externally-initiated turn (quick-capture / paired channel). The fetched
      // chat already holds the persisted user message; append an empty assistant
      // stub for the live turn and open an inFlight entry so streaming/tool
      // events render and the "working" indicator shows. Idempotent: if a turn
      // is already tracked for this chat, leave it untouched.
      if (state.inFlight[action.chat.id]) return state
      const assistantStub: ChatMessage = {
        id: action.assistantMessageId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [],
        isComplete: false,
      }
      const userMessageId = [...action.chat.messages].reverse().find(m => m.role === 'user')?.id ?? ''
      const adopted: Chat = {
        ...action.chat,
        messages: [...action.chat.messages, assistantStub],
        updatedAt: Date.now(),
      }
      const order = state.order.includes(action.chat.id) ? state.order : [action.chat.id, ...state.order]
      return {
        ...state,
        chats: { ...state.chats, [action.chat.id]: adopted },
        order: reorder(order, action.chat.id),
        inFlight: {
          ...state.inFlight,
          [action.chat.id]: { assistantMessageId: action.assistantMessageId, userMessageId, agentStatus: 'thinking' },
        },
      }
    }
    case 'patchContextPanelOpen': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const updated: Chat = { ...chat, contextPanelOpen: action.open ?? undefined }
      return { ...state, chats: { ...state.chats, [chat.id]: updated } }
    }
    case 'patchPullRequest': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, pullRequest: action.pullRequest } },
      }
    }
    case 'patchSoloAdvisor': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const updated: Chat = { ...chat, soloAdvisor: action.enabled ? true : undefined }
      return { ...state, chats: { ...state.chats, [chat.id]: updated } }
    }
    case 'patchChecklist': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      // The agent restates its whole list on every revision, so replace rather
      // than merge. updatedAt is left alone: the chat list orders by real
      // conversation activity, and a plan revision is not a new message.
      const updated: Chat = action.items.length ? { ...chat, checklist: action.items } : { ...chat }
      if (!action.items.length) delete updated.checklist
      return { ...state, chats: { ...state.chats, [chat.id]: updated } }
    }
    case 'patchTaskBrief': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const updated: Chat = { ...chat, taskBrief: action.brief }
      return { ...state, chats: { ...state.chats, [chat.id]: updated } }
    }
    case 'permissionRequest': {
      return { ...state, pendingPermissions: { ...state.pendingPermissions, [action.chatId]: action.toolNames } }
    }
    case 'dismissPermission': {
      const pp = { ...state.pendingPermissions }
      delete pp[action.chatId]
      return { ...state, pendingPermissions: pp }
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
    case 'select': {
      const unreadChats = { ...state.unreadChats }
      if (action.chatId) delete unreadChats[action.chatId]
      return { ...state, selectedChatId: action.chatId, unreadChats }
    }
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
        // Provisional identity so the header exists while the reply streams
        // instead of appearing only once `done` lands. The caller passes the
        // resolved agent/model (per-chat → worker → gateway default); the
        // chat's own overrides are the fallback for senders without that
        // context. `completeSend` overwrites both with what actually ran.
        agent: action.agent ?? chat.agent,
        model: action.model ?? chat.model,
      }
      const updated: Chat = {
        ...chat,
        messages: [...chat.messages, action.userMessage, assistantStub],
        updatedAt: Date.now(),
      }
      // Last turn's task list describes last turn's task. Showing it against a
      // new prompt would report progress on work nobody asked for again.
      delete updated.checklist
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: updated },
        order: reorder(state.order, chat.id),
        inFlight: {
          ...state.inFlight,
          [chat.id]: {
            assistantMessageId: action.assistantMessageId,
            userMessageId: action.userMessage.id,
            agentStatus: 'thinking',
          },
        },
      }
    }
    case 'thinkingToken': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const fl = state.inFlight[action.chatId]
      const targetId = action.messageId ?? fl?.assistantMessageId
      if (!targetId) return state
      const nextFl: InFlight | undefined = fl ? { ...fl, agentStatus: 'thinking' } : undefined
      if (nextFl) {
        if (action.step === undefined) {
          nextFl.thinking = (fl!.thinking ?? '') + action.token
        } else {
          nextFl.thinkingByStep = { ...(fl!.thinkingByStep ?? {}), [action.step]: (fl!.thinkingByStep?.[action.step] ?? '') + action.token }
        }
      }
      const messages = chat.messages.map(m =>
        m.id === targetId
          ? { ...m, thinking: nextFl?.thinking ?? m.thinking, thinkingByStep: nextFl?.thinkingByStep ?? m.thinkingByStep }
          : m
      )
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } },
        ...(nextFl ? { inFlight: { ...state.inFlight, [chat.id]: nextFl } } : {}),
      }
    }
    case 'streamToken': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const fl = state.inFlight[action.chatId]
      const targetId = action.messageId ?? fl?.assistantMessageId
      if (!targetId) return state
      const messages = chat.messages.map(m =>
        m.id === targetId ? { ...m, content: m.content + action.token } : m
      )
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } },
        ...(fl ? { inFlight: { ...state.inFlight, [chat.id]: { ...fl, agentStatus: 'writing' } } } : {}),
      }
    }
    case 'toolCall': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const fl = state.inFlight[action.chatId]
      const targetId = action.messageId ?? fl?.assistantMessageId
      if (!targetId) return state
      const messages = chat.messages.map(m =>
        m.id === targetId
          ? { ...m, toolCalls: [...(m.toolCalls ?? []), action.entry] }
          : m
      )
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } },
        ...(fl ? { inFlight: { ...state.inFlight, [chat.id]: { ...fl, agentStatus: action.status } } } : {}),
      }
    }
    case 'teamStart': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const stubs = (action.workers ?? []).map(w => mkWorkerStub(action.teamTurnId, action.teamName, action.mode, w.messageId, w.step, w.worker, undefined, w.agent, w.model))
      const existing = new Set(chat.messages.map(m => m.id))
      // A normal send starts with a generic assistant placeholder. Once the
      // gateway identifies the turn as a team run, the worker messages replace
      // that placeholder; leaving it behind creates the empty bubble above the
      // team group (and later a duplicate combined transcript).
      const placeholderId = state.inFlight[action.chatId]?.assistantMessageId
      const messages = [
        ...chat.messages.filter(m => m.id !== placeholderId),
        ...stubs.filter(s => !existing.has(s.id)),
      ]
      return { ...state, chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } } }
    }
    case 'workerStart': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      if (chat.messages.some(m => m.id === action.messageId)) return state
      const teamName = chat.messages.find(m => m.teamTurnId === action.teamTurnId)?.teamName ?? (chat.selection.type === 'team' ? chat.selection.name ?? '' : '')
      const mode = chat.messages.find(m => m.teamTurnId === action.teamTurnId)?.teamMode ?? 'auto'
      const stub = mkWorkerStub(action.teamTurnId, teamName, mode, action.messageId, action.step, action.worker, action.reason, action.agent, action.model)
      const placeholderId = state.inFlight[action.chatId]?.assistantMessageId
      const messages = [...chat.messages.filter(m => m.id !== placeholderId), stub]
      return { ...state, chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } } }
    }
    case 'workerEnd': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const messages = chat.messages.map(m => m.id === action.messageId ? { ...m, workerStatus: action.status, isComplete: action.status !== 'running' } : m)
      return { ...state, chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } } }
    }
    case 'teamEnd': {
      const chat = state.chats[action.chatId]
      if (!chat) return state
      const target = [...chat.messages].reverse().find(message => message.teamTurnId === action.teamTurnId)
      if (!target) return state
      const messages = chat.messages.map(message => message.id === target.id ? { ...message, teamSummary: action.summary } : message)
      return { ...state, chats: { ...state.chats, [chat.id]: { ...chat, messages, ...(action.taskBrief ? { taskBrief: action.taskBrief } : {}), updatedAt: Date.now() } } }
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
      let messages: ChatMessage[]
      if (action.teamTurnId) {
        const teamMessages = chat.messages.filter(m => m.teamTurnId === action.teamTurnId)
        const firstWorker = teamMessages.find(m => m.worker)
        messages = chat.messages.filter(m => m.id !== action.assistantMessageId)
        // Keep the team wrap-up/whiteboard as group metadata rather than a
        // standalone assistant bubble. An empty response needs no footer.
        if (action.content.trim()) {
          messages = [...messages, {
            id: action.assistantMessageId,
            role: 'assistant',
            content: action.content,
            timestamp: Date.now(),
            toolCalls: [],
            isComplete: true,
            tokens: action.tokens,
            durationSec: action.durationSec,
            agent: action.agent,
            model: action.model,
            choices: action.choices,
            userQuestion: action.userQuestion,
            fallback: action.fallback,
            teamTurnId: action.teamTurnId,
            teamName: firstWorker?.teamName,
            teamMode: firstWorker?.teamMode,
          }]
        }
      } else {
        messages = chat.messages.map(m =>
          m.id === action.assistantMessageId
            // `?? m.thinking` rather than a plain assignment: thinking that
            // already streamed in through thinkingToken must not be wiped by a
            // done event that carries none.
            ? { ...m, content: action.content, thinking: action.thinking ?? m.thinking, tokens: action.tokens, durationSec: action.durationSec, agent: action.agent, model: action.model, isComplete: true, choices: action.choices, userQuestion: action.userQuestion, fallback: action.fallback }
            : m
        )
      }
      const updatedChat: Chat = { ...chat, messages, updatedAt: Date.now() }
      if (action.title) updatedChat.title = action.title
      const inFlight = { ...state.inFlight }
      delete inFlight[action.chatId]
      const unreadChats = state.selectedChatId !== action.chatId
        ? { ...state.unreadChats, [action.chatId]: true as const }
        : state.unreadChats
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: updatedChat },
        order: reorder(state.order, chat.id),
        inFlight,
        unreadChats,
      }
    }
    case 'stoppedSend': {
      const chat = state.chats[action.chatId]
      const fl = state.inFlight[action.chatId]
      if (!chat || !fl) return state
      // Drop both the user prompt and the assistant placeholder for this turn.
      // The prompt text is stashed in pendingRestores so ChatTab can lift it
      // back into the input box.
      const messages = chat.messages.filter(m =>
        m.id !== fl.userMessageId && m.id !== fl.assistantMessageId
      )
      const inFlight = { ...state.inFlight }
      delete inFlight[action.chatId]
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } },
        inFlight,
        pendingRestores: { ...state.pendingRestores, [action.chatId]: action.text },
      }
    }
    case 'clearRestore': {
      if (!(action.chatId in state.pendingRestores)) return state
      const pendingRestores = { ...state.pendingRestores }
      delete pendingRestores[action.chatId]
      return { ...state, pendingRestores }
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
      const unreadChats = { ...state.unreadChats }
      if (state.selectedChatId !== action.chatId) unreadChats[action.chatId] = true
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } },
        inFlight,
        unreadChats,
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
  /** Fetch a chat by id (works for hidden automation chats) and select it. */
  openChatById: (chatId: string) => Promise<void>
  renameChat: (chatId: string, title: string) => Promise<void>
  deleteChat: (chatId: string) => Promise<void>
  setSelection: (chatId: string, selection: ChatSelection) => Promise<void>
  setAgentModel: (chatId: string, agent: string | null, model: string | null) => Promise<void>
  setEffort: (chatId: string, effort: string | null) => Promise<void>
  setWorkingDir: (chatId: string, dir: string | null) => Promise<void>
  setExecutionMode: (chatId: string, mode: 'shared-checkout' | 'isolated-worktree') => Promise<Chat>
  createWorktree: (chatId: string, name: string, existingBranch?: string) => Promise<Chat>
  setPullRequest: (chatId: string, pullRequest: NonNullable<Chat['pullRequest']>) => Promise<void>
  setContextPanelOpen: (chatId: string, open: boolean | null) => Promise<void>
  setSoloAdvisor: (chatId: string, enabled: boolean) => Promise<void>
  generateTaskBrief: (chatId: string) => Promise<TaskBrief | null>
  linkChannel: (chatId: string, channel: 'telegram' | 'discord' | 'imessage', channelUserId: string) => Promise<void>
  unlinkChannel: (chatId: string, channel: 'telegram' | 'discord' | 'imessage', channelUserId: string) => Promise<void>
  /** `identity` is the agent/model the caller resolved for this chat; it seeds
   *  the turn header while the reply streams. Omit it and the chat's own
   *  overrides are used instead. */
  sendMessage: (chatId: string, text: string, attachments?: FileAttachment[], identity?: { agent?: ChatMessage['agent']; model?: string }) => Promise<void>
  stopChat: (chatId: string) => Promise<void>
  resolvePermission: (chatId: string, allow: boolean) => Promise<void>
  clearRestore: (chatId: string) => void
  toggleWorkspace: (workspaceName: string) => void
  refreshWorkspaces: () => Promise<void>
  refreshChats: () => Promise<void>
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
    pendingRestores: {},
    unreadChats: {},
    pendingPermissions: {},
  })

  const pendingAssistantId = useRef<Record<string, string>>({})
  const resolvingPermissions = useRef<Set<string>>(new Set())
  // Chats whose externally-initiated turn we are mid-adopting (chats.get in
  // flight). Prevents duplicate fetches and lets a fast terminal event cancel
  // a pending adoption (see onEvent).
  const adopting = useRef<Set<string>>(new Set())

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
      // Adopt turns started outside the renderer (quick-capture, paired
      // channels). Such chats have no local inFlight entry, so every live event
      // below would be dropped until 'done'. On the first live event, fetch the
      // chat (its user message is already persisted) and open an inFlight entry
      // so streaming/tool events render and the "working" indicator shows.
      if (shouldAdoptExternalTurn(
        ev,
        !!pendingAssistantId.current[ev.chatId],
        adopting.current.has(ev.chatId),
      )) {
        adopting.current.add(ev.chatId)
        apiService.chats.get(ev.chatId)
          .then(chat => {
            // A terminal event may have won the race and cancelled adoption.
            if (!adopting.current.has(ev.chatId)) return
            const assistantMessageId = `asst-${Date.now()}-${Math.random()}`
            pendingAssistantId.current[ev.chatId] = assistantMessageId
            dispatch({ type: 'adoptInFlight', chat, assistantMessageId })
          })
          .catch(() => { adopting.current.delete(ev.chatId) })
      }

      switch (ev.type) {
        case 'queued':
          dispatch({ type: 'queued', chatId: ev.chatId, position: ev.position })
          break
        case 'tool_start':
          dispatch({
            type: 'toolCall',
            chatId: ev.chatId,
            entry: { id: `tc-${Date.now()}-${Math.random()}`, type: 'tool_start', tool: ev.tool, message: ev.message, input: ev.input },
            status: activityForTool(ev.tool),
            messageId: ev.messageId,
          })
          break
        case 'tool_end':
          dispatch({
            type: 'toolCall',
            chatId: ev.chatId,
            entry: { id: `tc-${Date.now()}-${Math.random()}`, type: 'tool_end', tool: ev.tool, message: ev.message, output: ev.output },
            // Hold the tool's own activity rather than snapping back to
            // "Working": the label would flicker between every paired event.
            status: activityForTool(ev.tool),
            messageId: ev.messageId,
          })
          break
        case 'checklist':
          // State, not a tool row: it never enters the message transcript.
          dispatch({ type: 'patchChecklist', chatId: ev.chatId, items: ev.items })
          break
        case 'info':
          if (ev.skillNotice) {
            // The post-run pass mutates/persists the completed assistant's
            // toolCalls before emitting this notice. Refresh that completed
            // message; never manufacture a new in-flight assistant turn.
            apiService.chats.get(ev.chatId)
              .then(chat => dispatch({ type: 'upsert', chat }))
              .catch(() => {})
          } else {
            dispatch({
              type: 'toolCall',
              chatId: ev.chatId,
              entry: { id: `tc-${Date.now()}-${Math.random()}`, type: 'info', message: ev.message },
              status: 'working',
            })
          }
          break
        case 'stream':
          dispatch({ type: 'streamToken', chatId: ev.chatId, token: ev.token, messageId: ev.messageId })
          break
        case 'thinking':
          dispatch({ type: 'thinkingToken', chatId: ev.chatId, token: ev.token, step: ev.step, messageId: ev.messageId })
          break
        case 'team_start':
          dispatch({ type: 'teamStart', chatId: ev.chatId, teamTurnId: ev.teamTurnId, teamName: ev.teamName, mode: ev.mode, workers: ev.workers })
          break
        case 'worker_start':
          dispatch({ type: 'workerStart', chatId: ev.chatId, teamTurnId: ev.teamTurnId, messageId: ev.messageId, step: ev.step, worker: ev.worker, agent: ev.agent, model: ev.model, reason: ev.reason })
          break
        case 'worker_end':
          dispatch({ type: 'workerEnd', chatId: ev.chatId, messageId: ev.messageId, step: ev.step, status: ev.status })
          break
        case 'team_end':
          dispatch({ type: 'teamEnd', chatId: ev.chatId, teamTurnId: ev.teamTurnId, summary: ev.summary, taskBrief: ev.taskBrief })
          break
        case 'workspace_ready':
          apiService.chats.get(ev.chatId)
            .then(chat => dispatch({ type: 'upsert', chat }))
            .catch(() => {})
          break
        case 'done': {
          adopting.current.delete(ev.chatId)
          const asstId = pendingAssistantId.current[ev.chatId]
          if (asstId) {
            dispatch({
              type: 'completeSend',
              chatId: ev.chatId,
              assistantMessageId: asstId,
              content: ev.response,
              // The agent may report thinking only at the end rather than
              // streaming it (claude-code does exactly that when the deltas
              // arrive as whole assistant blocks). Without this the renderer
              // has no thinking for those turns even though the gateway
              // persisted it, so the disclosure never appears until refetch.
              thinking: ev.thinking,
              tokens: ev.tokens,
              durationSec: ev.durationSec,
              agent: ev.agent,
              model: ev.model,
              title: ev.title,
              choices: ev.choices,
              userQuestion: ev.userQuestion,
              fallback: ev.fallback,
              teamTurnId: ev.teamTurnId,
            })
            delete pendingAssistantId.current[ev.chatId]
          } else {
            // Channel-driven turn (no Mac-side placeholder). Re-fetch the chat
            // so the new user + assistant messages show up in the sidebar/view.
            apiService.chats.get(ev.chatId)
              .then(chat => dispatch({ type: 'upsert', chat }))
              .catch(() => {})
          }
          break
        }
        case 'stopped': {
          adopting.current.delete(ev.chatId)
          dispatch({ type: 'stoppedSend', chatId: ev.chatId, text: ev.text })
          delete pendingAssistantId.current[ev.chatId]
          break
        }
        case 'error': {
          adopting.current.delete(ev.chatId)
          const asstId = pendingAssistantId.current[ev.chatId]
          if (asstId) {
            dispatch({ type: 'errorSend', chatId: ev.chatId, assistantMessageId: asstId, error: ev.message })
            delete pendingAssistantId.current[ev.chatId]
          } else {
            apiService.chats.get(ev.chatId)
              .then(chat => dispatch({ type: 'upsert', chat }))
              .catch(() => {})
          }
          break
        }
        case 'permission_denials': {
          const toolNames = [...new Set(ev.denials.map(d => d.toolName))]
          dispatch({ type: 'permissionRequest', chatId: ev.chatId, toolNames })
          break
        }
      }
    })
    return off
  }, [])

  useEffect(() => {
    const off = window.codey.notify.onOpenChat(({ chatId }) => {
      dispatch({ type: 'select', chatId })
    })
    return off
  }, [])

  const sendMessage = useCallback(async (
    chatId: string,
    text: string,
    attachments?: FileAttachment[],
    identity?: { agent?: ChatMessage['agent']; model?: string },
  ) => {
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
    dispatch({ type: 'startSend', chatId, userMessage, assistantMessageId, agent: identity?.agent, model: identity?.model })
    try {
      await apiService.chats.send(chatId, text, attachments)
    } catch (err) {
      dispatch({ type: 'errorSend', chatId, assistantMessageId, error: `Error: ${(err as Error).message}` })
      delete pendingAssistantId.current[chatId]
    }
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
    async openChatById(chatId) {
      // Automation chats are excluded from chats.list(), so fetch directly
      // and upsert before selecting — selection needs the chat in state.
      const chat = await apiService.chats.get(chatId)
      dispatch({ type: 'upsert', chat })
      dispatch({ type: 'select', chatId })
    },
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
    async setAgentModel(chatId, agent, model) {
      const chat = await apiService.chats.updateAgentModel(chatId, agent, model)
      dispatch({ type: 'upsert', chat })
    },
    async setEffort(chatId, effort) {
      const chat = await apiService.chats.updateEffort(chatId, effort)
      dispatch({ type: 'upsert', chat })
    },
    async setWorkingDir(chatId, dir) {
      // Mirrors setSelection: the gateway returns the updated chat (with the
      // new workingDirOverride), which we upsert so the header's BranchPicker
      // bound chip reflects the binding immediately.
      const chat = await apiService.chats.setWorkingDir(chatId, dir)
      dispatch({ type: 'upsert', chat })
    },
    async setExecutionMode(chatId, mode) {
      const chat = await apiService.chats.setExecutionMode(chatId, mode)
      dispatch({ type: 'upsert', chat })
      return chat
    },
    async createWorktree(chatId, name, existingBranch) {
      const chat = await apiService.chats.createWorktree(chatId, name, existingBranch)
      dispatch({ type: 'upsert', chat })
      return chat
    },
    async setPullRequest(chatId, pullRequest) {
      dispatch({ type: 'patchPullRequest', chatId, pullRequest })
      try { await apiService.chats.setPullRequest(chatId, pullRequest) } catch { /* refresh is best effort */ }
    },
    async setContextPanelOpen(chatId, open) {
      // Optimistically patch the local state so we don't replace the chat
      // (which would clobber an in-flight streaming assistant message).
      // The server-side write happens in the background.
      dispatch({ type: 'patchContextPanelOpen', chatId, open })
      try { await apiService.chats.updateContextPanelOpen(chatId, open) } catch { /* swallow */ }
    },
    async setSoloAdvisor(chatId, enabled) {
      // Optimistically patch local state (same rationale as setContextPanelOpen):
      // avoid replacing the chat object and clobbering an in-flight streaming
      // assistant message. The server-side write happens in the background.
      dispatch({ type: 'patchSoloAdvisor', chatId, enabled })
      try { await apiService.chats.setSoloAdvisor(chatId, enabled) } catch { /* swallow */ }
    },
    async generateTaskBrief(chatId) {
      const brief = await apiService.chats.taskBrief(chatId)
      if (brief) dispatch({ type: 'patchTaskBrief', chatId, brief })
      return brief
    },
    async linkChannel(chatId, channel, channelUserId) {
      await apiService.linkChat(chatId, channel, channelUserId)
      // Re-pull all chats: addRoute on the gateway is exclusive and strips
      // the route from any previously-linked chat, so a single upsert would
      // leave stale link icons on the displaced chat.
      const chats = await apiService.chats.list()
      dispatch({ type: 'loaded', chats })
    },
    async unlinkChannel(chatId, channel, channelUserId) {
      const chat = await apiService.unlinkChat(chatId, channel, channelUserId)
      dispatch({ type: 'upsert', chat })
    },
    sendMessage,
    async stopChat(chatId) {
      try { await apiService.chats.stop(chatId) } catch { /* nothing in flight */ }
    },
    async resolvePermission(chatId, allow) {
      if (!allow) {
        dispatch({ type: 'dismissPermission', chatId })
        return
      }
      const toolNames = state.pendingPermissions[chatId]
      if (!toolNames?.length) return
      if (resolvingPermissions.current.has(chatId)) return
      resolvingPermissions.current.add(chatId)
      try {
        const result = await window.codey.permissions.addAllowed(toolNames, chatId)
        if (!result.ok) throw new Error(result.error)
        dispatch({ type: 'dismissPermission', chatId })
        // Claude Code has already ended the denied turn. Resume its warm session
        // with an explicit continuation after the allow-list write completes.
        await sendMessage(chatId, 'Continue the previous task now that the requested permissions have been granted.')
      } finally {
        resolvingPermissions.current.delete(chatId)
      }
    },
    clearRestore(chatId) { dispatch({ type: 'clearRestore', chatId }) },
    toggleWorkspace(workspaceName) { dispatch({ type: 'toggleWorkspace', workspaceName }) },
    async refreshWorkspaces() {
      const workspaces = await apiService.getWorkspaces()
      dispatch({ type: 'setWorkspaces', workspaces })
    },
    // Re-fetch the chat list from the gateway. Used after a workspace is deleted
    // (which also deletes its chats) so the sidebar groups, which are derived
    // from state.chats, drop the removed workspace instead of waiting for a
    // full app reload.
    async refreshChats() {
      const chats = await apiService.chats.list()
      dispatch({ type: 'loaded', chats })
    },
  }), [state, sendMessage])

  return <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>
}

export function useChats(): ChatsContextValue {
  const ctx = useContext(ChatsContext)
  if (!ctx) throw new Error('useChats must be used inside <ChatsProvider>')
  return ctx
}
