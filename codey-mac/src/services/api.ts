// IPC proxy — all calls go through window.codey.* (Electron preload)

import type { Chat, ChatSelection } from '../types'

// Inline ChatStreamEvent to avoid cross-package import
export type ChatStreamEvent =
  | { type: 'queued'; chatId: string; position: number }
  | { type: 'tool_start'; chatId: string; tool?: string; message: string; input?: Record<string, unknown> }
  | { type: 'tool_end'; chatId: string; tool?: string; message: string; output?: string }
  | { type: 'info'; chatId: string; message: string }
  | { type: 'stream'; chatId: string; token: string }
  | { type: 'done'; chatId: string; response: string; tokens?: number; durationSec?: number }
  | { type: 'error'; chatId: string; message: string };

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (result.ok) return result.data
  throw new Error(result.error)
}

// Type aliases for the shapes returned by core
export interface WorkerPersonality { role: string; soul: string; instructions: string }
export interface WorkerConfig { codingAgent: 'claude-code' | 'opencode' | 'codex'; model: string; tools: string[] }
export interface WorkerDto {
  name: string
  personality: WorkerPersonality
  config: WorkerConfig
}

export interface GatewayStatus {
  status: 'healthy' | 'degraded' | 'stopped' | 'starting'
  uptime: number
  messagesProcessed: number
  errors: number
  channels: { telegram: boolean; discord: boolean; imessage: boolean }
}

export const apiService = {
  // Workers
  listWorkers: async (): Promise<WorkerDto[]> =>
    unwrap(await window.codey.workers.list()),

  getWorker: async (name: string): Promise<WorkerDto> =>
    unwrap(await window.codey.workers.get(name)),

  updateWorker: async (name: string, body: { personality: WorkerPersonality; config: WorkerConfig }): Promise<void> =>
    unwrap(await window.codey.workers.save(name, body.personality, body.config)),

  deleteWorker: async (name: string): Promise<void> =>
    unwrap(await window.codey.workers.delete(name)),

  generateWorker: async (prompt: string): Promise<WorkerDto> =>
    unwrap(await window.codey.workers.generate(prompt)),

  // Workspaces
  getWorkspaces: async (): Promise<string[]> =>
    unwrap(await window.codey.workspaces.list()),

  getCurrentWorkspace: async (): Promise<string> =>
    unwrap(await window.codey.workspaces.current()),

  switchWorkspace: async (name: string): Promise<void> =>
    unwrap(await window.codey.workspaces.switch(name)),

  getWorkspaceInfo: async (name: string): Promise<{ workingDir: string }> =>
    unwrap(await window.codey.workspaces.info(name)),

  getWorkspaceMemory: async (name: string): Promise<string> =>
    unwrap(await window.codey.workspaces.getMemory(name)),

  setWorkspaceMemory: async (name: string, content: string): Promise<void> =>
    unwrap(await window.codey.workspaces.setMemory(name, content)),

  createWorkspaceFromDir: async (dir: string): Promise<string> =>
    unwrap(await window.codey.workspaces.create(dir)),

  deleteWorkspace: async (name: string): Promise<void> =>
    unwrap(await window.codey.workspaces.delete(name)),

  pickDirectory: async (): Promise<string | null> =>
    unwrap(await window.codey.dialog.pickDirectory()),

  // Teams
  getTeams: async (workspace?: string): Promise<Record<string, string[]>> =>
    unwrap(await window.codey.teams.get(workspace)),

  setTeams: async (workspace: string, teams: Record<string, string[]>): Promise<void> =>
    unwrap(await window.codey.teams.set(workspace, teams)),

  // Chat — gateway is in-process; streaming comes via chat:token IPC events
  sendMessage: async (
    text: string,
    onStatus?: (update: { type: string; tool?: string; message: string; input?: Record<string, unknown>; output?: string }) => void,
    onStream?: (token: string) => void,
    conversationId?: string,
  ): Promise<{ response: string; conversationId?: string; tokens?: number; durationSec?: number }> => {
    const convId = conversationId ?? 'default'
    const offToken = onStream
      ? window.codey.chat.onToken(msg => {
          if (msg.conversationId === convId) onStream(msg.token)
        })
      : () => {}
    const offStatus = onStatus
      ? window.codey.chat.onStatus(msg => {
          if (msg.conversationId === convId) {
            try { onStatus(JSON.parse(msg.update)) } catch { /* non-JSON status */ }
          }
        })
      : () => {}
    try {
      const result = await unwrap(await window.codey.chat.send({ conversationId: convId, text }))
      return {
        response: result.response,
        conversationId: result.conversationId,
        tokens: result.tokens,
        durationSec: result.durationSec,
      }
    } finally {
      offToken()
      offStatus()
    }
  },

  // Config
  getConfig: async (): Promise<any> =>
    unwrap(await window.codey.config.get()),

  setConfig: async (updates: any): Promise<void> =>
    unwrap(await window.codey.config.set(updates)),

  // Status — gateway is always in-process; return a mock healthy status
  getStatus: async (): Promise<GatewayStatus> => ({
    status: 'healthy',
    uptime: 0,
    messagesProcessed: 0,
    errors: 0,
    channels: { telegram: false, discord: false, imessage: false },
  }),

  chats: {
    list: async (workspaceName?: string): Promise<Chat[]> =>
      unwrap(await window.codey.chats.list(workspaceName)),
    get: async (id: string): Promise<Chat> =>
      unwrap(await window.codey.chats.get(id)),
    create: async (input: { workspaceName: string; selection?: ChatSelection; title?: string }): Promise<Chat> =>
      unwrap(await window.codey.chats.create(input)),
    rename: async (id: string, title: string): Promise<Chat> =>
      unwrap(await window.codey.chats.rename(id, title)),
    delete: async (id: string): Promise<void> => {
      unwrap(await window.codey.chats.delete(id))
    },
    updateSelection: async (id: string, selection: ChatSelection): Promise<Chat> =>
      unwrap(await window.codey.chats.updateSelection(id, selection)),
    send: async (chatId: string, text: string): Promise<{ response: string; chatId: string; tokens?: number; durationSec?: number }> =>
      unwrap(await window.codey.chats.send({ chatId, text })),
    stop: async (chatId: string): Promise<boolean> =>
      unwrap(await window.codey.chats.stop(chatId)),
    onEvent: (handler: (ev: ChatStreamEvent) => void): (() => void) =>
      window.codey.chats.onEvent(handler),
  },
}
