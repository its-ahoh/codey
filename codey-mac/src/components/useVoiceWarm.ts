import { useEffect, useState } from 'react'

/**
 * Whether the on-device model is mid-warm, and for how long.
 *
 * Both pushed and pulled: the startup warm begins before this window exists
 * and runs for minutes, so subscribing to the start event alone would miss the
 * common case and leave the composer's voice buttons enabled during the one
 * stretch where pressing them does nothing useful.
 */
export function useVoiceWarm(): { warming: boolean; model: string; elapsedSeconds: number } {
  const [state, setState] = useState<{ model: string; startedAt: number } | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    let cancelled = false
    void window.codey.voice.getWarmState()
      .then(res => { if (!cancelled && res.ok && res.data) setState(res.data) })
      .catch(() => { /* best-effort: worst case the buttons stay enabled */ })

    const offStart = window.codey.voice.onWarmStart(({ model }) => {
      setState({ model, startedAt: Date.now() })
    })
    const offDone = window.codey.voice.onWarmDone(() => setState(null))
    const offErr = window.codey.voice.onWarmError(() => setState(null))
    return () => { cancelled = true; offStart(); offDone(); offErr() }
  }, [])

  // Ticks once a second rather than on every render: the elapsed number is the
  // only moving part of the tooltip, and a compile has no progress signal to
  // report beyond "still going".
  useEffect(() => {
    if (!state) { setElapsedSeconds(0); return }
    const tick = () => setElapsedSeconds(Math.max(0, (Date.now() - state.startedAt) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [state])

  return { warming: state !== null, model: state?.model ?? '', elapsedSeconds }
}
