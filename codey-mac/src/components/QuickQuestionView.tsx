import React from 'react'
import { C } from '../theme'
import { Markdown } from './Markdown'
import { useQuickQuestion } from '../hooks/useQuickQuestion'

interface Props {
  chatId: string
  /** Set by the parent so it can focus the composer when QQ mode is opened. */
  inputRef?: React.RefObject<HTMLTextAreaElement>
}

export const QuickQuestionView: React.FC<Props> = ({ chatId, inputRef }) => {
  const { getThread, ask, stop } = useQuickQuestion()
  const thread = getThread(chatId)
  const [draft, setDraft] = React.useState('')
  const listRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [thread.messages, thread.activity])

  const submit = () => {
    const q = draft.trim()
    if (!q || thread.inFlight) return
    setDraft('')
    void ask(chatId, q)
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div style={qqStyles.root}>
      <div style={qqStyles.hint}>
        Read-only side-thread. Answers use this chat's content as context but never
        modify the chat or its files.
      </div>
      <div ref={listRef} style={qqStyles.list}>
        {thread.messages.length === 0 && (
          <div style={qqStyles.empty}>Ask a quick question about this chat.</div>
        )}
        {thread.messages.map(m => (
          <div key={m.id} style={m.role === 'user' ? qqStyles.userMsg : qqStyles.asstMsg}>
            {m.role === 'user'
              ? <span style={qqStyles.userText}>{m.content}</span>
              : m.error
                ? <span style={qqStyles.errText}>{m.content}</span>
                : <Markdown>{m.content || (m.streaming ? '…' : '')}</Markdown>}
          </div>
        ))}
        {thread.inFlight && thread.activity && (
          <div style={qqStyles.activity}>{thread.activity}</div>
        )}
      </div>
      <div style={qqStyles.composer}>
        <textarea
          ref={inputRef}
          style={qqStyles.textarea}
          value={draft}
          placeholder="Ask a quick question…"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKey}
          rows={2}
        />
        {thread.inFlight ? (
          <button style={qqStyles.stopBtn} onClick={() => void stop(chatId)}>Stop</button>
        ) : (
          <button style={qqStyles.sendBtn} onClick={submit} disabled={!draft.trim()}>Ask</button>
        )}
      </div>
    </div>
  )
}

const qqStyles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  hint: { color: C.fg3, fontSize: 10, fontStyle: 'italic', padding: '0 0 8px' },
  list: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 },
  empty: { color: C.fg3, fontSize: 11, fontStyle: 'italic', padding: '12px 0' },
  userMsg: { alignSelf: 'flex-end', maxWidth: '90%', background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 8, padding: '6px 8px' },
  userText: { color: C.fg, fontSize: 12, whiteSpace: 'pre-wrap' },
  asstMsg: { alignSelf: 'flex-start', maxWidth: '100%', fontSize: 12, color: C.fg2, minWidth: 0 },
  errText: { color: C.dangerFg ?? '#e66', fontSize: 12, whiteSpace: 'pre-wrap' },
  activity: { color: C.fg3, fontSize: 10, fontStyle: 'italic' },
  composer: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8, borderTop: `1px solid ${C.border}` },
  textarea: {
    resize: 'none', width: '100%', background: C.surface3, color: C.fg,
    border: `1px solid ${C.border2}`, borderRadius: 6, padding: '6px 8px',
    fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box',
  },
  sendBtn: {
    alignSelf: 'flex-end', background: C.accent, color: C.onAccent, border: 'none',
    borderRadius: 6, fontSize: 11, padding: '4px 12px', cursor: 'pointer',
  },
  stopBtn: {
    alignSelf: 'flex-end', background: 'transparent', color: C.fg2,
    border: `1px solid ${C.border2}`, borderRadius: 6, fontSize: 11, padding: '4px 12px', cursor: 'pointer',
  },
}
