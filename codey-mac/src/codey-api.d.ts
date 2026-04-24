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
      }
      teams: {
        get: () => Promise<IpcResult<Record<string, string[]>>>
        set: (teams: Record<string, string[]>) => Promise<IpcResult<void>>
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
      openExternal: (url: string) => Promise<void>
      onLog: (handler: (msg: string) => void) => () => void
    }
  }
}

export {}
