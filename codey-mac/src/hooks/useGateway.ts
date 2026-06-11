import { useEffect, useState } from 'react'
import type { CoreState } from '../../electron/core-state'

export interface GatewayStatus {
  status: 'healthy' | 'degraded' | 'stopped' | 'starting'
  uptime: number
  messagesProcessed: number
  errors: number
  channels: { telegram: boolean; discord: boolean; imessage: boolean }
}

const EMPTY_STATUS: GatewayStatus = {
  status: 'starting',
  uptime: 0,
  messagesProcessed: 0,
  errors: 0,
  channels: { telegram: false, discord: false, imessage: false },
}

export const useGateway = () => {
  const [logs, setLogs] = useState<string[]>(['Gateway running in-process'])
  const [status, setStatus] = useState<GatewayStatus>(EMPTY_STATUS)
  const [isRunning, setIsRunning] = useState(false)
  const [coreState, setCoreState] = useState<CoreState>({ phase: 'booting' })

  useEffect(() => {
    // The renderer subscribes after main has already emitted boot-time logs,
    // so backfill the ring buffer before subscribing to live updates.
    let cancelled = false
    window.codey.gateway.recentLogs().then(res => {
      if (cancelled) return
      if (res.ok && res.data && res.data.length > 0) {
        setLogs(prev => {
          const initial = prev.length === 1 && prev[0] === 'Gateway running in-process' ? [] : prev
          return [...initial, ...res.data!].slice(-100)
        })
      }
    }).catch(() => {})
    const off = window.codey.onLog(msg => {
      setLogs(prev => [...prev.slice(-99), msg])
    })
    return () => { cancelled = true; off() }
  }, [])

  useEffect(() => {
    // Same backfill-then-subscribe pattern: boot may have finished (or failed)
    // before this component mounted.
    let cancelled = false
    window.codey.core.state().then(res => {
      if (!cancelled && res.ok && res.data) setCoreState(res.data)
    }).catch(() => {})
    const off = window.codey.core.onState(s => setCoreState(s))
    return () => { cancelled = true; off() }
  }, [])

  useEffect(() => {
    let stopped = false
    const tick = async () => {
      try {
        const res = await window.codey.gateway.status()
        if (stopped) return
        if (res.ok && res.data) {
          const d = res.data
          setStatus({
            status: d.status,
            uptime: d.uptime,
            messagesProcessed: d.stats.messagesProcessed,
            errors: d.stats.errors,
            channels: d.channels,
          })
          setIsRunning(true)
        } else {
          setIsRunning(false)
        }
      } catch {
        if (!stopped) setIsRunning(false)
      }
    }
    tick()
    const id = setInterval(tick, 3000)
    return () => { stopped = true; clearInterval(id) }
  }, [])

  return {
    isRunning,
    status,
    logs,
    coreState,
    relaunchApp: () => { void window.codey.core.relaunch() },
  }
}
