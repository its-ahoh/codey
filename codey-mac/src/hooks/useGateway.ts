import { useState, useCallback, useEffect, useRef } from 'react'
import { apiService } from '../services/api'
import { GatewayStatus } from '../types'

declare global {
  interface Window {
    electronAPI?: {
      getAppPath: () => Promise<string>
      showWindow: () => Promise<void>
      startGateway: () => Promise<void>
      stopGateway: () => Promise<void>
      getGatewayPath: () => Promise<string>
      setGatewayPath: (path: string) => Promise<void>
      onGatewayLog: (callback: (log: string) => void) => (() => void)
      onGatewayStatus: (callback: (status: { running: boolean }) => void) => (() => void)
      onGatewayToggle: (callback: (action: string) => void) => (() => void)
    }
  }
}

export const useGateway = () => {
  const [isRunning, setIsRunning] = useState(false)
  const [status, setStatus] = useState<GatewayStatus>({
    status: 'stopped',
    uptime: 0,
    messagesProcessed: 0,
    errors: 0,
    channels: { telegram: false, discord: false, imessage: false },
  })
  const [logs, setLogs] = useState<string[]>([])
  // Track whether main process has reported running state to avoid poll overriding it
  const ipcRunningRef = useRef<boolean | null>(null)

  const addLog = useCallback((line: string) => {
    const timestamp = new Date().toLocaleTimeString()
    setLogs(prev => [...prev.slice(-100), `${timestamp} ${line}`])
  }, [])

  const start = useCallback(async () => {
    try {
      const api = window.electronAPI
      if (api?.startGateway) {
        await api.startGateway()
      }
      ipcRunningRef.current = true
      setIsRunning(true)
      addLog('Gateway started')
    } catch (error) {
      addLog(`Failed to start: ${error}`)
    }
  }, [addLog])

  const stop = useCallback(async () => {
    try {
      const api = window.electronAPI
      if (api?.stopGateway) {
        await api.stopGateway()
      }
      ipcRunningRef.current = false
      setIsRunning(false)
      addLog('Gateway stopped')
    } catch (error) {
      addLog(`Failed to stop: ${error}`)
    }
  }, [addLog])

  const toggle = useCallback(() => {
    if (isRunning) {
      stop()
    } else {
      start()
    }
  }, [isRunning, start, stop])

  // Listen for gateway events from main process
  useEffect(() => {
    const api = window.electronAPI
    const cleanups: (() => void)[] = []

    if (api?.onGatewayLog) {
      const cleanup = api.onGatewayLog((log: string) => {
        addLog(log)
      })
      if (cleanup) cleanups.push(cleanup)
    }
    if (api?.onGatewayStatus) {
      const cleanup = api.onGatewayStatus((s: { running: boolean }) => {
        ipcRunningRef.current = s.running
        setIsRunning(s.running)
      })
      if (cleanup) cleanups.push(cleanup)
    }

    return () => { cleanups.forEach(fn => fn()) }
  }, [addLog])

  // Poll for status from the HTTP health endpoint
  useEffect(() => {
    const pollStatus = async () => {
      const newStatus = await apiService.getStatus()
      setStatus(newStatus)

      const isHealthy = newStatus.status === 'healthy' || newStatus.status === 'degraded'
      // Only update isRunning from poll if IPC hasn't recently set it
      // (avoids race where poll returns "stopped" while gateway is still starting)
      if (ipcRunningRef.current === null) {
        setIsRunning(isHealthy)
      }
    }

    pollStatus()
    const interval = setInterval(pollStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  return {
    isRunning,
    status,
    logs,
    start,
    stop,
    toggle,
  }
}
