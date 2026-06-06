import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('codey', {
  workers: {
    list: () => ipcRenderer.invoke('workers:list'),
    get: (name: string) => ipcRenderer.invoke('workers:get', name),
    save: (name: string, personality: any, config: any) =>
      ipcRenderer.invoke('workers:save', name, personality, config),
    delete: (name: string) => ipcRenderer.invoke('workers:delete', name),
    generate: (prompt: string) => ipcRenderer.invoke('workers:generate', prompt),
  },
  workspaces: {
    list: () => ipcRenderer.invoke('workspaces:list'),
    current: () => ipcRenderer.invoke('workspaces:current'),
    switch: (name: string) => ipcRenderer.invoke('workspaces:switch', name),
    info: (name: string) => ipcRenderer.invoke('workspaces:info', name),
    getMemory: (name: string) => ipcRenderer.invoke('workspaces:memory:get', name),
    setMemory: (name: string, content: string) => ipcRenderer.invoke('workspaces:memory:set', name, content),
    create: (dir: string) => ipcRenderer.invoke('workspaces:create', dir),
    delete: (name: string) => ipcRenderer.invoke('workspaces:delete', name),
    rename: (oldName: string, newName: string) => ipcRenderer.invoke('workspaces:rename', oldName, newName),
    reveal: (name: string) => ipcRenderer.invoke('workspaces:reveal', name),
  },
  dialog: {
    pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  },
  teams: {
    get: (name?: string) => ipcRenderer.invoke('teams:get', name),
    set: (name: string, names: string[]) =>
      ipcRenderer.invoke('teams:set', name, names),
  },
  globalTeams: {
    get: () => ipcRenderer.invoke('globalTeams:get'),
    set: (teams: Record<string, unknown>) => ipcRenderer.invoke('globalTeams:set', teams),
  },
  conversations: {
    list: () => ipcRenderer.invoke('conversations:list'),
  },
  chat: {
    send: (payload: { conversationId: string; text: string; sender?: string }) =>
      ipcRenderer.invoke('chat:send', payload),
    onToken: (handler: (msg: { conversationId: string; token: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, msg: any) => handler(msg)
      ipcRenderer.on('chat:token', listener)
      return () => ipcRenderer.removeListener('chat:token', listener)
    },
    onDone: (handler: (msg: { conversationId: string; response: string; tokens?: number; durationSec?: number; choices?: string[] }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, msg: any) => handler(msg)
      ipcRenderer.on('chat:done', listener)
      return () => ipcRenderer.removeListener('chat:done', listener)
    },
    onStatus: (handler: (msg: { conversationId: string; update: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, msg: any) => handler(msg)
      ipcRenderer.on('chat:status', listener)
      return () => ipcRenderer.removeListener('chat:status', listener)
    },
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (updates: any) => ipcRenderer.invoke('config:set', updates),
  },
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    save: (entry: any) => ipcRenderer.invoke('models:save', entry),
    delete: (name: string) => ipcRenderer.invoke('models:delete', name),
    rename: (oldName: string, newName: string) => ipcRenderer.invoke('models:rename', oldName, newName),
  },
  apiKeys: {
    list: () => ipcRenderer.invoke('apiKeys:list'),
    save: (entry: any) => ipcRenderer.invoke('apiKeys:save', entry),
    delete: (name: string) => ipcRenderer.invoke('apiKeys:delete', name),
    rename: (oldName: string, newName: string) => ipcRenderer.invoke('apiKeys:rename', oldName, newName),
  },
  fallback: {
    get: () => ipcRenderer.invoke('fallback:get'),
    set: (fb: any) => ipcRenderer.invoke('fallback:set', fb),
  },
  dispatcher: {
    get: () => ipcRenderer.invoke('dispatcher:get'),
    set: (updates: { agent?: string; model?: string }) => ipcRenderer.invoke('dispatcher:set', updates),
  },
  aide: {
    get: () => ipcRenderer.invoke('aide:get'),
    set: (updates: { agent?: string; model?: string }) => ipcRenderer.invoke('aide:set', updates),
  },
  agents: {
    get: () => ipcRenderer.invoke('agents:get'),
    set: (updates: any) => ipcRenderer.invoke('agents:set', updates),
    checkInstalled: () => ipcRenderer.invoke('agents:checkInstalled'),
    slashCommands: (agent: string) => ipcRenderer.invoke('agents:slashCommands', agent),
  },
  chats: {
    upload: (chatId: string, fileName: string, mimeType: string, data: ArrayBuffer) =>
      ipcRenderer.invoke('chats:upload', chatId, fileName, mimeType, data),
    list: (workspaceName?: string) => ipcRenderer.invoke('chats:list', workspaceName),
    get: (id: string) => ipcRenderer.invoke('chats:get', id),
    create: (input: { workspaceName: string; selection?: any; title?: string }) =>
      ipcRenderer.invoke('chats:create', input),
    rename: (id: string, title: string) => ipcRenderer.invoke('chats:rename', id, title),
    taskBrief: (id: string) => ipcRenderer.invoke('chats:taskBrief', id),
    delete: (id: string) => ipcRenderer.invoke('chats:delete', id),
    updateSelection: (id: string, selection: any) =>
      ipcRenderer.invoke('chats:updateSelection', id, selection),
    updateAgentModel: (id: string, agent: string | null, model: string | null) =>
      ipcRenderer.invoke('chats:updateAgentModel', id, agent, model),
    link: (chatId: string, channel: 'telegram' | 'discord' | 'imessage', channelUserId: string) =>
      ipcRenderer.invoke('chats:link', chatId, channel, channelUserId),
    unlink: (chatId: string, channel: 'telegram' | 'discord' | 'imessage', channelUserId: string) =>
      ipcRenderer.invoke('chats:unlink', chatId, channel, channelUserId),
    updateContextPanelOpen: (id: string, open: boolean | null) =>
      ipcRenderer.invoke('chats:updateContextPanelOpen', id, open),
    send: (payload: { chatId: string; text: string; attachments?: any[] }) =>
      ipcRenderer.invoke('chats:send', payload),
    stop: (chatId: string) => ipcRenderer.invoke('chats:stop', chatId),
    onEvent: (handler: (ev: any) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: any) => handler(ev)
      ipcRenderer.on('chats:event', listener)
      return () => ipcRenderer.removeListener('chats:event', listener)
    },
  },
  qq: {
    ask: (payload: { chatId: string; question: string; history: Array<{ role: 'user' | 'assistant'; content: string }>; attachments?: Array<{ id: string; name: string; path: string; mimeType: string; size: number }> }) =>
      ipcRenderer.invoke('qq:ask', payload),
    stop: (chatId: string) => ipcRenderer.invoke('qq:stop', chatId),
    onEvent: (handler: (ev: any) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: any) => handler(ev)
      ipcRenderer.on('qq:event', listener)
      return () => ipcRenderer.removeListener('qq:event', listener)
    },
  },
  permissions: {
    addAllowed: (toolNames: string[], chatId?: string) => ipcRenderer.invoke('permissions:addAllowed', toolNames, chatId),
  },
  pairing: {
    start: (channel: 'telegram' | 'discord' | 'imessage') => ipcRenderer.invoke('pairing:start', channel),
    list: () => ipcRenderer.invoke('pairing:list'),
    onEvent: (handler: (ev: { type: 'completed'; channel: 'telegram' | 'discord' | 'imessage'; channelUserId: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: any) => handler(ev)
      ipcRenderer.on('pairing:event', listener)
      return () => ipcRenderer.removeListener('pairing:event', listener)
    },
  },
  gateway: {
    status: () => ipcRenderer.invoke('gateway:status'),
    recentLogs: () => ipcRenderer.invoke('gateway:recentLogs'),
  },
  voice: {
    onHotkey: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on('voice:hotkey', listener)
      return () => ipcRenderer.removeListener('voice:hotkey', listener)
    },
    notifyTranscribed: (text: string) => ipcRenderer.invoke('voice:transcribed', text),
    showError: (message: string) => ipcRenderer.invoke('voice:error', message),
    downloadModel: (model: string) => ipcRenderer.invoke('voice:downloadModel', model),
    deleteModel: (model: string) => ipcRenderer.invoke('voice:deleteModel', model),
    listDownloadedModels: () => ipcRenderer.invoke('voice:listDownloadedModels'),
    onDownloadProgress: (handler: (msg: { model: string; fraction: number }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, msg: any) => handler(msg)
      ipcRenderer.on('voice:downloadProgress', listener)
      return () => ipcRenderer.removeListener('voice:downloadProgress', listener)
    },
    warmModel: (model: string) => ipcRenderer.invoke('voice:warmModel', model),
    listWarmedModels: () => ipcRenderer.invoke('voice:listWarmedModels'),
    onWarmStart: (handler: (msg: { model: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, msg: any) => handler(msg)
      ipcRenderer.on('voice:warmStart', listener)
      return () => ipcRenderer.removeListener('voice:warmStart', listener)
    },
    onWarmDone: (handler: (msg: { model: string; loadSeconds: number }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, msg: any) => handler(msg)
      ipcRenderer.on('voice:warmDone', listener)
      return () => ipcRenderer.removeListener('voice:warmDone', listener)
    },
    onWarmError: (handler: (msg: { model: string; error: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, msg: any) => handler(msg)
      ipcRenderer.on('voice:warmError', listener)
      return () => ipcRenderer.removeListener('voice:warmError', listener)
    },
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    lastState: () => ipcRenderer.invoke('updater:lastState'),
    onState: (handler: (state: any) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, state: any) => handler(state)
      ipcRenderer.on('updater:state', listener)
      return () => ipcRenderer.removeListener('updater:state', listener)
    },
  },
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
  revealInFolder: (path: string) => ipcRenderer.invoke('shell:showItemInFolder', path),
  onLog: (handler: (msg: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, msg: string) => handler(msg)
    ipcRenderer.on('gateway-log', listener)
    return () => ipcRenderer.removeListener('gateway-log', listener)
  },
})
