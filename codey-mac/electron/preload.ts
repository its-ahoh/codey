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
  },
  teams: {
    get: () => ipcRenderer.invoke('teams:get'),
    set: (teams: Record<string, string[]>) => ipcRenderer.invoke('teams:set', teams),
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
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
})
