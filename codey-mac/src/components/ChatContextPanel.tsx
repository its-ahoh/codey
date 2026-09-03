import React from 'react'
import type { WriteDiff, Chat, ChatMessage } from '../types'
import { C } from '../theme'
import { parseTeamMessage } from './teamMessageFormat'
import { CombinedDiffView, normalizeTool } from './toolFormat'
import { stepMatchIndex } from './diffSearch'
import { foldFileChanges, type FoldedChange } from './foldChanges'
import { buildFileTree, countChangedLines, type FileTouch, type TreeNode } from './fileTree'
import { FileCodeView } from './FileCodeView'
import { FileImageView } from './FileImageView'
import { isImageFilePath } from './fileImage'
import { parseUnifiedPatch } from './unifiedPatch'
import { parseFileChangeOutput, parseShellWriteTargets, shellCommandText } from './shellWrites'
import { pickChangeSource, type GitFileDiff } from './changeSource'
import { ToolCallList } from './ToolCallList'
import { QuickQuestionView } from './QuickQuestionView'
import { TaskHud } from './TaskHud'
import TeamRunFlow from './TeamRunFlow'
import { UIIcon } from './UIIcons'

export type ContextPanelTab = 'current' | 'task' | 'files' | 'qq'

interface Props {
  chat: Chat
  selectedTurnId: string | null
  followLatest: boolean
  /** 1-based index of the selected assistant turn. Kept for callers; unused since the turn header was removed. */
  selectedTurnIndex?: number | null
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
  /** Settings switch. Off drops the Status tab entirely. Defaults to on. */
  statusPanelEnabled?: boolean
  /** Render inside the shared right-panel shell, which owns resize and close controls. */
  embedded?: boolean
}

export const ChatContextPanel: React.FC<Props> = ({
  chat, selectedTurnId, followLatest,
  effectiveAgent, effectiveModel, workerName, teamName, teamGraph, workingDir,
  width, onFollowLatest, onClose, onResize, onRevealFile, onScrollToStep, isTurnStreaming,
  activeTab, onTabChange, qqInputRef,
  onAnswerNextAction, taskBriefLoading, onTaskTabShown,
  statusPanelEnabled = true,
  embedded = false,
}) => {
  const turn: ChatMessage | undefined = selectedTurnId
    ? chat.messages.find(m => m.id === selectedTurnId && m.role === 'assistant')
    : undefined

  const [flowOpen, setFlowOpen] = React.useState(false)

  // The user message that produced this turn — its attachments are surfaced below.
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
  const requestedTab: ContextPanelTab = activeTab ?? localTab
  // With the Status panel switched off the tab disappears; a chat left sitting
  // on it falls back to Tools rather than rendering an empty body.
  const tab: ContextPanelTab = requestedTab === 'task' && !statusPanelEnabled ? 'current' : requestedTab
  const setTab = (t: ContextPanelTab) => { if (onTabChange) onTabChange(t); else setLocalTab(t) }

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
    <div style={{ ...styles.root, width: embedded ? '100%' : width, ...(embedded ? styles.rootEmbedded : null) }}>
      {!embedded && <div style={styles.resizer} onMouseDown={onResizerMouseDown} title="Drag to resize" />}
      {/* Controls. The turn's prompt and timestamp already head the turn in the
          transcript, so repeating them here only cost vertical space. The bar
          renders only when a control needs it. */}
      {(!followLatest || !embedded) && (
        <div style={styles.header}>
          {!followLatest && (
            <button style={styles.followPill} onClick={onFollowLatest} title="Follow live updates">Follow latest ↓</button>
          )}
          {!embedded && <button style={styles.closeBtn} onClick={onClose} aria-label="Close panel">×</button>}
        </div>
      )}

      {/* Tabs */}
      <div style={styles.tabs} role="tablist">
        {statusPanelEnabled && (
          <button
            role="tab"
            aria-selected={tab === 'task'}
            style={{ ...styles.tab, ...(tab === 'task' ? styles.tabActive : null) }}
            onClick={() => setTab('task')}
          >Status</button>
        )}
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

/**
 * Files changed without a recorded diff. Agents rewrite files with `sed -i`,
 * heredocs, and redirects as often as they use Edit/Write, and codex reports
 * every edit as a `file_change` path list; none of those reach extractChanges,
 * so without this the panel reports no activity on a run that changed the
 * working tree. Git supplies the diff for these paths afterwards.
 */
type InferredWrite = { path: string; msgId: string; command: string; diffs: WriteDiff[] }

const extractShellWrites = (
  chat: Chat,
  workingDir?: string,
): InferredWrite[] => {
  const out: InferredWrite[] = []
  // One entry per file per turn, so a file written in two turns shows under
  // both when the panel is filtered to a turn.
  const byKey = new Map<string, InferredWrite>()
  const add = (path: string, msgId: string, command: string, diffs: WriteDiff[] = []) => {
    if (!path) return
    const key = `${msgId}\0${path}`
    const existing = byKey.get(key)
    if (existing) { existing.diffs.push(...diffs); return }
    const entry = { path, msgId, command, diffs: [...diffs] }
    byKey.set(key, entry)
    out.push(entry)
  }
  for (const m of chat.messages) {
    if (m.role !== 'assistant') continue
    // A shell tool_end carries the paths the gateway sampled from the working
    // tree, which catch writes the command text cannot show (an interpreter
    // heredoc, `git apply`, a Makefile). The most recent shell command is the
    // one they belong to.
    let lastCommand = ''
    for (const tc of m.toolCalls ?? []) {
      // Codex reports its own edits as a `file_change` item: a list of paths,
      // no diff text. Git supplies the diff, the same as for a shell write.
      if (tc.tool?.toLowerCase() === 'file_change') {
        if (tc.type === 'tool_end') {
          const diffs = tc.writeDiffs ?? []
          for (const path of parseFileChangeOutput(tc.output, workingDir)) {
            add(path, m.id, '', diffs.filter(d => d.path === path))
          }
          for (const d of diffs) add(d.path, m.id, '', [d])
        }
        continue
      }
      if (normalizeTool(tc.tool) !== 'Bash') continue
      if (tc.type === 'tool_start') {
        lastCommand = shellCommandText(tc.input)
        // Fallback for chats recorded before sampling existed, and for working
        // directories git cannot sample (not a repo, tree too dirty).
        for (const raw of parseShellWriteTargets(lastCommand)) {
          const path = raw.startsWith('/') || !workingDir
            ? raw
            : `${workingDir.replace(/\/$/, '')}/${raw.replace(/^\.\//, '')}`
          add(path, m.id, lastCommand)
        }
      } else if (tc.type === 'tool_end') {
        const diffs = tc.writeDiffs ?? []
        for (const path of tc.writes ?? []) add(path, m.id, lastCommand, diffs.filter(d => d.path === path))
      }
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

/** Added/removed counts of a raw unified patch, by its +/- line markers. */
const countPatchLines = (patch: string): { added: number; removed: number } => {
  let added = 0
  let removed = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

const ChangeCounts: React.FC<{ added: number; removed: number; muted?: boolean }> = ({ added, removed, muted }) => (
  <span style={{ ...treeStyles.counts, opacity: muted ? 0.7 : 1 }}>
    {added > 0 && <span style={{ color: C.green }}>+{added}</span>}
    {added > 0 && removed > 0 && ' '}
    {removed > 0 && <span style={{ color: C.red }}>−{removed}</span>}
  </span>
)

/**
 * One row of the folder tree, and its children when expanded. Folders default
 * to open when something inside them changed and closed otherwise; a click
 * flips that default for the folder.
 */
const TreeRows: React.FC<{
  nodes: TreeNode[]
  depth: number
  toggled: Set<string>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}> = ({ nodes, depth, toggled, onToggle, onOpen }) => (
  <>
    {nodes.map(node => {
      const expanded = node.isDir && node.changed !== toggled.has(node.path)
      const isNew = !node.isDir && node.touch?.kind !== 'read' && node.removed === 0 && node.added > 0
      const hasCounts = node.added > 0 || node.removed > 0
      const badge = node.touch?.kind === 'read'
        ? <span style={treeStyles.tag} title="Read by the agent">read</span>
        : hasCounts
          ? <ChangeCounts added={node.added} removed={node.removed} muted={node.isDir} />
          : null
      // Changed names are yellow (modified) or green (all new lines), the way
      // editors mark a dirty tree, so they read at a glance among grey names.
      const nameColor = node.changed ? (isNew ? C.green : C.yellow) : C.fg2
      return (
        <React.Fragment key={node.path}>
          <div
            style={{
              ...treeStyles.row,
              paddingLeft: 6 + depth * 14,
              ...(node.changed ? treeStyles.rowChanged : null),
            }}
            title={node.isDir ? node.path : `${node.path}\nClick to open`}
            onClick={() => (node.isDir ? onToggle(node.path) : onOpen(node.path))}
          >
            <span style={treeStyles.chevron}>
              {node.isDir && (
                <span style={{ ...fcStyles.chevronIcon, transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                  <UIIcon name="disclosure" size={11} />
                </span>
              )}
            </span>
            <span style={{ ...treeStyles.icon, color: node.changed ? nameColor : C.fg3 }}>
              <UIIcon name={node.isDir ? (expanded ? 'folder-open' : 'folder') : 'file'} size={13} />
            </span>
            <span style={{
              ...treeStyles.name,
              color: nameColor,
              ...(node.changed ? treeStyles.nameChanged : null),
            }}>{node.name}</span>
            {node.changed && !node.isDir && <span style={{ ...treeStyles.dot, background: nameColor }} />}
            {badge}
          </div>
          {expanded && (
            <TreeRows
              nodes={node.children}
              depth={depth + 1}
              toggled={toggled}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          )}
        </React.Fragment>
      )
    })}
  </>
)

const FileChangesView: React.FC<{
  chat: Chat
  workingDir?: string
  selectedTurnId: string | null
  onReveal: (absPath: string) => void
}> = ({ chat, workingDir, selectedTurnId, onReveal }) => {
  const changes = React.useMemo(() => extractChanges(chat), [chat])
  const reads = React.useMemo(() => extractReads(chat), [chat])
  const shellWrites = React.useMemo(() => extractShellWrites(chat, workingDir), [chat, workingDir])
  const [filter, setFilter] = React.useState<'all' | 'turn'>('all')
  // The file whose diff or code is shown under the tree.
  const [openPath, setOpenPath] = React.useState<string | null>(null)
  // Folders the user flipped away from their default open/closed state.
  const [toggled, setToggled] = React.useState<Set<string>>(() => new Set())

  // ── Search (⌘F) ───────────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  // Off: case-insensitive. On: only exactly-cased hits count.
  const [exactMatch, setExactMatch] = React.useState(false)
  // Match ids reported by the open file's diff view, in display order.
  const [matchesByPath, setMatchesByPath] = React.useState<Record<string, string[]>>({})
  const [activeIndex, setActiveIndex] = React.useState(0)
  const searchInputRef = React.useRef<HTMLInputElement>(null)

  const handleMatches = React.useCallback((idPrefix: string, ids: string[]) => {
    setMatchesByPath(prev => {
      const current = prev[idPrefix]
      if (current && current.length === ids.length && current.every((v, i) => v === ids[i])) return prev
      return { ...prev, [idPrefix]: ids }
    })
  }, [])

  const closeSearch = React.useCallback(() => {
    setSearchOpen(false)
    setQuery('')
    setMatchesByPath({})
    setActiveIndex(0)
  }, [])

  // Bumped by ⌘F so a second press re-focuses an already-open search bar.
  const [focusTick, setFocusTick] = React.useState(0)
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        setFocusTick(t => t + 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  // Esc with search closed steps back from the open file to the tree.
  React.useEffect(() => {
    if (!openPath || searchOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpenPath(null) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openPath, searchOpen])
  React.useEffect(() => {
    if (!searchOpen) return
    const input = searchInputRef.current
    input?.focus()
    // Reopening on an existing query selects it, so typing replaces it.
    input?.select()
  }, [searchOpen, focusTick])

  // Current on-disk text per file: real line numbers for each edit, and the
  // full code of files that have no diff. Loaded lazily and cached; the open
  // file is re-read whenever a new edit lands so the code view stays current.
  const [fileText, setFileText] = React.useState<Record<string, string | null>>({})
  const [fileImage, setFileImage] = React.useState<{ path: string; dataUrl: string | null } | null>(null)
  const fetchedRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    let cancelled = false
    const wanted = Array.from(new Set(changes.map(c => c.path)))
      .filter(p => p && p.startsWith('/') && !isImageFilePath(p) && !fetchedRef.current.has(p))
    if (openPath && openPath.startsWith('/') && !isImageFilePath(openPath)) {
      fetchedRef.current.delete(openPath)
      if (!wanted.includes(openPath)) wanted.push(openPath)
    }
    if (wanted.length === 0) return
    ;(async () => {
      for (const p of wanted) {
        fetchedRef.current.add(p)
        const content = (await window.codey?.readTextFile?.(p)) ?? null
        if (cancelled) return
        setFileText(prev => ({ ...prev, [p]: content }))
      }
    })()
    return () => { cancelled = true }
  }, [changes, openPath])

  // Images are loaded only when opened. Keeping them out of readTextFile avoids
  // decoding binary bytes as UTF-8, and the main process caps preview payloads.
  React.useEffect(() => {
    if (!openPath || !openPath.startsWith('/') || !isImageFilePath(openPath)) return
    let cancelled = false
    setFileImage(null)
    void window.codey?.readImageFile?.(openPath).then(dataUrl => {
      if (!cancelled) setFileImage({ path: openPath, dataUrl })
    }).catch(() => {
      if (!cancelled) setFileImage({ path: openPath, dataUrl: null })
    })
    return () => { cancelled = true }
  }, [openPath, changes.length, shellWrites.length])

  // Every file and folder in the workspace. The index is cached in the main
  // process; it is asked again after each new edit so created files appear.
  const [entries, setEntries] = React.useState<Array<{ path: string; isDir: boolean }>>([])
  React.useEffect(() => {
    if (!workingDir) { setEntries([]); return }
    let stale = false
    window.codey?.workspaceFiles?.list(workingDir).then(r => {
      if (!stale && r.ok) setEntries(r.data)
    }).catch(() => {})
    return () => { stale = true }
  }, [workingDir, changes.length, shellWrites.length])

  // Files a shell command wrote have no recorded diff, so git supplies one:
  // the working tree against HEAD (or against nothing for a new file).
  const [gitDiffs, setGitDiffs] = React.useState<Record<string, GitFileDiff>>({})
  const shellPathsKey = Array.from(new Set(shellWrites.map(w => w.path))).join('\n')
  React.useEffect(() => {
    if (!workingDir || !shellPathsKey) return
    let stale = false
    const paths = shellPathsKey.split('\n')
    window.codey?.git?.fileDiffs?.(workingDir, paths).then(r => {
      if (!stale && r.ok) setGitDiffs(r.data)
    }).catch(() => {})
    return () => { stale = true }
  }, [workingDir, shellPathsKey, changes.length])

  const visible = filter === 'turn' && selectedTurnId
    ? changes.filter(c => c.msgId === selectedTurnId)
    : changes
  const visibleReads = filter === 'turn' && selectedTurnId
    ? reads.filter(r => r.msgId === selectedTurnId)
    : reads
  const visibleShellWrites = filter === 'turn' && selectedTurnId
    ? shellWrites.filter(w => w.msgId === selectedTurnId)
    : shellWrites

  // Per file: its edits folded to the net change, plus raw patches and counts.
  const fileInfo = React.useMemo(() => {
    const byFile = new Map<string, FileChange[]>()
    for (const c of visible) {
      if (!byFile.has(c.path)) byFile.set(c.path, [])
      byFile.get(c.path)!.push(c)
    }
    const out = new Map<string, {
      group: FileChange[]
      folded: Array<FoldedChange<FileChange>>
      patches: FileChange[]
      added: number
      removed: number
    }>()
    for (const [path, group] of byFile) {
      const folded = foldFileChanges(group.filter(c => c.tool !== 'Patch'))
      const patches = group.filter(c => c.tool === 'Patch')
      const counts = countChangedLines(folded)
      for (const p of patches) {
        const pc = countPatchLines(p.patchText ?? '')
        counts.added += pc.added
        counts.removed += pc.removed
      }
      out.set(path, { group, folded, patches, ...counts })
    }
    return out
  }, [visible])

  // Recorded diffs of the visible writes, per file, in the order they landed.
  // pickChangeSource decides when these beat git's working-tree diff.
  const recordedDiffsByPath = React.useMemo(() => {
    const map = new Map<string, WriteDiff[]>()
    for (const w of visibleShellWrites) {
      if (w.diffs.length === 0) continue
      if (!map.has(w.path)) map.set(w.path, [])
      map.get(w.path)!.push(...w.diffs)
    }
    return map
  }, [visibleShellWrites])

  const touches = React.useMemo(() => {
    const map = new Map<string, FileTouch>()
    for (const [path, info] of fileInfo) {
      map.set(path, { kind: 'edit', added: info.added, removed: info.removed, edits: info.group.length })
    }
    // A recorded edit is always better than a working-tree-only diff, so
    // inferred changes and reads never override it.
    for (const w of visibleShellWrites) {
      if (map.has(w.path)) continue
      // Only mark the file as changed once real line counts exist, from the
      // recorded per-call diffs or from git. A bare path with no counts would
      // replace useful +/− data with an implementation label.
      const src = pickChangeSource(filter, recordedDiffsByPath.get(w.path), gitDiffs[w.path])
      if (src) map.set(w.path, { kind: 'change', added: src.added, removed: src.removed })
    }
    for (const r of visibleReads) if (!map.has(r.path)) map.set(r.path, { kind: 'read' })
    return map
  }, [fileInfo, visibleShellWrites, visibleReads, gitDiffs, recordedDiffsByPath, filter])

  const tree = React.useMemo(
    () => buildFileTree({ workingDir, entries, touches }),
    [workingDir, entries, touches],
  )

  const changedCount = Array.from(touches.values()).filter(t => t.kind !== 'read').length
  let totalAdded = 0
  let totalRemoved = 0
  for (const t of touches.values()) {
    if (t.kind === 'read') continue
    totalAdded += t.added ?? 0
    totalRemoved += t.removed ?? 0
  }

  const toggleDir = (path: string) => setToggled(prev => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path); else next.add(path)
    return next
  })

  // Search runs over the open file's diff.
  const allMatches = openPath ? matchesByPath[openPath] ?? [] : []
  const activeMatchIndex = allMatches.length === 0 ? 0 : Math.min(activeIndex, allMatches.length - 1)
  const activeMatchId = allMatches[activeMatchIndex] ?? null
  const goToMatch = (direction: 1 | -1) => {
    if (allMatches.length === 0) return
    setActiveIndex(stepMatchIndex(activeMatchIndex, allMatches.length, direction))
  }
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); goToMatch(e.shiftKey ? -1 : 1) }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearch() }
  }

  if (tree.root.length === 0 && tree.outside.length === 0) {
    return (
      <div style={styles.emptyHint}>
        {workingDir ? 'No files found in the workspace yet.' : 'No file activity in this chat yet.'}
      </div>
    )
  }

  const openInfo = openPath ? fileInfo.get(openPath) : undefined
  const openTouch = openPath ? touches.get(openPath) : undefined
  const openContent = openPath ? fileText[openPath] : undefined
  const openIsImage = openPath ? isImageFilePath(openPath) : false

  return (
    <div>
      {searchOpen && (
        <div style={fcStyles.searchBar}>
          <div style={fcStyles.searchField}>
            <input
              ref={searchInputRef}
              style={fcStyles.searchInput}
              value={query}
              placeholder={openInfo ? 'Search in this diff' : 'Open a changed file to search its diff'}
              aria-label="Search in file changes"
              onChange={e => { setQuery(e.target.value); setActiveIndex(0) }}
              onKeyDown={onSearchKeyDown}
            />
            <button
              style={{ ...fcStyles.searchFilterBtn, ...(exactMatch ? fcStyles.searchFilterBtnActive : null) }}
              onClick={() => { setExactMatch(v => !v); setActiveIndex(0) }}
              aria-pressed={exactMatch}
              aria-label="Exact match"
              title={exactMatch ? 'Exact match on — case-sensitive' : 'Exact match off — case-insensitive'}
            ><UIIcon name="match-case" size={13} /></button>
          </div>
          <span style={fcStyles.searchCount}>
            {!query ? '' : allMatches.length === 0 ? 'No results' : `${activeMatchIndex + 1}/${allMatches.length}`}
          </span>
          <button
            style={fcStyles.searchNavBtn}
            onClick={() => goToMatch(-1)}
            disabled={allMatches.length === 0}
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
          >↑</button>
          <button
            style={fcStyles.searchNavBtn}
            onClick={() => goToMatch(1)}
            disabled={allMatches.length === 0}
            title="Next match (Enter)"
            aria-label="Next match"
          >↓</button>
          <button
            style={fcStyles.searchNavBtn}
            onClick={closeSearch}
            title="Close search (Esc)"
            aria-label="Close search"
          >×</button>
        </div>
      )}
      <div style={fcStyles.toolbar}>
        <div style={fcStyles.scopeGroup} role="tablist">
          <button
            style={{ ...fcStyles.scopeBtn, ...(filter === 'all' ? fcStyles.scopeBtnActive : null) }}
            onClick={() => setFilter('all')}
          >All</button>
          <button
            style={{ ...fcStyles.scopeBtn, ...(filter === 'turn' ? fcStyles.scopeBtnActive : null) }}
            onClick={() => setFilter('turn')}
            disabled={!selectedTurnId}
            title={selectedTurnId ? 'Show only this turn' : 'Select a turn to filter'}
          >This turn</button>
        </div>
        <div style={fcStyles.summary}>
          {changedCount === 0
            ? 'No changes'
            : <>{changedCount} changed{(totalAdded > 0 || totalRemoved > 0) && <> · <ChangeCounts added={totalAdded} removed={totalRemoved} /></>}</>}
        </div>
      </div>

      {!openPath && (
        <div style={treeStyles.tree}>
          <TreeRows
            nodes={tree.root}
            depth={0}
            toggled={toggled}
            onToggle={toggleDir}
            onOpen={setOpenPath}
          />
          {tree.outside.length > 0 && (
            <>
              {tree.root.length > 0 && <div style={treeStyles.outsideHeader}>Outside workspace</div>}
              <TreeRows
                nodes={tree.outside}
                depth={0}
                toggled={toggled}
                onToggle={toggleDir}
                onOpen={setOpenPath}
              />
            </>
          )}
        </div>
      )}

      {openPath && (() => {
        const openSource = openTouch?.kind === 'change'
          ? pickChangeSource(filter, recordedDiffsByPath.get(openPath), gitDiffs[openPath])
          : null
        const hunks = openInfo
          ? openInfo.folded.map(c => ({
              oldText: c.oldText,
              newText: c.newText,
              startLine: locateStartLine(openContent, c.oldText, c.newText),
            }))
          : openSource
            ? openSource.patches.flatMap(p => parseUnifiedPatch(p))
            : []
        const turnDiffsTruncated = openSource?.truncated ?? false
        const counts = openTouch && openTouch.kind !== 'read'
          ? { added: openTouch.added ?? 0, removed: openTouch.removed ?? 0 }
          : null
        return (
          <div style={fcStyles.fileGroup}>
            <div style={fcStyles.fileHeader} title={openPath}>
              <button
                style={treeStyles.backBtn}
                onClick={() => setOpenPath(null)}
                title="Back to the file tree (Esc)"
                aria-label="Back to files"
              >‹ Files</button>
              <span style={fcStyles.filePath}>{displayPath(openPath, workingDir)}</span>
              {counts && (counts.added > 0 || counts.removed > 0) && (
                <ChangeCounts added={counts.added} removed={counts.removed} />
              )}
              {openInfo && (
                <span
                  style={fcStyles.fileCount}
                  title={openInfo.folded.length < openInfo.group.length
                    ? `${openInfo.group.length} edits folded into ${openInfo.folded.length} net change${openInfo.folded.length === 1 ? '' : 's'}`
                    : undefined}
                >{openInfo.group.length} edit{openInfo.group.length === 1 ? '' : 's'}</span>
              )}
              {openPath.startsWith('/') && (
                <button
                  style={fcStyles.iconBtn}
                  onClick={() => onReveal(openPath)}
                  title="Reveal in Finder"
                >⤴</button>
              )}
            </div>
            <div style={fcStyles.changeBody}>
              {openIsImage ? (
                <FileImageView
                  dataUrl={fileImage?.path === openPath ? fileImage.dataUrl : undefined}
                  filePath={openPath}
                />
              ) : openInfo || openSource ? (
                <>
                  {turnDiffsTruncated && (
                    <div style={fcStyles.noNetChange}>
                      Part of this change was too large to keep; the counts above are complete.
                    </div>
                  )}
                  {hunks.length > 0 && (
                    <CombinedDiffView
                      hunks={hunks}
                      fileContent={openContent}
                      filePath={openPath}
                      search={{ query, exact: exactMatch, idPrefix: openPath, activeId: activeMatchId, onMatches: handleMatches }}
                    />
                  )}
                  {hunks.length === 0 && !turnDiffsTruncated && (openInfo?.patches.length ?? 0) === 0 && (
                    <div style={fcStyles.noNetChange}>
                      Edits cancelled out — the file matches its original text.
                    </div>
                  )}
                  {openInfo?.patches.map(c => (
                    <pre key={`${c.msgId}::${c.callId}`} style={fcStyles.patchPre}>
                      {c.patchText || '(empty patch)'}
                    </pre>
                  ))}
                </>
              ) : (
                <>
                  {openContent === undefined && <div style={fcStyles.noNetChange}>Loading…</div>}
                  {openContent === null && (
                    <div style={fcStyles.noNetChange}>Can't show this file — missing, binary, or over 2 MB.</div>
                  )}
                  {typeof openContent === 'string' && <FileCodeView content={openContent} filePath={openPath} />}
                </>
              )}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

const treeStyles: Record<string, React.CSSProperties> = {
  tree: {
    marginBottom: 12, border: `1px solid ${C.border2}`,
    borderRadius: 8, overflow: 'hidden', background: C.surface2, padding: '4px 0',
  },
  row: {
    display: 'flex', alignItems: 'center', gap: 5,
    minHeight: 24, paddingRight: 8, cursor: 'pointer', userSelect: 'none',
    borderLeft: '3px solid transparent',
  },
  rowChanged: {
    background: `color-mix(in srgb, ${C.yellow} 10%, transparent)`,
    borderLeftColor: C.yellow,
  },
  chevron: {
    color: C.fg2, width: 12, height: 16, flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  icon: { display: 'inline-flex', alignItems: 'center', flexShrink: 0 },
  name: {
    flex: 1, minWidth: 0, fontSize: 11.5,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  nameChanged: { fontWeight: 700 },
  dot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 },
  counts: {
    flexShrink: 0, fontSize: 10.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  },
  tag: {
    flexShrink: 0, color: C.fg2, background: C.surface3, border: `1px solid ${C.border2}`,
    borderRadius: 999, fontSize: 9, fontWeight: 600, padding: '1px 6px',
    textTransform: 'uppercase', letterSpacing: 0.4,
  },
  outsideHeader: {
    color: C.fg3, fontSize: 10, fontWeight: 650, textTransform: 'uppercase', letterSpacing: 0.5,
    padding: '8px 8px 2px', borderTop: `1px solid ${C.border}`, marginTop: 4,
  },
  backBtn: {
    background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: 6,
    color: C.accent, fontSize: 11, fontWeight: 650, padding: '2px 8px', cursor: 'pointer', flexShrink: 0,
  },
}

const fcStyles: Record<string, React.CSSProperties> = {
  toolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 10, marginBottom: 12,
  },
  // Sticky so the bar and its match counter stay reachable while the list
  // scrolls to the current hit. -14 cancels the panel body's top padding.
  searchBar: {
    position: 'sticky', top: -14, zIndex: 6,
    display: 'flex', alignItems: 'center', gap: 4,
    margin: '-14px -14px 10px', padding: '10px 14px',
    background: C.surface2, borderBottom: `1px solid ${C.border}`,
  },
  // The field owns the border so the match-case toggle can sit inside it,
  // flush against the right edge.
  searchField: {
    flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 2,
    background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 6,
    padding: '0 3px 0 0',
  },
  searchInput: {
    flex: 1, minWidth: 0,
    background: 'transparent', border: 'none',
    color: C.fg, fontSize: 11.5, padding: '4px 7px', outline: 'none',
  },
  searchFilterBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 20, height: 18, padding: 0, flexShrink: 0, borderRadius: 4,
    background: 'transparent', border: '1px solid transparent',
    color: C.fg3, cursor: 'pointer',
  },
  searchFilterBtnActive: { background: C.accentDim, borderColor: C.accent, color: C.fg },
  searchCount: {
    color: C.fg3, fontSize: 10.5, fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  searchNavBtn: {
    background: 'transparent', border: 'none', color: C.fg2,
    cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '3px 5px', flexShrink: 0,
  },
  scopeGroup: { display: 'flex', gap: 4 },
  scopeBtn: {
    background: C.surface2, border: `1px solid ${C.border2}`,
    color: C.fg2, fontSize: 10, fontWeight: 650,
    padding: '4px 9px', borderRadius: 6, cursor: 'pointer',
    textTransform: 'uppercase', letterSpacing: 0.4,
  },
  scopeBtnActive: {
    background: C.accentDim, color: C.fg, borderColor: C.accent,
  },
  summary: { color: C.fg2, fontSize: 10.5, fontWeight: 500, textAlign: 'right' },
  fileGroup: {
    marginBottom: 12, border: `1px solid ${C.border2}`,
    borderRadius: 8, overflow: 'hidden', background: C.surface2,
    boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
  },
  fileHeader: {
    display: 'flex', alignItems: 'center', gap: 6,
    minHeight: 34, padding: '6px 9px', borderBottom: `1px solid ${C.border}`,
    background: C.surface3, cursor: 'pointer',
  },
  chevron: {
    color: C.fg2, width: 14, height: 16, flexShrink: 0, userSelect: 'none',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  chevronIcon: {
    width: 12, height: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    transformOrigin: 'center', transition: 'transform 0.15s ease',
  },
  filePath: {
    flex: 1, color: C.fg, fontSize: 11.5, fontWeight: 600,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
  },
  fileCount: {
    color: C.fg2, background: C.surface2, border: `1px solid ${C.border2}`,
    borderRadius: 999, fontSize: 9.5, fontWeight: 600, padding: '2px 6px', flexShrink: 0,
  },
  iconBtn: {
    background: 'transparent', border: 'none', color: C.fg3,
    cursor: 'pointer', fontSize: 12, padding: '0 4px', flexShrink: 0,
  },
  readSection: {
    marginTop: 14, padding: '10px', background: C.surface2,
    border: `1px solid ${C.border}`, borderRadius: 8,
  },
  readHeader: { color: C.fg2, fontSize: 10, fontWeight: 650, textTransform: 'uppercase' as const, letterSpacing: 0.5, marginBottom: 6 },
  changeBody: { padding: 9, background: C.bg, display: 'flex', flexDirection: 'column', gap: 7 },
  noNetChange: { color: C.fg3, fontSize: 11, fontStyle: 'italic' },
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
    background: C.surface2,
    borderLeft: `1px solid ${C.border2}`,
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
  },
  rootEmbedded: { borderLeft: 'none' },
  resizer: {
    position: 'absolute',
    left: -3, top: 0, bottom: 0, width: 6,
    cursor: 'col-resize',
    zIndex: 5,
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
    padding: '8px 14px', borderBottom: `1px solid ${C.border}`,
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
    color: C.fg, background: C.accentDim,
  },
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
