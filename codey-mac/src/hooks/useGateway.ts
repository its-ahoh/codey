import { useState } from 'react'

export interface GatewayStatus {
  status: 'healthy' | 'degraded' | 'stopped' | 'starting'
  uptime: number
  messagesProcessed: number
  errors: number
  channels: { telegram: boolean; discord: boolean; imessage: boolean }
}

export const useGateway = () => {
  const [logs] = useState<string[]>(['Gateway running in-process'])

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
