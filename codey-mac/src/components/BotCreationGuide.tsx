import { useRef, useState } from 'react'
import { C } from '../theme'

const purposes = [
  { label: 'Build & fix code', question: 'What should it focus on?', options: ['Build features', 'Find and fix bugs', 'Review code and suggest fixes'] },
  { label: 'Shape product ideas', question: 'Where would you like its help?', options: ['Explore ideas with me', 'Turn ideas into requirements', 'Review designs and user flows'] },
  { label: 'Write & edit', question: 'What will you mainly create together?', options: ['Articles and posts', 'Clear documentation', 'Polish drafts in my voice'] },
  { label: 'Research & analyze', question: 'What kind of help would be most useful?', options: ['Research topics and compare options', 'Analyze data and explain findings', 'Summarize information into next steps'] },
  { label: 'Plan & organize', question: 'What should it help you organize?', options: ['Projects and next steps', 'Daily priorities', 'Repeatable workflows'] },
]

/** A short, local conversation; only the completed brief invokes generation. */
export function BotCreationGuide({ busy, error, onCreate, onCancel }: {
  busy: boolean
  error?: string | null
  onCreate: (brief: string) => Promise<void>
  onCancel: () => void
}) {
  const [purpose, setPurpose] = useState('')
  const [draft, setDraft] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const submitting = useRef(false)
  const preset = purposes.find(item => item.label === purpose)
  const question = preset?.question ?? 'What would you like it to help you achieve?'
  const options = preset?.options ?? ['Give me advice and ideas', 'Create useful drafts and plans', 'Help me work through tasks step by step']
  const button = { padding: '9px 12px', background: C.surface2, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 9, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit', fontSize: 12, textAlign: 'left' as const }

  const create = async (goal: string) => {
    if (busy || submitting.current || !purpose) return
    submitting.current = true
    setAnswer(goal)
    try {
      await onCreate(`Create a bot from this short setup conversation.\nMain purpose: ${purpose}\n${question}\nUser answer: ${goal}\nUse sensible defaults for unspecified details. Keep its role focused on this purpose; do not invent additional requirements.`)
    } finally { submitting.current = false }
  }

  const respond = (value: string) => {
    if (!value.trim() || busy || submitting.current) return
    if (!purpose) { setPurpose(value.trim()); setDraft('') }
    else { void create(value.trim()) }
  }

  return <div style={{ display: 'grid', gap: 12, fontSize: 13 }}>
    <strong style={{ fontSize: 15 }}>Let’s create your bot</strong>
    <div style={{ color: C.fg3, fontSize: 12 }}>One or two quick answers are enough. You can fine-tune it later.</div>
    <div style={{ background: C.surface2, padding: 12, borderRadius: 10 }}>What would you mainly like your bot to help with?</div>
    {purpose && <>
      <div style={{ justifySelf: 'end', padding: '9px 12px', borderRadius: 10, background: C.accentDim, overflowWrap: 'anywhere' }}>{purpose}</div>
      <div style={{ background: C.surface2, padding: 12, borderRadius: 10 }}>{question}</div>
    </>}
    {answer !== null && <div style={{ justifySelf: 'end', padding: '9px 12px', borderRadius: 10, background: C.accentDim, overflowWrap: 'anywhere' }}>{answer}</div>}
    {busy && <div role="status" style={{ color: C.fg3 }}>That’s enough to get started. Creating your bot…</div>}
    {error && <div role="alert" style={{ color: C.dangerFg }}>{error}</div>}
    {!busy && <>
      {purpose && <div style={{ color: C.fg3, fontSize: 12 }}>Choose an answer to start creating, or add your own below.</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {(purpose ? options : purposes.map(item => item.label)).map(option => <button type="button" key={option} style={button} onClick={() => respond(option)}>{option}</button>)}
      </div>
      <form onSubmit={event => { event.preventDefault(); respond(draft) }} style={{ display: 'grid', gap: 8 }}>
        <textarea key={purpose} autoFocus aria-label={purpose ? 'Your bot’s main goal' : 'Your bot’s purpose'} rows={2} value={draft} onChange={event => setDraft(event.target.value)} placeholder={purpose ? 'Or tell me your goal and any preferences…' : 'Or tell me what you have in mind…'} style={{ boxSizing: 'border-box', width: '100%', padding: 10, resize: 'vertical', background: C.bg, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 8, fontFamily: 'inherit', fontSize: 12 }} />
        <button disabled={!draft.trim()} style={{ ...button, background: C.accent, color: C.onAccent, opacity: draft.trim() ? 1 : 0.5 }}>{purpose ? 'Create with this answer' : 'Continue'}</button>
      </form>
      {purpose && <button type="button" style={button} onClick={() => void create(draft.trim() || 'Use sensible defaults for this purpose.')}>Create now{draft.trim() ? '' : ' with defaults'}</button>}
      {error && answer !== null && <button type="button" style={button} onClick={() => void create(answer)}>Retry creation</button>}
      <div style={{ display: 'flex', gap: 8 }}>
        {purpose && <button type="button" style={button} onClick={() => { setPurpose(''); setDraft(''); setAnswer(null) }}>Start over</button>}
        <button type="button" style={button} onClick={onCancel}>Cancel</button>
      </div>
    </>}
  </div>
}
