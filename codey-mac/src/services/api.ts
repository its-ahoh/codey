// IPC proxy — all calls go through window.codey.* (Electron preload)

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

  // Teams
  getTeams: async (_workspace?: string): Promise<Record<string, string[]>> =>
    unwrap(await window.codey.teams.get()),

  setTeams: async (_workspace: string, teams: Record<string, string[]>): Promise<void> =>
    unwrap(await window.codey.teams.set(teams)),

  // Chat — gateway is in-process; streaming comes via chat:token IPC events
  sendMessage: async (
    text: string,
    _onStatus?: (update: { type: string; tool?: string; message: string; input?: Record<string, unknown>; output?: string }) => void,
    _onStream?: (token: string) => void,
    conversationId?: string,
  ): Promise<{ response: string; conversationId?: string }> => {
    await unwrap(await window.codey.chat.send({
      conversationId: conversationId ?? 'default',
      text,
    }))
    return { response: '', conversationId }
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
}
