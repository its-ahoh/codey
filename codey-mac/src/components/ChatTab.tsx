import React, { useEffect, useRef, useState } from 'react'
import type { ChatSelection } from '../types'
import { apiService, WorkerDto } from '../services/api'
import { useChats } from '../hooks/useChats'
import { C } from '../theme'
import { Markdown } from './Markdown'

interface Props {
  chatId: string
  isGatewayRunning: boolean
}

const SendIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 2L11 13M22 2L15 22 11 13 2 9l20-7z" />
  </svg>
)

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

const formatTokens = (n: number): string => {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

const TypingDots: React.FC = () => {
  const [n, setN] = useState(0)
  useEffect(() => { const t = setInterval(() => setN(v => (v + 1) % 4), 400); return () => clearInterval(t) }, [])
  return <span style={{ letterSpacing: 2 }}>{'●'.repeat(n + 1).padEnd(3, '○')}</span>
}

export const ChatTab: React.FC<Props> = ({ chatId, isGatewayRunning }) => {
  const { state, sendMessage, setSelection, renameChat } = useChats()
  const chat = state.chats[chatId]
  const flight = state.inFlight[chatId]

  const [input, setInput] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [workers, setWorkers] = useState<WorkerDto[]>([])
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { apiService.listWorkers().then(setWorkers) }, [])
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chat?.messages?.length])

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

  const send = async () => {
    if (!input.trim() || !isGatewayRunning || !!flight) return
    const text = input
    setInput('')
    if (taRef.current) taRef.current.style.height = 'auto'
    await sendMessage(chat.id, text)
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const isSending = !!flight
  const canSend = isGatewayRunning && !isSending && !!input.trim()
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

      <div style={styles.messages}>
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
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <>
                    <div style={styles.toolCallsContainer}>
                      {msg.toolCalls.map(tc => {
                        const isExpanded = expandedIds.has(tc.id)
                        const hasDetail = tc.type === 'tool_start' && !!tc.input
                        const toggle = () => setExpandedIds(prev => {
                          const next = new Set(prev)
                          next.has(tc.id) ? next.delete(tc.id) : next.add(tc.id)
                          return next
                        })
                        return (
                          <div key={tc.id}>
                            <div
                              style={{
                                ...styles.toolCallRow,
                                ...(tc.type === 'tool_end' ? styles.toolCallEnd : {}),
                                ...(tc.type === 'info' ? styles.toolCallInfo : {}),
                                cursor: hasDetail ? 'pointer' : 'default',
                              }}
                              onClick={hasDetail ? toggle : undefined}
                            >
                              {tc.type === 'tool_end' && '✓ '}
                              {tc.type === 'info' && '• '}
                              {hasDetail && (
                                <span style={{ ...styles.chevron, transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                              )}
                              <span style={{ marginLeft: 2 }}>{tc.message}</span>
                            </div>
                            {hasDetail && isExpanded && (
                              <div style={styles.toolDetail}>
                                {tc.input && (<><div style={styles.detailLabel}>Input:</div><pre style={styles.detailPre}>{JSON.stringify(tc.input, null, 2)}</pre></>)}
                                {tc.output && (<><div style={styles.detailLabel}>Output:</div><pre style={styles.detailPre}>{tc.output}</pre></>)}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    {msg.content && <div style={styles.toolCallSep} />}
                  </>
                )}
                {msg.content && <Markdown variant={isUser ? 'user' : 'assistant'}>{msg.content}</Markdown>}
              </div>
              <div style={styles.tsLabel}>
                <span>{fmtTime(msg.timestamp)}</span>
                {(msg.tokens != null || msg.durationSec != null) && (
                  <span style={styles.tsMeta}>
                    {msg.tokens != null && `${formatTokens(msg.tokens)} tok`}
                    {msg.tokens != null && msg.durationSec != null && ' · '}
                    {msg.durationSec != null && `${msg.durationSec}s`}
                  </span>
                )}
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

      <div style={styles.inputContainer}>
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
        <button
          onClick={send}
          disabled={!canSend}
          style={{ ...styles.sendButton, background: canSend ? C.accent : C.surface3, cursor: canSend ? 'pointer' : 'default' }}
        >
          <SendIcon color={canSend ? '#fff' : C.fg3} />
        </button>
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
  inputContainer: { padding: '12px 14px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: 8, alignItems: 'flex-end', flexShrink: 0 },
  input: {
    flex: 1, background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 10,
    color: C.fg, fontSize: 13, padding: '10px 12px', outline: 'none', resize: 'none',
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
  toolCallEnd: { color: '#5c5' },
  toolCallInfo: { color: '#888', fontStyle: 'italic' },
  toolCallSep: { borderTop: `1px solid ${C.border2}`, marginBottom: 6, marginTop: 4 },
  chevron: { display: 'inline-block', fontSize: 10, marginRight: 4, transition: 'transform 0.15s ease', color: '#555' },
  toolDetail: { marginLeft: 20, marginTop: 4, marginBottom: 6, padding: 8, background: 'rgba(0,0,0,0.3)', borderRadius: 6, border: `1px solid ${C.border}` },
  detailLabel: { fontSize: 11, color: '#666', fontFamily: 'Menlo, Monaco, "Courier New", monospace', marginBottom: 4, textTransform: 'uppercase' },
  detailPre: { margin: 0, fontSize: 11, color: '#ccc', fontFamily: 'Menlo, Monaco, "Courier New", monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
}
