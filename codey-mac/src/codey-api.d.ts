import type { Chat, ChatSelection } from '../../packages/core/src/types/chat'
import type { ChatStreamEvent } from '../../packages/gateway/src/chat-runner'
import type { TeamConfigRaw } from '../../packages/core/src/workspace'

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface ModelEntry {
  apiType: 'anthropic' | 'openai'
  model: string
  baseUrl?: string
  apiKey?: string
  provider?: string
}

declare global {
  interface Window {
    codey: {
      workers: {
        list: () => Promise<IpcResult<any[]>>
        get: (name: string) => Promise<IpcResult<any>>
        save: (name: string, personality: any, config: any) => Promise<IpcResult<void>>
        delete: (name: string) => Promise<IpcResult<void>>
        generate: (prompt: string) => Promise<IpcResult<any>>
      }
      workspaces: {
        list: () => Promise<IpcResult<string[]>>
        current: () => Promise<IpcResult<string>>
        switch: (name: string) => Promise<IpcResult<void>>
        info: (name: string) => Promise<IpcResult<{ workingDir: string }>>
        getMemory: (name: string) => Promise<IpcResult<string>>
        setMemory: (name: string, content: string) => Promise<IpcResult<void>>
        create: (dir: string) => Promise<IpcResult<string>>
        delete: (name: string) => Promise<IpcResult<void>>
      }
      dialog: {
        pickDirectory: () => Promise<IpcResult<string | null>>
      }
      teams: {
        get: (name?: string) => Promise<IpcResult<string[]>>
        set: (name: string, names: string[]) => Promise<IpcResult<void>>
      }
      globalTeams: {
        get: () => Promise<IpcResult<Record<string, TeamConfigRaw>>>
        set: (teams: Record<string, TeamConfigRaw>) => Promise<IpcResult<void>>
      }
      conversations: {
        list: () => Promise<IpcResult<string[]>>
      }
      chat: {
        send: (payload: { conversationId: string; text: string; sender?: string }) => Promise<IpcResult<{ response: string; conversationId: string; tokens?: number; durationSec?: number }>>
        onToken: (handler: (msg: { conversationId: string; token: string }) => void) => () => void
        onDone: (handler: (msg: { conversationId: string; response: string; tokens?: number; durationSec?: number }) => void) => () => void
        onStatus: (handler: (msg: { conversationId: string; update: string }) => void) => () => void
      }
      config: {
        get: () => Promise<IpcResult<any>>
        set: (updates: any) => Promise<IpcResult<void>>
      }
      models: {
        list: () => Promise<IpcResult<ModelEntry[]>>
        save: (entry: ModelEntry) => Promise<IpcResult<void>>
        delete: (name: string) => Promise<IpcResult<void>>
        rename: (oldName: string, newName: string) => Promise<IpcResult<void>>
      }
      fallback: {
        get: () => Promise<IpcResult<{ enabled: boolean; order: Array<{ agent: string; model?: string }> }>>
        set: (fb: { enabled: boolean; order: Array<{ agent: string; model?: string }> }) => Promise<IpcResult<void>>
      }
      dispatcher: {
        get: () => Promise<IpcResult<{ agent?: string; model?: string }>>
        set: (updates: { agent?: string; model?: string }) => Promise<IpcResult<void>>
      }
      agents: {
        get: () => Promise<IpcResult<Record<string, { enabled?: boolean; defaultModel?: string }>>>
        set: (updates: Record<string, { enabled?: boolean; defaultModel?: string }>) => Promise<IpcResult<void>>
        checkInstalled: () => Promise<IpcResult<Record<string, { installed: boolean; path?: string }>>>
      }
      chats: {
        upload: (chatId: string, fileName: string, mimeType: string, data: ArrayBuffer) =>
          Promise<IpcResult<{ id: string; name: string; path: string; mimeType: string; size: number }>>
        list: (workspaceName?: string) => Promise<IpcResult<Chat[]>>
        get: (id: string) => Promise<IpcResult<Chat>>
        create: (input: { workspaceName: string; selection?: ChatSelection; title?: string }) => Promise<IpcResult<Chat>>
        rename: (id: string, title: string) => Promise<IpcResult<Chat>>
        delete: (id: string) => Promise<IpcResult<null>>
        updateSelection: (id: string, selection: ChatSelection) => Promise<IpcResult<Chat>>
        updateAgentModel: (id: string, agent: string | null, model: string | null) => Promise<IpcResult<Chat>>
        send: (payload: { chatId: string; text: string; attachments?: Array<{ id: string; name: string; path: string; mimeType: string; size: number }> }) => Promise<IpcResult<{ response: string; chatId: string; tokens?: number; durationSec?: number }>>
        stop: (chatId: string) => Promise<IpcResult<boolean>>
        onEvent: (handler: (ev: ChatStreamEvent) => void) => () => void
        link: (chatId: string, channel: 'telegram' | 'discord' | 'imessage', channelUserId: string) => Promise<IpcResult<void>>
        unlink: (chatId: string, channel: 'telegram' | 'discord' | 'imessage', channelUserId: string) => Promise<IpcResult<void>>
        updateContextPanelOpen: (id: string, open: boolean | null) => Promise<IpcResult<Chat>>
      }
      pairing: {
        start: (channel: 'telegram' | 'discord' | 'imessage') => Promise<IpcResult<string>>
        list: () => Promise<IpcResult<Array<{
          channel: 'telegram' | 'discord' | 'imessage'
          channelUserId: string
          prefs?: { workspace?: string; agent?: string; model?: string }
          currentChatId?: string
          createdAt: number
        }>>>
      }
      gateway: {
        status: () => Promise<IpcResult<{
          status: 'healthy' | 'degraded'
          uptime: number
          channels: { telegram: boolean; discord: boolean; imessage: boolean }
          stats: { messagesProcessed: number; activeConversations: number; errors: number }
        } | null>>
      }
      openExternal: (url: string) => Promise<void>
      openPath: (path: string) => Promise<string>
      revealInFolder: (path: string) => Promise<boolean>
      onLog: (handler: (msg: string) => void) => () => void
    }
  }
}

export {}
