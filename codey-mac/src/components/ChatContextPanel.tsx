import React from 'react'
import type { Chat, ChatMessage } from '../types'
import { C } from '../theme'
import { parseTeamMessage } from './teamMessageFormat'

interface Props {
  chat: Chat
  selectedTurnId: string | null
  followLatest: boolean
  /** 1-based index of the selected assistant turn in the chat (for "Turn N" display). */
  selectedTurnIndex: number | null
  /** Effective agent for this chat (resolved by ChatTab from override/worker/default). */
  effectiveAgent: string
  /** Effective model for this chat. May be undefined when no model is resolvable. */
  effectiveModel?: string
  /** Worker name actively bound to the selected turn, when chat selection is a worker. */
  workerName?: string
  /** Team name actively bound, when chat selection is a team. */
  teamName?: string
  /** Working directory of the workspace, used to render relative file paths. */
  workingDir?: string
  width: number
  onFollowLatest: () => void
  onClose: () => void
  onResize: (next: number) => void
  onRevealFile: (absPath: string) => void
  onScrollToStep: (messageId: string, stepNum: number) => void
  /** True when the selected turn is the last assistant message and the chat is currently in flight. */
  isTurnStreaming: boolean
}

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const formatTokens = (n: number): string | null => {
  if (!Number.isFinite(n) || n < 0) return null
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

export const ChatContextPanel: React.FC<Props> = ({
  chat, selectedTurnId, followLatest, selectedTurnIndex,
  effectiveAgent, effectiveModel, workerName, teamName, workingDir,
  width, onFollowLatest, onClose, onResize, onRevealFile, onScrollToStep, isTurnStreaming,
}) => {
  const turn: ChatMessage | undefined = selectedTurnId
    ? chat.messages.find(m => m.id === selectedTurnId && m.role === 'assistant')
    : undefined

  const triggeringUserMsg: ChatMessage | undefined = (() => {
    if (!turn) return undefined
    const idx = chat.messages.findIndex(m => m.id === turn.id)
    if (idx <= 0) return undefined
    for (let i = idx - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'user') return chat.messages[i]
    }
    return undefined
  })()

  const latestAssistantId: string | null = (() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'assistant') return chat.messages[i].id
    }
    return null
  })()

  // Resize drag handler
  const onResizerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const move = (mv: MouseEvent) => {
      const next = Math.max(260, Math.min(520, startW + (startX - mv.clientX)))
      onResize(next)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div style={{ ...styles.root, width }}>
      <div style={styles.resizer} onMouseDown={onResizerMouseDown} title="Drag to resize" />
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerMeta}>
          {turn ? (
            <>
              <span style={styles.headerTitle}>Turn {selectedTurnIndex ?? '?'}</span>
              <span style={styles.headerDot}>·</span>
              <span style={styles.headerSub}>{fmtTime(turn.timestamp)}</span>
              {turn.durationSec != null && Number.isFinite(turn.durationSec) && (
                <><span style={styles.headerDot}>·</span><span style={styles.headerSub}>{turn.durationSec}s</span></>
              )}
              {(() => {
                const t = turn.tokens != null ? formatTokens(turn.tokens) : null
                return t ? <><span style={styles.headerDot}>·</span><span style={styles.headerSub}>{t} tok</span></> : null
              })()}
            </>
          ) : (
            <span style={styles.headerSub}>No turn selected</span>
          )}
        </div>
        {!followLatest && (
          <button style={styles.followPill} onClick={onFollowLatest} title="Follow live updates">Follow latest ↓</button>
        )}
        <button style={styles.closeBtn} onClick={onClose} aria-label="Close panel">×</button>
      </div>

      <div style={styles.body}>
        {/* Run target */}
        <Section title="Run target">
          <div style={styles.runTargetRow}>
            {teamName ? `Team: ${teamName}` : workerName ? `Worker: ${workerName}` : 'Direct chat'}
          </div>
          <div style={styles.runTargetSub}>
            {effectiveAgent}{effectiveModel ? ` · ${effectiveModel}` : ''}
          </div>
        </Section>

        {turn && (
          <TeamFlow
            turn={turn}
            isStreaming={isTurnStreaming}
            onScrollToStep={onScrollToStep}
          />
        )}
        {turn && <ToolTimeline toolCalls={turn.toolCalls ?? []} />}
        {turn && <FilesTouched toolCalls={turn.toolCalls ?? []} workingDir={workingDir} onReveal={onRevealFile} />}
        {triggeringUserMsg?.attachments && triggeringUserMsg.attachments.length > 0 && (
          <AttachmentsSection attachments={triggeringUserMsg.attachments} />
        )}
        {chat.pendingTeam && turn && turn.id === latestAssistantId && (
          <PendingTeamSection pending={chat.pendingTeam} />
        )}
        {turn && (turn.toolCalls?.length ?? 0) === 0 && (
          <Section title="Tool calls">
            <div style={styles.emptyHint}>No tool activity for this turn.</div>
          </Section>
        )}
        {!turn && <div style={styles.emptyHint}>Send a message to see run context.</div>}
      </div>
    </div>
  )
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit'])

const FilesTouched: React.FC<{
  toolCalls: import('../types').ToolCallEntry[]
  workingDir?: string
  onReveal: (absPath: string) => void
}> = ({ toolCalls, workingDir, onReveal }) => {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const tc of toolCalls) {
    if (tc.type !== 'tool_start') continue
    if (!tc.tool || !FILE_TOOLS.has(tc.tool)) continue
    const p = (tc.input as any)?.file_path
    if (typeof p !== 'string' || !p) continue
    if (!seen.has(p)) { seen.add(p); paths.push(p) }
  }
  if (paths.length === 0) return null

  const display = (abs: string): string => {
    if (workingDir && abs.startsWith(workingDir)) {
      const rel = abs.slice(workingDir.length).replace(/^\/+/, '')
      return rel || abs
    }
    return abs
  }

  return (
    <Section title="Files touched">
      <div style={filesStyles.list}>
        {paths.sort().map(p => (
          <div key={p} style={filesStyles.row} title={p}>
            <span style={filesStyles.path}>{display(p)}</span>
            <button
              style={filesStyles.iconBtn}
              onClick={() => onReveal(p)}
              title="Reveal in Finder"
            >⤴</button>
            <button
              style={filesStyles.iconBtn}
              onClick={() => navigator.clipboard.writeText(p)}
              title="Copy path"
            >⧉</button>
          </div>
        ))}
      </div>
    </Section>
  )
}

const filesStyles: Record<string, React.CSSProperties> = {
  list: { display: 'flex', flexDirection: 'column', gap: 2 },
  row: {
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '2px 0', fontSize: 11,
  },
  path: {
    flex: 1, color: C.fg2, fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
  },
  iconBtn: {
    background: 'transparent', border: 'none', color: C.fg3,
    cursor: 'pointer', fontSize: 12, padding: '0 4px', flexShrink: 0,
  },
}

const TeamFlow: React.FC<{
  turn: ChatMessage
  isStreaming: boolean
  onScrollToStep: (messageId: string, stepNum: number) => void
}> = ({ turn, isStreaming, onScrollToStep }) => {
  const parsed = parseTeamMessage(turn.content)
  if (!parsed) return null
  const infos = (turn.toolCalls ?? []).filter(tc => tc.type === 'info')
  // Match info messages to steps by step number prefix ("Step N:" or "Step N/M:")
  const reasonByStep = new Map<number, string>()
  for (const info of infos) {
    const m = info.message.match(/^Step\s+(\d+)/)
    if (!m) continue
    reasonByStep.set(parseInt(m[1], 10), info.message)
  }
  const lastIdx = parsed.steps.length - 1
  return (
    <Section title={`Team flow (${parsed.steps.length} step${parsed.steps.length === 1 ? '' : 's'})`}>
      <div style={flowStyles.list}>
        {parsed.steps.map((s, i) => {
          const isRunning = isStreaming && i === lastIdx
          const status: 'done' | 'running' = isRunning ? 'running' : 'done'
          const reason = reasonByStep.get(s.step)
          return (
            <div
              key={`${turn.id}::${s.step}`}
              style={flowStyles.row}
              onClick={() => onScrollToStep(turn.id, s.step)}
              title="Click to jump to this step"
            >
              <span style={status === 'running' ? flowStyles.dotRunning : flowStyles.dotDone}>
                {status === 'running' ? '●' : '✓'}
              </span>
              <div style={flowStyles.body}>
                <div style={flowStyles.workerLine}>
                  <span style={flowStyles.stepNum}>Step {s.step}</span>
                  <span style={flowStyles.workerName}>{s.worker}</span>
                </div>
                {reason && <div style={flowStyles.reason}>{reason.replace(/^Step\s+\d+(?:\/\d+)?:\s*\S+\s*(?:—|—|-)?\s*/, '')}</div>}
              </div>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

const flowStyles: Record<string, React.CSSProperties> = {
  list: { display: 'flex', flexDirection: 'column', gap: 0, position: 'relative' },
  row: {
    display: 'flex', alignItems: 'flex-start', gap: 8,
    padding: '6px 0', cursor: 'pointer',
    borderBottom: `1px dashed ${C.border2}`,
  },
  dotRunning: {
    color: '#6ab0f3', fontSize: 12, lineHeight: '16px',
    width: 14, flexShrink: 0, textAlign: 'center' as const,
  },
  dotDone: {
    color: '#7ec97e', fontSize: 12, lineHeight: '16px',
    width: 14, flexShrink: 0, textAlign: 'center' as const,
  },
  body: { flex: 1, minWidth: 0 },
  workerLine: { display: 'flex', alignItems: 'baseline', gap: 6 },
  stepNum: { fontSize: 10, color: C.fg3, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  workerName: { fontSize: 12, color: C.fg, fontWeight: 500 },
  reason: { fontSize: 11, color: C.fg3, marginTop: 2, lineHeight: 1.4 },
}

const ToolTimeline: React.FC<{ toolCalls: import('../types').ToolCallEntry[] }> = ({ toolCalls }) => {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())

  type Row =
    | { kind: 'call'; id: string; tool?: string; input?: Record<string, unknown>; output?: string; done: boolean; message: string }
    | { kind: 'info'; id: string; message: string }
  const rows: Row[] = []
  const startIdxById = new Map<string, number>()
  for (const tc of toolCalls) {
    if (tc.type === 'info') {
      rows.push({ kind: 'info', id: tc.id, message: tc.message })
      continue
    }
    if (tc.type === 'tool_start') {
      const idx = rows.push({
        kind: 'call', id: tc.id, tool: tc.tool, input: tc.input,
        done: false, message: tc.message,
      }) - 1
      startIdxById.set(tc.id, idx)
    } else { // tool_end
      const idx = startIdxById.get(tc.id)
      if (idx != null) {
        const row = rows[idx] as Extract<Row, { kind: 'call' }>
        row.done = true
        if (tc.output) row.output = tc.output
        if (tc.message) row.message = tc.message
        startIdxById.delete(tc.id)
      } else {
        rows.push({
          kind: 'call', id: tc.id, tool: tc.tool, output: tc.output,
          done: true, message: tc.message,
        })
      }
    }
  }

  if (rows.length === 0) return null
  return (
    <Section title="Tool calls">
      <div style={timelineStyles.list}>
        {rows.map(r => {
          if (r.kind === 'info') {
            return (
              <div key={r.id} style={timelineStyles.infoRow}>
                <span style={timelineStyles.iconInfo}>ⓘ</span>
                <span>{r.message}</span>
              </div>
            )
          }
          const isOpen = expanded.has(r.id)
          const hasDetail = !!r.input || !!r.output
          const toggle = () => setExpanded(prev => {
            const next = new Set(prev)
            next.has(r.id) ? next.delete(r.id) : next.add(r.id)
            return next
          })
          const icon = !r.done ? '▶' : '✓'
          return (
            <div key={r.id}>
              <div
                style={{ ...timelineStyles.callRow, cursor: hasDetail ? 'pointer' : 'default' }}
                onClick={hasDetail ? toggle : undefined}
              >
                <span style={r.done ? timelineStyles.iconDone : timelineStyles.iconRunning}>{icon}</span>
                <span style={timelineStyles.tool}>{r.tool ?? '(tool)'}</span>
                <span style={timelineStyles.callMsg}>{r.message}</span>
              </div>
              {hasDetail && isOpen && (
                <div style={timelineStyles.detail}>
                  {r.input && (
                    <>
                      <div style={timelineStyles.detailLabel}>input</div>
                      <pre style={timelineStyles.code}>{JSON.stringify(r.input, null, 2)}</pre>
                    </>
                  )}
                  {r.output && (
                    <>
                      <div style={timelineStyles.detailLabel}>output</div>
                      <pre style={timelineStyles.code}>{truncate(r.output, 2048)}</pre>
                    </>
                  )}
                  {!r.done && !r.output && (
                    <div style={timelineStyles.detailLabel}>(no result yet)</div>
                  )}
                  {r.done && !r.output && !r.input && (
                    <div style={timelineStyles.detailLabel}>(no result)</div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n… (${s.length - max} more chars)`
}

const timelineStyles: Record<string, React.CSSProperties> = {
  list: { display: 'flex', flexDirection: 'column', gap: 4 },
  infoRow: {
    display: 'flex', alignItems: 'flex-start', gap: 6,
    color: C.fg3, fontSize: 11, fontStyle: 'italic',
  },
  callRow: {
    display: 'flex', alignItems: 'flex-start', gap: 6,
    fontSize: 12, fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    padding: '2px 0',
  },
  tool: { color: '#9bbcd9', flexShrink: 0 },
  callMsg: { color: C.fg2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  iconRunning: { color: '#6ab0f3', width: 12, flexShrink: 0 },
  iconDone: { color: '#7ec97e', width: 12, flexShrink: 0 },
  iconInfo: { color: C.fg3, width: 12, flexShrink: 0 },
  detail: {
    marginLeft: 18, marginTop: 4, marginBottom: 6,
    padding: 8, background: 'rgba(0,0,0,0.3)',
    border: `1px solid ${C.border}`, borderRadius: 6,
    maxHeight: 280, overflowY: 'auto',
  },
  detailLabel: { color: C.fg3, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  code: {
    color: C.fg, fontSize: 11, fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    margin: '4px 0 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
}

const AttachmentsSection: React.FC<{ attachments: import('../types').FileAttachment[] }> = ({ attachments }) => {
  if (!attachments.length) return null
  return (
    <Section title="Attachments">
      <div style={attStyles.row}>
        {attachments.map(a => {
          const isImage = a.mimeType.startsWith('image/')
          if (isImage) {
            return (
              <img
                key={a.id}
                src={`codey-asset://file/${encodeURIComponent(a.path)}`}
                alt={a.name}
                title={a.name}
                style={attStyles.img}
                onClick={() => window.codey?.openPath?.(a.path)}
              />
            )
          }
          return (
            <div key={a.id} style={attStyles.chip} title={a.name} onClick={() => window.codey?.openPath?.(a.path)}>
              {a.name}
            </div>
          )
        })}
      </div>
    </Section>
  )
}

const attStyles: Record<string, React.CSSProperties> = {
  row: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  img: {
    width: 64, height: 64, objectFit: 'cover',
    borderRadius: 6, border: `1px solid ${C.border2}`, cursor: 'pointer',
  },
  chip: {
    padding: '4px 8px', background: C.surface3, border: `1px solid ${C.border2}`,
    borderRadius: 6, fontSize: 11, color: C.fg2, cursor: 'pointer',
    maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
}

const PendingTeamSection: React.FC<{ pending: NonNullable<Chat['pendingTeam']> }> = ({ pending }) => {
  // Both variants of PendingTeamState (mode: 'sequential' and mode: 'auto')
  // expose askingWorker + question — see packages/core/src/types/pending-team.ts.
  const workerName = pending.askingWorker
  const question = pending.question
  return (
    <Section title="Pending team">
      <div style={pendStyles.callout}>
        <div style={pendStyles.title}>Waiting on input for {workerName}</div>
        {question && <div style={pendStyles.body}>{question}</div>}
        <div style={pendStyles.hint}>Type a reply in the chat to resume the team.</div>
      </div>
    </Section>
  )
}

const pendStyles: Record<string, React.CSSProperties> = {
  callout: {
    background: 'rgba(255, 196, 0, 0.10)', border: '1px solid rgba(255, 196, 0, 0.35)',
    borderRadius: 6, padding: '8px 10px',
  },
  title: { color: C.fg, fontSize: 12, fontWeight: 600, marginBottom: 4 },
  body: { color: C.fg2, fontSize: 11, marginBottom: 6, whiteSpace: 'pre-wrap' },
  hint: { color: C.fg3, fontSize: 10, fontStyle: 'italic' },
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={styles.section}>
    <div style={styles.sectionTitle}>{title}</div>
    <div>{children}</div>
  </div>
)

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'relative',
    height: '100%',
    background: C.surface2,
    borderLeft: `1px solid ${C.border}`,
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
  },
  resizer: {
    position: 'absolute',
    left: -3, top: 0, bottom: 0, width: 6,
    cursor: 'col-resize',
    zIndex: 5,
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 12px', borderBottom: `1px solid ${C.border}`,
    flexShrink: 0,
  },
  headerMeta: { flex: 1, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' },
  headerTitle: { color: C.fg, fontSize: 12, fontWeight: 600 },
  headerSub: { color: C.fg3, fontSize: 11, fontVariantNumeric: 'tabular-nums' },
  headerDot: { color: C.fg3, fontSize: 11, opacity: 0.5 },
  followPill: {
    background: C.accent, color: '#fff', border: 'none',
    borderRadius: 10, fontSize: 10, padding: '2px 8px', cursor: 'pointer',
  },
  closeBtn: {
    background: 'transparent', border: 'none', color: C.fg2,
    fontSize: 18, lineHeight: 1, padding: '0 4px', cursor: 'pointer',
  },
  body: { flex: 1, overflowY: 'auto', padding: '8px 12px' },
  section: { marginBottom: 14 },
  sectionTitle: {
    color: C.fg3, fontSize: 10, fontWeight: 600, letterSpacing: 0.6,
    textTransform: 'uppercase', marginBottom: 6,
  },
  runTargetRow: { color: C.fg, fontSize: 12 },
  runTargetSub: { color: C.fg3, fontSize: 11, marginTop: 2 },
  emptyHint: { color: C.fg3, fontSize: 11, fontStyle: 'italic', padding: '12px 0' },
}
