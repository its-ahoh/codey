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
  },
  dialog: {
    pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  },
  teams: {
    get: (name?: string) => ipcRenderer.invoke('teams:get', name),
    set: (name: string, teams: Record<string, string[]>) =>
      ipcRenderer.invoke('teams:set', name, teams),
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
    onDone: (handler: (msg: { conversationId: string; response: string }) => void) => {
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
  fallback: {
    get: () => ipcRenderer.invoke('fallback:get'),
    set: (fb: any) => ipcRenderer.invoke('fallback:set', fb),
  },
  agents: {
    get: () => ipcRenderer.invoke('agents:get'),
    set: (updates: any) => ipcRenderer.invoke('agents:set', updates),
  },
  chats: {
    list: (workspaceName?: string) => ipcRenderer.invoke('chats:list', workspaceName),
    get: (id: string) => ipcRenderer.invoke('chats:get', id),
    create: (input: { workspaceName: string; selection?: any; title?: string }) =>
      ipcRenderer.invoke('chats:create', input),
    rename: (id: string, title: string) => ipcRenderer.invoke('chats:rename', id, title),
    delete: (id: string) => ipcRenderer.invoke('chats:delete', id),
    updateSelection: (id: string, selection: any) =>
      ipcRenderer.invoke('chats:updateSelection', id, selection),
    send: (payload: { chatId: string; text: string }) =>
      ipcRenderer.invoke('chats:send', payload),
    stop: (chatId: string) => ipcRenderer.invoke('chats:stop', chatId),
    onEvent: (handler: (ev: any) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: any) => handler(ev)
      ipcRenderer.on('chats:event', listener)
      return () => ipcRenderer.removeListener('chats:event', listener)
    },
  },
  gateway: {
    status: () => ipcRenderer.invoke('gateway:status'),
  },
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
  onLog: (handler: (msg: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, msg: string) => handler(msg)
    ipcRenderer.on('gateway-log', listener)
    return () => ipcRenderer.removeListener('gateway-log', listener)
  },
})
