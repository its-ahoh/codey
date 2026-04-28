import type { Chat, ChatSelection } from '../../packages/core/src/types/chat'
import type { ChatStreamEvent } from '../../packages/gateway/src/chat-runner'

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
        get: (name?: string) => Promise<IpcResult<Record<string, string[]>>>
        set: (name: string, teams: Record<string, string[]>) => Promise<IpcResult<void>>
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
        get: () => Promise<IpcResult<{ enabled: boolean; order: string[] }>>
        set: (fb: { enabled: boolean; order: string[] }) => Promise<IpcResult<void>>
      }
      agents: {
        get: () => Promise<IpcResult<Record<string, { enabled?: boolean; defaultModel?: string }>>>
        set: (updates: Record<string, { enabled?: boolean; defaultModel?: string }>) => Promise<IpcResult<void>>
      }
      chats: {
        list: (workspaceName?: string) => Promise<IpcResult<Chat[]>>
        get: (id: string) => Promise<IpcResult<Chat>>
        create: (input: { workspaceName: string; selection?: ChatSelection; title?: string }) => Promise<IpcResult<Chat>>
        rename: (id: string, title: string) => Promise<IpcResult<Chat>>
        delete: (id: string) => Promise<IpcResult<null>>
        updateSelection: (id: string, selection: ChatSelection) => Promise<IpcResult<Chat>>
        send: (payload: { chatId: string; text: string }) => Promise<IpcResult<{ response: string; chatId: string; tokens?: number; durationSec?: number }>>
        onEvent: (handler: (ev: ChatStreamEvent) => void) => () => void
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
      onLog: (handler: (msg: string) => void) => () => void
    }
  }
}

export {}
