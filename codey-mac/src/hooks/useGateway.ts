import { useEffect, useState } from 'react'

export interface GatewayStatus {
  status: 'healthy' | 'degraded' | 'stopped' | 'starting'
  uptime: number
  messagesProcessed: number
  errors: number
  channels: { telegram: boolean; discord: boolean; imessage: boolean }
}

export const useGateway = () => {
  const [logs, setLogs] = useState<string[]>(['Gateway running in-process'])

  useEffect(() => {
    const off = window.codey.onLog(msg => {
      setLogs(prev => [...prev.slice(-99), msg])
    })
    return off
  }, [])

  return {
    isRunning: true,
    status: {
      status: 'healthy' as const,
      uptime: 0,
      messagesProcessed: 0,
      errors: 0,
      channels: { telegram: false, discord: false, imessage: false },
    },
    logs,
    start: async () => {},
    stop: async () => {},
    toggle: () => {},
  }
}
