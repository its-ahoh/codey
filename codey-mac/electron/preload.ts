import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  showWindow: () => ipcRenderer.invoke('show-window'),
  startGateway: () => ipcRenderer.invoke('start-gateway'),
  stopGateway: () => ipcRenderer.invoke('stop-gateway'),
  getGatewayPath: () => ipcRenderer.invoke('get-gateway-path'),
  setGatewayPath: (path: string) => ipcRenderer.invoke('set-gateway-path', path),
  onGatewayLog: (callback: (log: string) => void) => {
    const handler = (_: any, log: string) => callback(log)
    ipcRenderer.on('gateway-log', handler)
    return () => { ipcRenderer.removeListener('gateway-log', handler) }
  },
  onGatewayStatus: (callback: (status: { running: boolean }) => void) => {
    const handler = (_: any, status: { running: boolean }) => callback(status)
    ipcRenderer.on('gateway-status', handler)
    return () => { ipcRenderer.removeListener('gateway-status', handler) }
  },
  onGatewayToggle: (callback: (action: string) => void) => {
    const handler = (_: any, action: string) => callback(action)
    ipcRenderer.on('gateway-toggle', handler)
    return () => { ipcRenderer.removeListener('gateway-toggle', handler) }
  }
})
