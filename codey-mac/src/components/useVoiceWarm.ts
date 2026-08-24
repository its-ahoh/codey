import { useEffect, useState } from 'react'

/**
 * Whether the on-device model is being prepared, and for how long.
 *
 * Both pushed and pulled: the startup warm begins before this window exists
 * and runs for minutes, so subscribing to the start event alone would miss the
 * common case and leave the composer's voice buttons enabled during the one
 * stretch where pressing them does nothing useful.
 *
 * Listens to `onPrepareChange` rather than the three warm events, because two
 * separate things can be preparing the same model at once — the `--warm-model`
 * process and the resident helper's own load — and either finishing while the
 * other runs must not read as "ready". The main process merges them; this hook
 * takes the merged answer.
 */
export function useVoiceWarm(): { warming: boolean; model: string; elapsedSeconds: number } {
  const [state, setState] = useState<{ model: string; startedAt: number } | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    let cancelled = false
    void window.codey.voice.getWarmState()
      .then(res => { if (!cancelled && res.ok && res.data) setState(res.data) })
      .catch(() => { /* best-effort: worst case the buttons stay enabled */ })

    const off = window.codey.voice.onPrepareChange(next => {
      setState(next ? { model: next.model, startedAt: next.startedAt } : null)
    })
    return () => { cancelled = true; off() }
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
