import React from 'react'
import { C } from '../theme'
import { Markdown } from './Markdown'
import { useQuickQuestion } from '../hooks/useQuickQuestion'
import { apiService } from '../services/api'
import type { FileAttachment } from '../types'

interface Props {
  chatId: string
  /** Set by the parent so it can focus the composer when QQ mode is opened. */
  inputRef?: React.RefObject<HTMLTextAreaElement>
}

// Small primitives mirrored from ChatTab's composer so the Quick Question
// composer matches the main chat input (inline send button, attach, etc.).
const SendIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 2L11 13M22 2L15 22 11 13 2 9l20-7z" />
  </svg>
)
const StopIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill={color}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </svg>
)
const PaperclipIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.44 11.05L12.25 20.24a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 11-2.83-2.83l8.49-8.48" />
  </svg>
)
const FileIcon: React.FC<{ color: string; size?: number }> = ({ color, size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
)

const assetUrl = (absPath: string): string =>
  `codey-asset://file/${encodeURIComponent(absPath)}`

const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

const MAX_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_ATTACHMENTS = 10
const ACCEPT = 'image/*,text/*,.json,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.css,.html,.md,.yaml,.yml,.toml,.xml,.sh,.bash,.zsh,.log,.csv,.sql'

export const QuickQuestionView: React.FC<Props> = ({ chatId, inputRef }) => {
  const { getThread, ask, stop } = useQuickQuestion()
  const thread = getThread(chatId)
  const [draft, setDraft] = React.useState('')
  const [pending, setPending] = React.useState<FileAttachment[]>([])
  const [uploadError, setUploadError] = React.useState<string | null>(null)
  const [isDragging, setIsDragging] = React.useState(false)
  const listRef = React.useRef<HTMLDivElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const dragDepthRef = React.useRef(0)

  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [thread.messages, thread.activity])

  const uploadFiles = async (files: FileList | File[]) => {
    const fileArray = Array.from(files)
    let count = pending.length
    const errors: string[] = []
    for (const file of fileArray) {
      if (count >= MAX_ATTACHMENTS) { errors.push(`Limit of ${MAX_ATTACHMENTS} attachments reached`); break }
      if (file.size > MAX_SIZE) { errors.push(`${file.name} exceeds 10 MB`); continue }
      try {
        const buffer = await file.arrayBuffer()
        const att = await apiService.chats.upload(chatId, file.name, file.type || 'application/octet-stream', buffer)
        setPending(prev => [...prev, att])
        count++
      } catch (err) {
        errors.push(`${file.name}: ${(err as Error).message}`)
      }
    }
    if (errors.length > 0) {
      setUploadError(errors.join(' · '))
      window.setTimeout(() => setUploadError(null), 4000)
    }
  }

  const removeAttachment = (id: string) => setPending(prev => prev.filter(a => a.id !== id))

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await uploadFiles(e.target.files)
      e.target.value = ''
    }
  }

  const handlePaste = async (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files)
    if (files.length > 0) {
      e.preventDefault()
      await uploadFiles(files)
    }
  }

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    if (!e.dataTransfer.types.includes('Files')) return
    dragDepthRef.current += 1
    setIsDragging(true)
  }
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    if (e.dataTransfer.types.includes('Files')) e.dataTransfer.dropEffect = 'copy'
  }
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setIsDragging(false)
  }
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    dragDepthRef.current = 0
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) await uploadFiles(e.dataTransfer.files)
  }

  const canSend = (!!draft.trim() || pending.length > 0) && !thread.inFlight

  const submit = () => {
    if (!canSend) return
    const q = draft
    const atts = pending.length > 0 ? [...pending] : undefined
    setDraft('')
    setPending([])
    void ask(chatId, q, atts)
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div
      style={qqStyles.root}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
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
            {m.attachments && m.attachments.length > 0 && (
              <div style={qqStyles.msgAttRow}>
                {m.attachments.map(a => a.mimeType.startsWith('image/') ? (
                  <img
                    key={a.id} src={assetUrl(a.path)} alt={a.name} title={a.name}
                    style={qqStyles.msgAttImg}
                    onClick={() => window.codey?.openPath?.(a.path)}
                  />
                ) : (
                  <div key={a.id} style={qqStyles.msgAttChip} title={`${a.name} · ${formatBytes(a.size)}`} onClick={() => window.codey?.openPath?.(a.path)}>
                    <FileIcon color={C.fg2} size={12} />
                    <span style={qqStyles.msgAttName}>{a.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {thread.inFlight && thread.activity && (
          <div style={qqStyles.activity}>{thread.activity}</div>
        )}
      </div>

      {uploadError && <div style={qqStyles.uploadError}>{uploadError}</div>}

      <div style={{ ...qqStyles.composer, ...(isDragging ? qqStyles.composerDragging : null) }}>
        {pending.length > 0 && (
          <div style={qqStyles.pendingRow}>
            {pending.map(att => att.mimeType.startsWith('image/') ? (
              <div key={att.id} style={qqStyles.pendingImageWrap} title={`${att.name} · ${formatBytes(att.size)}`}>
                <img src={assetUrl(att.path)} alt={att.name} style={qqStyles.pendingImage} />
                <button onClick={() => removeAttachment(att.id)} style={qqStyles.pendingRemoveBtn} aria-label="Remove">×</button>
              </div>
            ) : (
              <div key={att.id} style={qqStyles.pendingFileChip} title={`${att.name} · ${formatBytes(att.size)}`}>
                <FileIcon color={C.fg2} size={14} />
                <span style={qqStyles.pendingFileName}>{att.name}</span>
                <button onClick={() => removeAttachment(att.id)} style={qqStyles.pendingFileRemoveBtn} aria-label="Remove">×</button>
              </div>
            ))}
          </div>
        )}

        <div style={qqStyles.composerRow}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT}
            style={{ display: 'none' }}
            onChange={handleFilePick}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={thread.inFlight}
            style={qqStyles.attachBtn}
            title="Attach file"
          >
            <PaperclipIcon color={thread.inFlight ? C.fg3 : C.fg2} />
          </button>
          <textarea
            ref={inputRef}
            style={qqStyles.textarea}
            value={draft}
            placeholder={isDragging ? 'Drop to attach…' : 'Ask a quick question… (↵ to send)'}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKey}
            onPaste={handlePaste}
            onInput={e => {
              const el = e.currentTarget
              el.style.height = 'auto'
              el.style.height = Math.min(el.scrollHeight, 120) + 'px'
            }}
            rows={1}
          />
          {thread.inFlight ? (
            <button
              style={{ ...qqStyles.sendBtn, background: C.red, cursor: 'pointer' }}
              onClick={() => void stop(chatId)}
              title="Stop"
            >
              <StopIcon color="#fff" />
            </button>
          ) : (
            <button
              style={{ ...qqStyles.sendBtn, background: canSend ? C.accent : C.surface3, cursor: canSend ? 'pointer' : 'default' }}
              onClick={submit}
              disabled={!canSend}
              title="Ask"
            >
              <SendIcon color={canSend ? C.onAccent : C.fg3} />
            </button>
          )}
        </div>
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

  msgAttRow: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  msgAttImg: { width: 64, height: 64, objectFit: 'cover', borderRadius: 6, border: `1px solid ${C.border2}`, cursor: 'pointer' },
  msgAttChip: {
    display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
    background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 6,
    padding: '3px 8px', maxWidth: 180,
  },
  msgAttName: { color: C.fg2, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },

  uploadError: { color: C.dangerFg ?? '#e66', fontSize: 11, padding: '4px 2px' },

  pendingRow: { display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 8px 4px' },
  pendingImageWrap: { position: 'relative', width: 48, height: 48, borderRadius: 8, overflow: 'hidden', border: `1px solid ${C.border2}` },
  pendingImage: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  pendingRemoveBtn: {
    position: 'absolute', top: 2, right: 2, width: 16, height: 16, borderRadius: 8, border: 'none',
    background: 'rgba(0,0,0,0.7)', color: '#fff', cursor: 'pointer', fontSize: 12, lineHeight: '14px', padding: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  pendingFileChip: {
    display: 'flex', alignItems: 'center', gap: 6, background: C.surface2,
    border: `1px solid ${C.border2}`, borderRadius: 8, padding: '4px 4px 4px 8px', height: 48, boxSizing: 'border-box',
  },
  pendingFileName: { color: C.fg, fontSize: 11, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 },
  pendingFileRemoveBtn: {
    width: 20, height: 20, borderRadius: 10, border: 'none', background: 'transparent', color: C.fg3,
    cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  // Single bordered box wrapping the input row, mirroring ChatTab's composer so
  // the attach button, textarea, and send button align on one baseline.
  composer: {
    marginTop: 8, background: C.surface3, border: `1px solid ${C.border2}`,
    borderRadius: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  composerDragging: { borderColor: C.accent },
  composerRow: { display: 'flex', gap: 6, alignItems: 'flex-end', padding: 6 },
  attachBtn: {
    width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: 'pointer',
    transition: 'background 0.15s',
  },
  textarea: {
    flex: 1, resize: 'none', background: 'transparent', color: C.fg,
    border: 'none', borderRadius: 8, padding: '8px 6px', outline: 'none',
    fontSize: 13, fontFamily: 'inherit', lineHeight: 1.5, maxHeight: 120, overflowY: 'auto',
    boxSizing: 'border-box',
  },
  sendBtn: {
    width: 36, height: 36, borderRadius: 9, border: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 0.15s',
  },
}
