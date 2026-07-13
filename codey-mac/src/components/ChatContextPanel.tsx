import React from 'react'
import type { Chat, ChatMessage } from '../types'
import { C } from '../theme'
import { parseTeamMessage } from './teamMessageFormat'
import { CombinedDiffView, normalizeTool } from './toolFormat'
import { ToolCallList } from './ToolCallList'
import { QuickQuestionView } from './QuickQuestionView'
import { TaskHud } from './TaskHud'
import TeamRunFlow from './TeamRunFlow'

export type ContextPanelTab = 'current' | 'task' | 'files' | 'qq'

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
  /** Authored flow graph for the chat's team, if any. */
  teamGraph?: import('../../../packages/core/src/team-graph').TeamGraph
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
  /** Controlled active tab. When omitted the panel manages its own tab state. */
  activeTab?: ContextPanelTab
  onTabChange?: (tab: ContextPanelTab) => void
  /** Focused when the QQ tab opens via a trigger. */
  qqInputRef?: React.RefObject<HTMLTextAreaElement>
  /** Called after the user clicks "Answer" in the Task HUD — should focus the composer. */
  onAnswerNextAction: () => void
  /** Whether the task brief is currently being generated. */
  taskBriefLoading: boolean
  /** Called when the task tab becomes visible — triggers brief generation. */
  onTaskTabShown: () => void
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
  effectiveAgent, effectiveModel, workerName, teamName, teamGraph, workingDir,
  width, onFollowLatest, onClose, onResize, onRevealFile, onScrollToStep, isTurnStreaming,
  activeTab, onTabChange, qqInputRef,
  onAnswerNextAction, taskBriefLoading, onTaskTabShown,
}) => {
  const turn: ChatMessage | undefined = selectedTurnId
    ? chat.messages.find(m => m.id === selectedTurnId && m.role === 'assistant')
    : undefined

  const [flowOpen, setFlowOpen] = React.useState(false)

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

  const [localTab, setLocalTab] = React.useState<ContextPanelTab>('current')
  const tab: ContextPanelTab = activeTab ?? localTab
  const setTab = (t: ContextPanelTab) => { onTabChange ? onTabChange(t) : setLocalTab(t) }

  React.useEffect(() => { if (tab === 'task') onTaskTabShown() }, [tab])

  // Resize drag handler
  const onResizerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const move = (mv: MouseEvent) => {
      const next = Math.max(260, Math.min(900, startW + (startX - mv.clientX)))
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
              {(() => {
                const prompt = (triggeringUserMsg?.content ?? '').replace(/\s+/g, ' ').trim()
                const label = prompt ? (prompt.length > 60 ? prompt.slice(0, 59) + '…' : prompt) : `Turn ${selectedTurnIndex ?? '?'}`
                return <span style={styles.headerTitle} title={prompt || undefined}>{label}</span>
              })()}
              <div style={styles.headerSubLine}>
                {selectedTurnIndex != null && <><span style={styles.headerSub}>Turn {selectedTurnIndex}</span><span style={styles.headerDot}>·</span></>}
                <span style={styles.headerSub}>{fmtTime(turn.timestamp)}</span>
                {turn.durationSec != null && Number.isFinite(turn.durationSec) && (
                  <><span style={styles.headerDot}>·</span><span style={styles.headerSub}>{turn.durationSec}s</span></>
                )}
                {(() => {
                  const t = turn.tokens != null ? formatTokens(turn.tokens) : null
                  return t ? <><span style={styles.headerDot}>·</span><span style={styles.headerSub}>{t} tok</span></> : null
                })()}
              </div>
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

      {/* Tabs */}
      <div style={styles.tabs} role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'task'}
          style={{ ...styles.tab, ...(tab === 'task' ? styles.tabActive : null) }}
          onClick={() => setTab('task')}
        >Status</button>
        <button
          role="tab"
          aria-selected={tab === 'current'}
          style={{ ...styles.tab, ...(tab === 'current' ? styles.tabActive : null) }}
          onClick={() => setTab('current')}
        >Tools</button>
        <button
          role="tab"
          aria-selected={tab === 'files'}
          style={{ ...styles.tab, ...(tab === 'files' ? styles.tabActive : null) }}
          onClick={() => setTab('files')}
        >Files</button>
        <button
          role="tab"
          aria-selected={tab === 'qq'}
          style={{ ...styles.tab, ...(tab === 'qq' ? styles.tabActive : null) }}
          onClick={() => setTab('qq')}
        >Q&amp;A</button>
      </div>

      <div style={styles.body}>
        {tab === 'qq' ? (
          <QuickQuestionView chatId={chat.id} inputRef={qqInputRef} />
        ) : tab === 'task' ? (
          <TaskHud
            brief={chat.taskBrief}
            loading={taskBriefLoading}
            onAnswer={(messageId) => {
              if (messageId) onScrollToStep(messageId, 0)
              onAnswerNextAction()
            }}
          />
        ) : tab === 'current' ? (
          <>
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
                onViewFlow={teamName ? () => setFlowOpen(true) : undefined}
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
            {flowOpen && turn && (
              <TeamRunFlow
                turn={turn}
                isStreaming={isTurnStreaming}
                teamGraph={teamGraph}
                askingWorker={chat.pendingTeam?.askingWorker}
                group={turn.teamTurnId ? chat.messages.filter(m => m.teamTurnId === turn.teamTurnId) : undefined}
                onClose={() => setFlowOpen(false)}
              />
            )}
          </>
        ) : (
          <FileChangesView
            chat={chat}
            workingDir={workingDir}
            selectedTurnId={selectedTurnId}
            onReveal={onRevealFile}
          />
        )}
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
  /** When set, renders a "View flow ⤢" button that opens the run-flow overlay. */
  onViewFlow?: () => void
}> = ({ turn, isStreaming, onScrollToStep, onViewFlow }) => {
  const parsed = parseTeamMessage(turn.content)
  // Nothing to show: no steps to list and no overlay to launch.
  if (!parsed && !onViewFlow) return null
  const infos = (turn.toolCalls ?? []).filter(tc => tc.type === 'info')
  // Match info messages to steps by step number prefix ("Step N:" or "Step N/M:")
  const reasonByStep = new Map<number, string>()
  for (const info of infos) {
    const m = info.message.match(/^Step\s+(\d+)/)
    if (!m) continue
    reasonByStep.set(parseInt(m[1], 10), info.message)
  }
  const steps = parsed?.steps ?? []
  const lastIdx = steps.length - 1
  return (
    <Section title="Team flow">
      {onViewFlow && (
        <button
          onClick={onViewFlow}
          style={{ fontSize: 12, background: C.surface2, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '4px 12px', cursor: 'pointer', marginBottom: steps.length ? 8 : 0 }}
        >
          View flow ⤢
        </button>
      )}
      <div style={flowStyles.list}>
        {steps.map((s, i) => {
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
    color: C.accent, fontSize: 12, lineHeight: '16px',
    width: 14, flexShrink: 0, textAlign: 'center' as const,
  },
  dotDone: {
    color: C.green, fontSize: 12, lineHeight: '16px',
    width: 14, flexShrink: 0, textAlign: 'center' as const,
  },
  body: { flex: 1, minWidth: 0 },
  workerLine: { display: 'flex', alignItems: 'baseline', gap: 6 },
  stepNum: { fontSize: 10, color: C.fg3, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  workerName: { fontSize: 12, color: C.fg, fontWeight: 500 },
  reason: { fontSize: 11, color: C.fg3, marginTop: 2, lineHeight: 1.4 },
}

const ToolTimeline: React.FC<{ toolCalls: import('../types').ToolCallEntry[] }> = ({ toolCalls }) => {
  if (toolCalls.length === 0) return null
  return (
    <Section title="Tool calls">
      <ToolCallList toolCalls={toolCalls} />
    </Section>
  )
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

type FileChange = {
  msgId: string
  msgIdx: number
  turnNum: number
  ts: number
  callId: string
  tool: 'Edit' | 'Write' | 'Patch' | 'Notebook'
  rawTool: string
  path: string
  oldText: string
  newText: string
  patchText?: string
}

const extractReads = (chat: Chat): Array<{ path: string; msgId: string }> => {
  const out: Array<{ path: string; msgId: string }> = []
  const seen = new Set<string>()
  for (const m of chat.messages) {
    if (m.role !== 'assistant') continue
    for (const tc of m.toolCalls ?? []) {
      if (tc.type !== 'tool_start') continue
      if (normalizeTool(tc.tool) !== 'Read') continue
      const p = String((tc.input as any)?.file_path ?? '')
      if (p && !seen.has(p)) { seen.add(p); out.push({ path: p, msgId: m.id }) }
    }
  }
  return out
}

const extractChanges = (chat: Chat): FileChange[] => {
  const out: FileChange[] = []
  let turnNum = 0
  for (let idx = 0; idx < chat.messages.length; idx++) {
    const m = chat.messages[idx]
    if (m.role !== 'assistant') continue
    turnNum++
    for (const tc of m.toolCalls ?? []) {
      if (tc.type !== 'tool_start') continue
      const canonical = normalizeTool(tc.tool)
      if (canonical !== 'Edit' && canonical !== 'Write' && canonical !== 'Patch' && canonical !== 'Notebook') continue
      const i = (tc.input ?? {}) as Record<string, unknown>
      const path = String(i.file_path ?? i.path ?? i.filename ?? i.notebook_path ?? '')
      if (canonical === 'Edit') {
        // MultiEdit case: edits[] array
        const edits = i.edits as Array<{ old_string?: string; new_string?: string }> | undefined
        if (Array.isArray(edits) && edits.length > 0) {
          edits.forEach((e, ei) => {
            out.push({
              msgId: m.id, msgIdx: idx, turnNum, ts: m.timestamp,
              callId: `${tc.id}#${ei}`, tool: 'Edit', rawTool: tc.tool ?? 'Edit', path,
              oldText: String(e.old_string ?? ''),
              newText: String(e.new_string ?? ''),
            })
          })
        } else {
          out.push({
            msgId: m.id, msgIdx: idx, turnNum, ts: m.timestamp,
            callId: tc.id, tool: 'Edit', rawTool: tc.tool ?? 'Edit', path,
            oldText: String(i.old_string ?? i.oldText ?? ''),
            newText: String(i.new_string ?? i.newText ?? ''),
          })
        }
      } else if (canonical === 'Write') {
        out.push({
          msgId: m.id, msgIdx: idx, turnNum, ts: m.timestamp,
          callId: tc.id, tool: 'Write', rawTool: tc.tool ?? 'Write', path,
          oldText: '',
          newText: String(i.content ?? i.text ?? ''),
        })
      } else if (canonical === 'Patch') {
        out.push({
          msgId: m.id, msgIdx: idx, turnNum, ts: m.timestamp,
          callId: tc.id, tool: 'Patch', rawTool: tc.tool ?? 'Patch',
          path: path || '(multi-file patch)',
          oldText: '', newText: '',
          patchText: String(i.patch ?? i.diff ?? i.input ?? ''),
        })
      } else if (canonical === 'Notebook') {
        out.push({
          msgId: m.id, msgIdx: idx, turnNum, ts: m.timestamp,
          callId: tc.id, tool: 'Notebook', rawTool: tc.tool ?? 'NotebookEdit', path,
          oldText: String(i.old_source ?? ''),
          newText: String(i.new_source ?? ''),
        })
      }
    }
  }
  return out
}

/**
 * Find the real 1-based line where an edit begins, by locating its content in
 * the current file. Prefers the post-edit text (present in the current file);
 * falls back to the pre-edit text, then to the first non-blank line. Returns
 * undefined when the file is unavailable or the text can't be located (e.g. the
 * file changed since, or a later edit superseded this one).
 */
const locateStartLine = (content: string | null | undefined, oldText: string, newText: string): number | undefined => {
  if (!content) return undefined
  const needle = newText && newText.trim() ? newText : oldText
  if (!needle) return undefined
  let idx = content.indexOf(needle)
  if (idx < 0) {
    const firstLine = needle.split('\n').find(l => l.trim().length > 0)
    if (firstLine) idx = content.indexOf(firstLine)
  }
  if (idx < 0) return undefined
  return content.slice(0, idx).split('\n').length
}

const displayPath = (abs: string, workingDir?: string): string => {
  if (workingDir && abs.startsWith(workingDir)) {
    const rel = abs.slice(workingDir.length).replace(/^\/+/, '')
    return rel || abs
  }
  return abs
}

const FileChangesView: React.FC<{
  chat: Chat
  workingDir?: string
  selectedTurnId: string | null
  onReveal: (absPath: string) => void
}> = ({ chat, workingDir, selectedTurnId, onReveal }) => {
  const changes = React.useMemo(() => extractChanges(chat), [chat])
  const reads = React.useMemo(() => extractReads(chat), [chat])
  const [filter, setFilter] = React.useState<'all' | 'turn'>('all')
  // Files default to expanded; this set tracks the ones the user collapsed.
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set())

  // Current on-disk text per file, used to resolve real line numbers for each
  // edit. Loaded lazily and cached; a path we've already fetched is skipped.
  const [fileText, setFileText] = React.useState<Record<string, string | null>>({})
  const fetchedRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    let cancelled = false
    const paths = Array.from(new Set(changes.map(c => c.path)))
      .filter(p => p && p.startsWith('/') && !fetchedRef.current.has(p))
    if (paths.length === 0) return
    ;(async () => {
      for (const p of paths) {
        fetchedRef.current.add(p)
        const content = (await window.codey?.readTextFile?.(p)) ?? null
        if (cancelled) return
        setFileText(prev => ({ ...prev, [p]: content }))
      }
    })()
    return () => { cancelled = true }
  }, [changes])

  const visible = filter === 'turn' && selectedTurnId
    ? changes.filter(c => c.msgId === selectedTurnId)
    : changes

  const visibleReads = filter === 'turn' && selectedTurnId
    ? reads.filter(r => r.msgId === selectedTurnId)
    : reads

  // Reads that aren't already shown in the edits section
  const editedPaths = new Set(visible.map(c => c.path))
  const readOnlyFiles = visibleReads.filter(r => !editedPaths.has(r.path))

  if (changes.length === 0 && reads.length === 0) {
    return <div style={styles.emptyHint}>No file activity in this chat yet.</div>
  }

  // Group changes by file path, preserve first-seen order.
  const order: string[] = []
  const byFile = new Map<string, FileChange[]>()
  for (const c of visible) {
    if (!byFile.has(c.path)) { byFile.set(c.path, []); order.push(c.path) }
    byFile.get(c.path)!.push(c)
  }

  return (
    <div>
      <div style={fcStyles.toolbar}>
        <div style={fcStyles.scopeGroup} role="tablist">
          <button
            style={{ ...fcStyles.scopeBtn, ...(filter === 'all' ? fcStyles.scopeBtnActive : null) }}
            onClick={() => setFilter('all')}
          >All ({changes.length})</button>
          <button
            style={{ ...fcStyles.scopeBtn, ...(filter === 'turn' ? fcStyles.scopeBtnActive : null) }}
            onClick={() => setFilter('turn')}
            disabled={!selectedTurnId}
            title={selectedTurnId ? 'Show only this turn' : 'Select a turn to filter'}
          >This turn</button>
        </div>
        <div style={fcStyles.summary}>
          {order.length + readOnlyFiles.length} file{order.length + readOnlyFiles.length === 1 ? '' : 's'}
          {visible.length > 0 && <> · {visible.length} edit{visible.length === 1 ? '' : 's'}</>}
          {readOnlyFiles.length > 0 && <> · {readOnlyFiles.length} read</>}
        </div>
      </div>

      {visible.length === 0 && readOnlyFiles.length === 0 && (
        <div style={styles.emptyHint}>No file activity in the selected turn.</div>
      )}

      {order.map(path => {
        const group = byFile.get(path)!
        const isCollapsed = collapsed.has(path)
        const toggle = () => setCollapsed(prev => {
          const next = new Set(prev)
          next.has(path) ? next.delete(path) : next.add(path)
          return next
        })
        return (
          <div key={path} style={fcStyles.fileGroup}>
            <div style={fcStyles.fileHeader} title={path} onClick={toggle}>
              <span style={fcStyles.chevron}>{isCollapsed ? '▶' : '▾'}</span>
              <span style={fcStyles.filePath}>{displayPath(path, workingDir)}</span>
              <span style={fcStyles.fileCount}>{group.length} edit{group.length === 1 ? '' : 's'}</span>
              {path && path.startsWith('/') && (
                <button
                  style={fcStyles.iconBtn}
                  onClick={(e) => { e.stopPropagation(); onReveal(path) }}
                  title="Reveal in Finder"
                >⤴</button>
              )}
            </div>
            {!isCollapsed && (() => {
              // All Edit/Write/Notebook edits to this file collapse into a
              // single continuous diff; raw patches keep their own block.
              const content = fileText[path]
              const diffHunks = group
                .filter(c => c.tool !== 'Patch')
                .map(c => ({
                  oldText: c.oldText,
                  newText: c.newText,
                  startLine: locateStartLine(content, c.oldText, c.newText),
                }))
              const patches = group.filter(c => c.tool === 'Patch')
              return (
                <div style={fcStyles.changeBody}>
                  {diffHunks.length > 0 && <CombinedDiffView hunks={diffHunks} />}
                  {patches.map(c => (
                    <pre key={`${c.msgId}::${c.callId}`} style={fcStyles.patchPre}>
                      {c.patchText || '(empty patch)'}
                    </pre>
                  ))}
                </div>
              )
            })()}
          </div>
        )
      })}

      {readOnlyFiles.length > 0 && (
        <div style={fcStyles.readSection}>
          <div style={fcStyles.readHeader}>Files read</div>
          {readOnlyFiles.map(r => (
            <div key={r.path} style={filesStyles.row} title={r.path}>
              <span style={filesStyles.path}>{displayPath(r.path, workingDir)}</span>
              {r.path.startsWith('/') && (
                <button style={filesStyles.iconBtn} onClick={() => onReveal(r.path)} title="Reveal in Finder">⤴</button>
              )}
              <button style={filesStyles.iconBtn} onClick={() => navigator.clipboard.writeText(r.path)} title="Copy path">⧉</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const fcStyles: Record<string, React.CSSProperties> = {
  toolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, marginBottom: 10,
  },
  scopeGroup: { display: 'flex', gap: 4 },
  scopeBtn: {
    background: 'transparent', border: `1px solid ${C.border2}`,
    color: C.fg3, fontSize: 10, fontWeight: 600,
    padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
    textTransform: 'uppercase', letterSpacing: 0.4,
  },
  scopeBtnActive: {
    background: C.surface3, color: C.fg, borderColor: C.border,
  },
  summary: { color: C.fg3, fontSize: 10 },
  fileGroup: {
    marginBottom: 12, border: `1px solid ${C.border}`,
    borderRadius: 6, overflow: 'hidden', background: C.surface3,
  },
  fileHeader: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 8px', borderBottom: `1px solid ${C.border}`,
    background: 'rgba(0,0,0,0.15)', cursor: 'pointer',
  },
  chevron: { color: C.fg3, fontSize: 9, width: 10, flexShrink: 0, userSelect: 'none' },
  filePath: {
    flex: 1, color: C.fg, fontSize: 11.5, fontWeight: 600,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
  },
  fileCount: { color: C.fg3, fontSize: 10, flexShrink: 0 },
  iconBtn: {
    background: 'transparent', border: 'none', color: C.fg3,
    cursor: 'pointer', fontSize: 12, padding: '0 4px', flexShrink: 0,
  },
  readSection: { marginTop: 12 },
  readHeader: { color: C.fg3, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: 0.4, marginBottom: 4 },
  changeBody: { padding: 8, background: C.bg, display: 'flex', flexDirection: 'column', gap: 6 },
  changeItem: {},
  patchPre: {
    margin: 0, fontSize: 11.5, color: C.fg,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
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
    background: C.surface,
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
    padding: '13px 14px', borderBottom: `1px solid ${C.border}`,
    flexShrink: 0,
  },
  tabs: {
    display: 'flex', gap: 4,
    padding: '8px 10px',
    borderBottom: `1px solid ${C.border}`,
    flexShrink: 0, background: C.surface2,
  },
  tab: {
    flex: 1, minWidth: 0, textAlign: 'center', whiteSpace: 'nowrap',
    // Clip to ellipsis when the panel is narrow so labels never overlap.
    overflow: 'hidden', textOverflow: 'ellipsis',
    background: 'transparent', border: '1px solid transparent',
    color: C.fg3, fontSize: 11, fontWeight: 600,
    letterSpacing: 0.4, textTransform: 'uppercase',
    padding: '7px 5px', cursor: 'pointer', borderRadius: 7,
    // Persistent gray underline under every tab (visible from first open);
    // the active tab overrides the color with the accent.
    borderBottom: '1px solid transparent', marginBottom: 0,
  },
  tabActive: {
    color: C.fg, background: C.accentDim, borderColor: C.accent,
  },
  headerMeta: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  headerSubLine: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  headerTitle: {
    color: C.fg, fontSize: 12, fontWeight: 600,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%',
  },
  headerSub: { color: C.fg3, fontSize: 11, fontVariantNumeric: 'tabular-nums' },
  headerDot: { color: C.fg3, fontSize: 11, opacity: 0.5 },
  followPill: {
    background: C.accent, color: C.onAccent, border: 'none',
    borderRadius: 10, fontSize: 10, padding: '2px 8px', cursor: 'pointer',
  },
  closeBtn: {
    background: 'transparent', border: 'none', color: C.fg2,
    fontSize: 18, lineHeight: 1, padding: '0 4px', cursor: 'pointer',
  },
  body: { flex: 1, overflowY: 'auto', padding: '14px' },
  section: { marginBottom: 14 },
  sectionTitle: {
    color: C.fg3, fontSize: 10, fontWeight: 600, letterSpacing: 0.6,
    textTransform: 'uppercase', marginBottom: 6,
  },
  runTargetRow: { color: C.fg, fontSize: 12 },
  runTargetSub: { color: C.fg3, fontSize: 11, marginTop: 2 },
  emptyHint: { color: C.fg3, fontSize: 11, fontStyle: 'italic', padding: '12px 0' },
}
