import React, { useEffect, useRef, useState } from 'react'
import type { ChatSelection, FileAttachment } from '../types'
import { apiService, WorkerDto } from '../services/api'
import { useChats } from '../hooks/useChats'
import { C } from '../theme'
import { Markdown } from './Markdown'
import { formatHeadline, hasDetail as toolHasDetail, ToolDetail, normalizeTool } from './toolFormat'

interface Props {
  chatId: string
  isGatewayRunning: boolean
}

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

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

const formatTokens = (n: number): string | null => {
  if (!Number.isFinite(n) || n < 0) return null
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

const TypingDots: React.FC = () => {
  const [n, setN] = useState(0)
  useEffect(() => { const t = setInterval(() => setN(v => (v + 1) % 4), 400); return () => clearInterval(t) }, [])
  return <span style={{ letterSpacing: 2 }}>{'●'.repeat(n + 1).padEnd(3, '○')}</span>
}

const PaperclipIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.44 11.05L12.25 20.24a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 11-2.83-2.83l8.49-8.48" />
  </svg>
)

const UploadCloudIcon: React.FC<{ color: string; size?: number }> = ({ color, size = 32 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 16l-4-4-4 4" />
    <path d="M12 12v9" />
    <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3" />
    <path d="M16 16l-4-4-4 4" />
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

export const ChatTab: React.FC<Props> = ({ chatId, isGatewayRunning }) => {
  const { state, sendMessage, stopChat, setSelection, renameChat } = useChats()
  const chat = state.chats[chatId]
  const flight = state.inFlight[chatId]

  const [input, setInput] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [workers, setWorkers] = useState<WorkerDto[]>([])
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState<FileAttachment[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const dragDepthRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { apiService.listWorkers().then(setWorkers) }, [])
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chat?.messages?.length])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && flight) stopChat(chatId)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [flight, chatId])

  if (!chat) return null

  const selectionValue: string = chat.selection.type === 'worker'
    ? `worker:${chat.selection.name}`
    : chat.selection.type === 'team'
      ? 'team'
      : 'none'

  const onSelectionChange = async (v: string) => {
    let next: ChatSelection
    if (v === 'none') next = { type: 'none' }
    else if (v === 'team') next = { type: 'team' }
    else next = { type: 'worker', name: v.slice('worker:'.length) }
    await setSelection(chat.id, next)
  }

  const uploadFiles = async (files: FileList | File[]) => {
    const fileArray = Array.from(files)
    const maxSize = 10 * 1024 * 1024 // 10MB
    const maxAttachments = 10
    let count = pendingAttachments.length
    const errors: string[] = []

    for (const file of fileArray) {
      if (count >= maxAttachments) {
        errors.push(`Limit of ${maxAttachments} attachments reached`)
        break
      }
      if (file.size > maxSize) {
        errors.push(`${file.name} exceeds 10 MB`)
        continue
      }

      try {
        const buffer = await file.arrayBuffer()
        const attachment = await apiService.chats.upload(chatId, file.name, file.type || 'application/octet-stream', buffer)
        setPendingAttachments(prev => [...prev, attachment])
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

  const removeAttachment = (id: string) => {
    setPendingAttachments(prev => prev.filter(a => a.id !== id))
  }

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!e.dataTransfer.types.includes('Files')) return
    dragDepthRef.current += 1
    setIsDragging(true)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setIsDragging(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current = 0
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) {
      await uploadFiles(e.dataTransfer.files)
    }
  }

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await uploadFiles(e.target.files)
      e.target.value = '' // reset so same file can be re-selected
    }
  }

  const send = async () => {
    if ((!input.trim() && pendingAttachments.length === 0) || !isGatewayRunning || !!flight) return
    const text = input
    const atts = pendingAttachments.length > 0 ? [...pendingAttachments] : undefined
    setInput('')
    setPendingAttachments([])
    if (taRef.current) taRef.current.style.height = 'auto'
    await sendMessage(chat.id, text, atts)
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const isSending = !!flight
  const orphaned = state.workspaces.length > 0 && !state.workspaces.includes(chat.workspaceName)
  const canSend = isGatewayRunning && !isSending && (!!input.trim() || pendingAttachments.length > 0) && !orphaned
  const statusLabel = flight?.queuedPosition
    ? `Queued (#${flight.queuedPosition})`
    : flight?.agentStatus === 'thinking' ? 'Thinking…'
    : flight?.agentStatus === 'working'  ? 'Working…'
    : flight?.agentStatus === 'writing'  ? 'Writing…'
    : ''

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onBlur={async () => {
              if (titleDraft.trim() && titleDraft !== chat.title) await renameChat(chat.id, titleDraft.trim())
              setEditingTitle(false)
            }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingTitle(false) }}
            style={styles.titleInput}
          />
        ) : (
          <span style={styles.title} onDoubleClick={() => { setEditingTitle(true); setTitleDraft(chat.title) }}>
            {chat.title}
          </span>
        )}
        <span style={styles.workspaceTag}>{chat.workspaceName}</span>
        <div style={{ flex: 1 }} />
        <select value={selectionValue} onChange={e => onSelectionChange(e.target.value)} style={styles.workerSelect}>
          <option value="none">No worker</option>
          <option value="team">Team</option>
          {workers.map(w => <option key={w.name} value={`worker:${w.name}`}>{w.name}</option>)}
        </select>
      </div>

      <div
        style={{ ...styles.messages, position: 'relative' }}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div style={styles.dropOverlay}>
            <div style={styles.dropOverlayCard}>
              <UploadCloudIcon color={C.accent} size={36} />
              <div style={styles.dropOverlayTitle}>Drop to attach</div>
              <div style={styles.dropOverlaySubtitle}>Up to 10 files · max 10 MB each</div>
            </div>
          </div>
        )}
        {chat.messages.map(msg => {
          const isUser = msg.role === 'user'
          return (
            <div key={msg.id} style={{
              display: 'flex', flexDirection: 'column',
              alignItems: isUser ? 'flex-end' : 'flex-start',
              marginBottom: 12,
            }}>
              <div style={{
                maxWidth: '72%', padding: '10px 14px',
                borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                background: isUser ? C.userBg : C.aiBg,
                color: C.fg, fontSize: 13, lineHeight: 1.55, wordBreak: 'break-word',
                boxShadow: isUser ? 'none' : '0 1px 3px rgba(0,0,0,0.3)',
                border: isUser ? 'none' : `1px solid ${C.border2}`,
              }}>
                {msg.toolCalls && msg.toolCalls.length > 0 && (() => {
                  type Row =
                    | { kind: 'call'; id: string; tool?: string; input?: Record<string, unknown>; output?: string; done: boolean }
                    | { kind: 'info'; id: string; message: string }
                  const rows: Row[] = []
                  const pendingByTool = new Map<string, number>()
                  for (const tc of msg.toolCalls) {
                    if (tc.type === 'info') { rows.push({ kind: 'info', id: tc.id, message: tc.message }); continue }
                    const key = normalizeTool(tc.tool)
                    if (tc.type === 'tool_start') {
                      const idx = rows.push({ kind: 'call', id: tc.id, tool: tc.tool, input: tc.input, done: false }) - 1
                      pendingByTool.set(key, idx)
                    } else {
                      const idx = pendingByTool.get(key)
                      if (idx != null) {
                        const row = rows[idx] as Extract<Row, { kind: 'call' }>
                        row.done = true
                        if (tc.output) row.output = tc.output
                        pendingByTool.delete(key)
                      } else {
                        rows.push({ kind: 'call', id: tc.id, tool: tc.tool, output: tc.output, done: true })
                      }
                    }
                  }
                  return (
                    <>
                      <div style={styles.toolCallsContainer}>
                        {rows.map(row => {
                          if (row.kind === 'info') {
                            return (
                              <div key={row.id} style={{ ...styles.toolCallRow, ...styles.toolCallInfo }}>
                                <span>• {row.message}</span>
                              </div>
                            )
                          }
                          const isExpanded = expandedIds.has(row.id)
                          const detail = toolHasDetail(row.tool, row.input, row.output)
                          const toggle = () => setExpandedIds(prev => {
                            const next = new Set(prev)
                            next.has(row.id) ? next.delete(row.id) : next.add(row.id)
                            return next
                          })
                          const headline = formatHeadline(row.tool, row.input)
                          const markerColor = row.done ? '#5c5' : '#6ab0f3'
                          return (
                            <div key={row.id}>
                              <div
                                style={{ ...styles.toolCallRow, cursor: detail ? 'pointer' : 'default' }}
                                onClick={detail ? toggle : undefined}
                              >
                                {detail && (
                                  <span style={{ ...styles.chevron, transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                                )}
                                <span style={{ marginLeft: 2, color: row.done ? '#9bbcd9' : '#6ab0f3' }}>{headline}</span>
                              </div>
                              {detail && isExpanded && (
                                <div style={styles.toolDetail}>
                                  <ToolDetail rawTool={row.tool} input={row.input} output={row.output} />
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                      {msg.content && <div style={styles.toolCallSep} />}
                    </>
                  )
                })()}
                {msg.content && <Markdown variant={isUser ? 'user' : 'assistant'}>{msg.content}</Markdown>}
                {isUser && msg.attachments && msg.attachments.length > 0 && (
                  <div style={styles.attachmentsContainer}>
                    {msg.attachments.map(att => {
                      const isImage = att.mimeType.startsWith('image/')
                      const open = () => window.codey?.openPath?.(att.path)
                      if (isImage) {
                        return (
                          <img
                            key={att.id}
                            src={assetUrl(att.path)}
                            alt={att.name}
                            title={att.name}
                            style={styles.attachmentImage}
                            onClick={open}
                          />
                        )
                      }
                      return (
                        <div key={att.id} style={styles.attachmentFileChip} onClick={open} title={`${att.name} · ${formatBytes(att.size)}`}>
                          <div style={styles.attachmentFileIcon}><FileIcon color={C.fg2} /></div>
                          <div style={styles.attachmentFileMeta}>
                            <span style={styles.attachmentFileName}>{att.name}</span>
                            <span style={styles.attachmentFileSize}>{formatBytes(att.size)}</span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
              <div style={styles.tsLabel}>
                <span>{fmtTime(msg.timestamp)}</span>
                {(() => {
                  const tokStr = msg.tokens != null ? formatTokens(msg.tokens) : null
                  const durStr = msg.durationSec != null && Number.isFinite(msg.durationSec) ? `${msg.durationSec}s` : null
                  if (!tokStr && !durStr) return null
                  return (
                    <span style={styles.tsMeta}>
                      {tokStr && `${tokStr} tok`}
                      {tokStr && durStr && ' · '}
                      {durStr}
                    </span>
                  )
                })()}
              </div>
            </div>
          )
        })}
        {statusLabel && (
          <div style={styles.typingRow}>
            <TypingDots />
            <span>{statusLabel}</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {orphaned && (
        <div style={styles.orphanBanner}>
          Workspace "{chat.workspaceName}" no longer exists. Sending is disabled.
        </div>
      )}
      <div style={styles.inputContainer}>
        {uploadError && (
          <div style={styles.uploadError}>{uploadError}</div>
        )}
        <div style={styles.composer}>
          {pendingAttachments.length > 0 && (
            <div style={styles.pendingRow}>
              {pendingAttachments.map(att => {
                const isImage = att.mimeType.startsWith('image/')
                if (isImage) {
                  return (
                    <div key={att.id} style={styles.pendingImageWrap} title={`${att.name} · ${formatBytes(att.size)}`}>
                      <img src={assetUrl(att.path)} alt={att.name} style={styles.pendingImage} />
                      <button onClick={() => removeAttachment(att.id)} style={styles.pendingRemoveBtn} aria-label="Remove">×</button>
                    </div>
                  )
                }
                return (
                  <div key={att.id} style={styles.pendingFileChip} title={`${att.name} · ${formatBytes(att.size)}`}>
                    <div style={styles.pendingFileIcon}><FileIcon color={C.fg2} size={16} /></div>
                    <div style={styles.pendingFileMeta}>
                      <span style={styles.pendingFileName}>{att.name}</span>
                      <span style={styles.pendingFileSize}>{formatBytes(att.size)}</span>
                    </div>
                    <button onClick={() => removeAttachment(att.id)} style={styles.pendingFileRemoveBtn} aria-label="Remove">×</button>
                  </div>
                )
              })}
            </div>
          )}
          <div style={styles.composerRow}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,text/*,.json,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.css,.html,.md,.yaml,.yml,.toml,.xml,.sh,.bash,.zsh,.log,.csv,.sql"
              style={{ display: 'none' }}
              onChange={handleFilePick}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!isGatewayRunning || isSending}
              style={styles.attachButton}
              title="Attach file"
            >
              <PaperclipIcon color={isGatewayRunning && !isSending ? C.fg2 : C.fg3} />
            </button>
            <textarea
              ref={taRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              onInput={e => {
                const el = e.currentTarget
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 120) + 'px'
              }}
              placeholder={isGatewayRunning ? (isSending ? 'Sending…' : 'Message Codey… (↵ to send)') : 'Start gateway to chat'}
              disabled={!isGatewayRunning || isSending}
              rows={1}
              style={styles.input}
            />
            {isSending ? (
              <button
                onClick={() => stopChat(chatId)}
                style={{ ...styles.sendButton, background: '#e04040', cursor: 'pointer' }}
                title="Stop (Esc)"
              >
                <StopIcon color="#fff" />
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!canSend}
                style={{ ...styles.sendButton, background: canSend ? C.accent : C.surface3, cursor: canSend ? 'pointer' : 'default' }}
              >
                <SendIcon color={canSend ? '#fff' : C.fg3} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%' },
  header: {
    padding: '10px 16px', borderBottom: `1px solid ${C.border}`,
    display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
  },
  title: { color: C.fg, fontSize: 13, fontWeight: 600, cursor: 'text' },
  titleInput: { background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 4, padding: '2px 6px', color: C.fg, fontSize: 13, outline: 'none' },
  workspaceTag: { color: C.fg3, fontSize: 11 },
  workerSelect: {
    background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 6,
    color: C.fg2, fontSize: 12, padding: '4px 8px', outline: 'none',
  },
  messages: { flex: 1, overflowY: 'auto', padding: 16 },
  typingRow: { display: 'flex', alignItems: 'center', gap: 8, color: C.fg3, fontSize: 13, marginBottom: 12 },
  tsLabel: { color: C.fg3, fontSize: 10, marginTop: 4, paddingLeft: 4, paddingRight: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  tsMeta: { color: C.fg3, opacity: 0.55, fontVariantNumeric: 'tabular-nums' },
  inputContainer: { padding: '10px 14px 12px', borderTop: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 },
  composer: {
    background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 12,
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  composerRow: { display: 'flex', gap: 6, alignItems: 'flex-end', padding: 6 },
  input: {
    flex: 1, background: 'transparent', border: 'none', borderRadius: 8,
    color: C.fg, fontSize: 13, padding: '8px 6px', outline: 'none', resize: 'none',
    lineHeight: 1.5, maxHeight: 120, overflowY: 'auto',
  },
  sendButton: {
    width: 36, height: 36, borderRadius: 9, border: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, transition: 'background 0.15s',
  },
  toolCallsContainer: { marginBottom: 6, display: 'flex', flexDirection: 'column', gap: 2 },
  toolCallRow: {
    display: 'flex', alignItems: 'flex-start', fontSize: 12,
    color: '#6ab0f3', fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    padding: '2px 0', userSelect: 'text',
  },
  toolCallInfo: { color: '#888', fontStyle: 'italic' },
  toolCallSep: { borderTop: `1px solid ${C.border2}`, marginBottom: 6, marginTop: 4 },
  chevron: { display: 'inline-block', fontSize: 13, marginRight: 4, transition: 'transform 0.15s ease', color: '#555' },
  toolDetail: { marginLeft: 20, marginTop: 4, marginBottom: 6, padding: 8, background: 'rgba(0,0,0,0.3)', borderRadius: 6, border: `1px solid ${C.border}` },
  orphanBanner: { padding: '8px 12px', background: '#ff950033', color: '#ffb84d', fontSize: 12, borderTop: `1px solid ${C.border}` },
  dropOverlay: {
    position: 'absolute' as const, inset: 8, zIndex: 10,
    background: 'rgba(10, 132, 255, 0.08)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 12, border: `2px dashed ${C.accent}`,
    pointerEvents: 'none' as const,
  },
  dropOverlayCard: {
    display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 8,
    padding: '20px 28px', background: C.surface2, borderRadius: 12,
    border: `1px solid ${C.border2}`, boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  },
  dropOverlayTitle: { color: C.fg, fontSize: 14, fontWeight: 600 },
  dropOverlaySubtitle: { color: C.fg3, fontSize: 11 },
  attachmentsContainer: {
    display: 'flex', flexWrap: 'wrap' as const, gap: 6, marginTop: 8,
  },
  attachmentImage: {
    width: 96, height: 96, borderRadius: 8, objectFit: 'cover' as const, cursor: 'pointer',
    border: `1px solid ${C.border2}`,
  },
  attachmentFileChip: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'rgba(255,255,255,0.06)',
    border: `1px solid ${C.border2}`, borderRadius: 8,
    padding: '6px 10px', cursor: 'pointer', maxWidth: 220,
  },
  attachmentFileIcon: {
    width: 28, height: 28, borderRadius: 6, background: C.surface3,
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  attachmentFileMeta: { display: 'flex', flexDirection: 'column' as const, minWidth: 0, gap: 1 },
  attachmentFileName: {
    color: C.fg, fontSize: 12, fontWeight: 500,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, maxWidth: 160,
  },
  attachmentFileSize: { color: C.fg3, fontSize: 10, fontVariantNumeric: 'tabular-nums' as const },
  pendingRow: {
    display: 'flex', flexWrap: 'wrap' as const, gap: 8,
    padding: '8px 8px 4px',
  },
  pendingImageWrap: {
    position: 'relative' as const, width: 56, height: 56,
    borderRadius: 8, overflow: 'hidden', border: `1px solid ${C.border2}`,
  },
  pendingImage: {
    width: '100%', height: '100%', objectFit: 'cover' as const, display: 'block',
  },
  pendingRemoveBtn: {
    position: 'absolute' as const, top: 2, right: 2,
    width: 18, height: 18, borderRadius: 9, border: 'none',
    background: 'rgba(0,0,0,0.7)', color: '#fff',
    cursor: 'pointer', fontSize: 13, lineHeight: '16px', padding: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  pendingFileChip: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: 8,
    padding: '6px 6px 6px 10px', height: 56, boxSizing: 'border-box' as const,
  },
  pendingFileIcon: {
    width: 32, height: 32, borderRadius: 6, background: C.surface3,
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  pendingFileMeta: { display: 'flex', flexDirection: 'column' as const, minWidth: 0, gap: 2 },
  pendingFileName: {
    color: C.fg, fontSize: 12, fontWeight: 500,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, maxWidth: 140,
  },
  pendingFileSize: { color: C.fg3, fontSize: 10, fontVariantNumeric: 'tabular-nums' as const },
  pendingFileRemoveBtn: {
    width: 22, height: 22, borderRadius: 11, border: 'none',
    background: 'transparent', color: C.fg3,
    cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  uploadError: {
    color: '#ff8a80', fontSize: 11, padding: '0 4px',
  },
  attachButton: {
    width: 32, height: 32, borderRadius: 8, border: 'none',
    background: 'transparent', display: 'flex', alignItems: 'center',
    justifyContent: 'center', flexShrink: 0, cursor: 'pointer',
    transition: 'background 0.15s',
  },
}
