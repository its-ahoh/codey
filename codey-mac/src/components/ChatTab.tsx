import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, ChatSelection, FileAttachment, TeamRunSummary } from '../types'
import { apiService, WorkerDto } from '../services/api'
import { useChats } from '../hooks/useChats'
import { C } from '../theme'
import { Markdown } from './Markdown'
import { PairingModal } from './PairingModal'
import { consumePendingPairing } from './pendingPairing'
import { ChatContextPanel } from './ChatContextPanel'
import type { ContextPanelTab } from './ChatContextPanel'
import { useQuickQuestion } from '../hooks/useQuickQuestion'
import { extractPreview, parseTeamMessage } from './teamMessageFormat'
import { groupMessages } from './teamGroup'
import type { RenderItem } from './teamGroup'
import { StatusSidecar } from './StatusSidecar'
import { isTaskBriefStale, extractSidecarBrief } from './taskHudView'
import { onTeamsChanged } from './teamsChanged'
import { formatHeadline, normalizeTool, ToolDetail, hasDetail } from './toolFormat'
import { defaultThinkingExpanded } from './thinkingState'
import { formatTokens } from './turnHeaderModel'
import {
  TurnHeader, MESSAGE_ROW_INSET, TURN_RAIL_WIDTH, TURN_TEXT_PADDING, TURN_TEXT_INSET,
  USER_BUBBLE_PADDING_X,
} from './TurnHeader'
import { ACTIVITY_LABEL } from './agentActivity'
import { statusLine } from './checklistView'
import { composerPlaceholder } from './coreOfflineView'
import { getDraft, setDraft } from './chatDrafts'
import { useGitStatus } from '../hooks/useGitStatus'
import { BranchPicker } from './BranchPicker'
import { CreatePrModal } from './CreatePrModal'
import { UIIcon } from './UIIcons'
import { chatInputHistory, moveInInputHistory } from './chatInputHistory'
import vscodeLogo from '../assets/editors/vscode.svg'
import cursorLogo from '../assets/editors/cursor.svg'
import xcodeLogo from '../assets/editors/xcode.svg'
import type { BrowserLoginWaitEvent } from '../codey-api'
import { WorkspaceDock, type WorkspaceDockTool } from './WorkspaceDock'
import { TerminalPanel } from './TerminalPanel'
import { splitWhiteboardMarkers, type WhiteboardMarker } from './teamWhiteboardFormat'
import { groupTeamMessagesByMember, type TeamMemberMessageGroup } from './teamRunModel'
import { ToolCallList } from './ToolCallList'
import { useChatVoice } from './useChatVoice'
import { VoiceMeter } from './VoiceMeter'

const EDITOR_LOGOS: Partial<Record<string, string>> = {
  vscode: vscodeLogo,
  cursor: cursorLogo,
  xcode: xcodeLogo,
}

const STATUS_SIDECAR_HIDDEN_KEY = 'codey.statusSidecarHidden'
const VOICE_GRADIENT_COLORS = ['#ff5f6d', '#ffc371', '#47e6b1', '#38a3f5', '#a86bf5']

interface Props {
  chatId: string
  isGatewayRunning: boolean
  coreFailed?: boolean
  rightPanelMode: WorkspaceDockTool | null
  onRightPanelModeChange: (mode: WorkspaceDockTool | null) => void
  rightPanelWidth: number
  onRightPanelResize: (width: number) => void
  browserLoginWait?: BrowserLoginWaitEvent | null
  onConfirmBrowserLogin?: (event: BrowserLoginWaitEvent) => void
  onDismissBrowserLogin?: () => void
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

/** The live status word ("Thinking", "Reading", …). The motion is a light
 *  sweeping across the letters — no marching dots beside it, so the word alone
 *  carries "still running" without pulling the eye off the transcript. */
const ShimmerStatus: React.FC<{ label: string }> = ({ label }) => (
  <>
    <style>{`
      @keyframes codey-status-shimmer {
        0%   { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .codey-status-shimmer { animation: none !important; }
      }
    `}</style>
    <span
      className="codey-status-shimmer"
      aria-live="polite"
      style={{
        backgroundImage: `linear-gradient(90deg, ${C.fg3} 0%, ${C.fg3} 35%, ${C.fg} 50%, ${C.fg3} 65%, ${C.fg3} 100%)`,
        backgroundSize: '200% 100%',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
        WebkitTextFillColor: 'transparent',
        animation: 'codey-status-shimmer 2s linear infinite',
        fontWeight: 600,
      }}
    >
      {label}
    </span>
  </>
)

/** Elapsed recording time. A counter answers "is it still listening?" without
 *  a sentence of prose, and reassures during a long dictation. */
const VoiceElapsed: React.FC<{ since: number }> = ({ since }) => {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [since])
  const total = Math.max(0, Math.floor((now - since) / 1000))
  const mm = Math.floor(total / 60)
  const ss = String(total % 60).padStart(2, '0')
  return <span style={styles.voiceStatusText}>{mm}:{ss}</span>
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

const PanelRightIcon: React.FC<{ color: string; size?: number; filled?: boolean }> = ({ color, size = 14, filled }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="15" y1="3" x2="15" y2="21" />
    {filled && <rect x="15" y="3" width="6" height="18" rx="0" fill={color} stroke="none" />}
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

// A long user message is folded into a small preview by default; the user can
// expand it on demand so the transcript isn't dominated by one big paste.
const USER_MSG_COLLAPSE_CHARS = 600
const USER_MSG_COLLAPSE_LINES = 12

const UserMessageContent: React.FC<{ content: string }> = ({ content }) => {
  const lineCount = content.split('\n').length
  const isLong = content.length > USER_MSG_COLLAPSE_CHARS || lineCount > USER_MSG_COLLAPSE_LINES
  const [expanded, setExpanded] = useState(false)

  if (!isLong) return <Markdown variant="user">{content}</Markdown>

  if (expanded) {
    return (
      <div>
        <Markdown variant="user">{content}</Markdown>
        <div style={userFoldStyles.lessRow}>
          <button style={userFoldStyles.btn} onClick={() => setExpanded(false)}>Show less ▲</button>
        </div>
      </div>
    )
  }

  return (
    <div style={userFoldStyles.wrap}>
      <div style={userFoldStyles.clamp}>
        <Markdown variant="user">{content}</Markdown>
      </div>
      <div style={userFoldStyles.fade}>
        <button style={userFoldStyles.btn} onClick={() => setExpanded(true)} title={`${lineCount} lines · ${content.length.toLocaleString()} chars`}>
          Show more ▾
        </button>
      </div>
    </div>
  )
}

const userFoldStyles: Record<string, React.CSSProperties> = {
  wrap: { position: 'relative' },
  // Clamp the real message to a few lines; the fade block below hides the cut.
  clamp: { maxHeight: '7.5em', overflow: 'hidden' },
  // A short gradient block at the bottom that fades into the bubble and holds
  // the unfold button. The gradient ignores clicks; the button takes them.
  fade: {
    position: 'absolute', left: 0, right: 0, bottom: 0, height: 44,
    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    background: `linear-gradient(to bottom, transparent, ${C.userBg})`,
    pointerEvents: 'none',
  },
  // Center the "Show less" button to match the centered "Show more" above.
  lessRow: { display: 'flex', justifyContent: 'center', marginTop: 6 },
  btn: {
    pointerEvents: 'auto', background: 'rgba(255,255,255,0.18)', border: 'none',
    color: C.onAccent, fontSize: 11, fontWeight: 600,
    padding: '2px 10px', borderRadius: 8, cursor: 'pointer',
    backdropFilter: 'blur(2px)',
  },
}

// Agents that the gateway supports. Mirror of AGENT_NAMES in SettingsTab — kept
// local so the chat header doesn't depend on the settings module.
const AGENT_NAMES = ['claude-code', 'opencode', 'codex'] as const
const AGENT_API_TYPE: Record<string, 'anthropic' | 'openai'> = {
  'claude-code': 'anthropic',
  'opencode': 'openai',
  'codex': 'openai',
}
type ModelEntry = { apiType: 'anthropic' | 'openai'; model: string }

const LiveActivity: React.FC<{ toolCalls?: import('../types').ToolCallEntry[] }> = ({ toolCalls }) => {
  const [expanded, setExpanded] = useState(false)
  if (!toolCalls || toolCalls.length === 0) return null
  const pending = new Map<string, { id: string; tool?: string; input?: Record<string, unknown> }>()
  let lastDone: { tool?: string; input?: Record<string, unknown>; output?: string } | null = null
  for (const tc of toolCalls) {
    if (tc.type === 'tool_start') {
      pending.set(normalizeTool(tc.tool), { id: tc.id, tool: tc.tool, input: tc.input })
    } else if (tc.type === 'tool_end') {
      const key = normalizeTool(tc.tool)
      const p = pending.get(key)
      if (p) { lastDone = { tool: p.tool, input: p.input, output: tc.output }; pending.delete(key) }
      else { lastDone = { tool: tc.tool, output: tc.output } }
    }
  }
  const active = pending.size > 0 ? Array.from(pending.values()).pop()! : null
  const target = active ?? lastDone
  if (!target) return null
  const headline = formatHeadline(target.tool, target.input ?? {})
  const detailTarget = active
    ? { tool: active.tool, input: active.input ?? {}, output: undefined as string | undefined }
    : lastDone
      ? { tool: lastDone.tool, input: lastDone.input ?? {}, output: lastDone.output }
      : null
  const canExpand = !!detailTarget && hasDetail(detailTarget.tool, detailTarget.input, detailTarget.output)
  return (
    <div>
      <div
        style={{ ...styles.liveActivity, cursor: canExpand ? 'pointer' : 'default' }}
        onClick={canExpand ? () => setExpanded(v => !v) : undefined}
      >
        <span style={styles.liveActivityDot}>{active ? (expanded ? '▾' : '●') : canExpand ? (expanded ? '▾' : '▸') : '○'}</span>
        <span>{headline}</span>
      </div>
      {expanded && canExpand && detailTarget && (
        <div style={styles.liveActivityDetail}>
          <ToolDetail rawTool={detailTarget.tool} input={detailTarget.input} output={detailTarget.output} />
        </div>
      )}
    </div>
  )
}

const ThinkingBlock: React.FC<{
  thinking: string
  hasAnswer: boolean
  isComplete: boolean
}> = ({ thinking, hasAnswer, isComplete }) => {
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  if (!thinking.trim()) return null
  const expanded = userToggled ?? defaultThinkingExpanded({ hasAnswer, isComplete })
  return (
    <div>
      <div style={styles.thinkingToggle} onClick={() => setUserToggled(!expanded)}>
        <span style={{ ...styles.teamStepChevron, transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
        <span>{expanded ? 'Hide thinking' : 'Show thinking'}</span>
      </div>
      {expanded && (
        <div style={styles.thinkingBody}>{thinking}</div>
      )}
    </div>
  )
}

const stepDomId = (messageId: string, stepNum: number) => `step-${messageId}-${stepNum}`

// Keep the avatar stable across runs without requiring every existing worker
// config to be migrated. More specific role words win; unknown roles use the
// coding avatar as a neutral fallback.
const workerAvatar = (worker: string): string => {
  const name = worker.toLowerCase()
  const hasRole = (roles: string) => new RegExp(`(^|[-_\\s])(?:${roles})(?=$|[-_\\s])`).test(name)
  if (hasRole('product|project|manager|advisor|lead')) return '🧑‍💼'
  if (hasRole('design|designer|ux|ui|creative')) return '🎨'
  if (hasRole('review|reviewer|qa|quality|test|tester|audit|auditor')) return '🕵️'
  if (hasRole('research|researcher|analyst|data')) return '🔎'
  if (hasRole('writer|content|docs|documentation')) return '✍️'
  if (hasRole('security|risk')) return '🛡️'
  return '🧑‍💻'
}

const markerLabel = (marker: WhiteboardMarker): string => {
  if (marker.kind === 'decision') return 'Decision'
  if (marker.kind === 'fact') return 'Fact'
  if (marker.kind === 'open') return 'Open question'
  return marker.to ? `Handoff → ${marker.to}` : 'Handoff'
}

/** Render the marker protocol as a real whiteboard instead of leaking raw
 * `[FACT]` / `[DECISION]` lines into a worker's answer. */
const TeamWorkerContent: React.FC<{ content: string }> = ({ content }) => {
  const { stripped, markers } = splitWhiteboardMarkers(content)
  return (
    <>
      {stripped && <Markdown variant="assistant">{stripped}</Markdown>}
      {markers.length > 0 && (
        <div style={styles.whiteboard}>
          <div style={styles.whiteboardTitle}>Whiteboard updates</div>
          {markers.map((marker, index) => (
            <div key={`${marker.kind}-${index}`} style={styles.whiteboardRow}>
              <span style={{
                ...styles.whiteboardBadge,
                ...(marker.kind === 'decision' ? styles.whiteboardBadgeDecision
                  : marker.kind === 'open' ? styles.whiteboardBadgeOpen
                    : marker.kind === 'handoff' ? styles.whiteboardBadgeHandoff
                      : undefined),
              }}>{markerLabel(marker)}</span>
              <span style={styles.whiteboardText}>{marker.text}</span>
            </div>
          ))}
        </div>
      )}
      {!stripped && markers.length === 0 && <Markdown variant="assistant">…</Markdown>}
    </>
  )
}

const TeamRunFooter: React.FC<{ content: string }> = ({ content }) => {
  const blackboardMatch = /###\s+(?:🧠\s*)?Team blackboard/i.exec(content)
  const markerIndex = blackboardMatch?.index ?? -1
  let summary = markerIndex >= 0 ? content.slice(0, markerIndex).replace(/\n*-{3,}\s*$/, '').trim() : content.trim()
  const whiteboard = markerIndex >= 0 ? content.slice(markerIndex + (blackboardMatch?.[0].length ?? 0)).trim() : ''
  // Sequential/graph footers repeat every worker output. Those outputs already
  // have their own cards, so retain only the formatted whiteboard here.
  if (/^📊 Team \*\*.+?\*\* (?:flow )?results/.test(summary)) summary = ''
  if (!summary && !whiteboard) return null
  return (
    <div style={styles.teamRunFooter}>
      {summary && <div style={styles.teamRunSummary}><Markdown variant="assistant">{summary}</Markdown></div>}
      {whiteboard && (
        <div style={styles.whiteboard}>
          <div style={styles.whiteboardTitle}>Team whiteboard</div>
          <Markdown variant="assistant">{whiteboard}</Markdown>
        </div>
      )}
    </div>
  )
}

type TeamWhiteboardEntry = WhiteboardMarker & { worker: string; step?: number }

const TeamWhiteboardPanel: React.FC<{ workerMessages: ChatMessage[]; footerMessages: ChatMessage[]; onClose?: () => void }> = ({ workerMessages, footerMessages, onClose }) => {
  const entries: TeamWhiteboardEntry[] = []
  const seen = new Set<string>()
  let sharedNotes = ''
  const addMarkers = (markers: WhiteboardMarker[], worker: string, step?: number) => {
    for (const marker of markers) {
      const key = `${marker.kind}\u0000${marker.to ?? ''}\u0000${marker.text}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({ ...marker, worker, step })
    }
  }

  for (const message of workerMessages) {
    addMarkers(splitWhiteboardMarkers(message.content).markers, message.worker ?? 'Team', message.step)
  }
  for (const message of footerMessages) {
    const match = /###\s+(?:🧠\s*)?Team blackboard/i.exec(message.content)
    if (!match) continue
    const board = message.content.slice(match.index + match[0].length).trim()
    const parsed = splitWhiteboardMarkers(board)
    addMarkers(parsed.markers, 'Team')
    if (parsed.stripped) sharedNotes = [sharedNotes, parsed.stripped].filter(Boolean).join('\n\n')
  }

  return (
    <div style={styles.teamWhiteboardPanel}>
      <div style={styles.teamWhiteboardPanelHead}>
        <div style={styles.teamWhiteboardPanelIdentity}>
          <span style={styles.whiteboardTitle}>Team whiteboard</span>
          <span style={styles.teamHistoryCount}>{entries.length} update{entries.length === 1 ? '' : 's'}</span>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close whiteboard" title="Close" style={styles.teamWhiteboardCloseButton}>
            <UIIcon name="close" size={14} />
          </button>
        )}
      </div>
      {entries.map((entry, index) => (
        <div key={`${entry.kind}-${entry.worker}-${entry.step ?? 0}-${index}`} style={styles.teamWhiteboardEntry}>
          <span style={{
            ...styles.whiteboardBadge,
            ...(entry.kind === 'decision' ? styles.whiteboardBadgeDecision
              : entry.kind === 'open' ? styles.whiteboardBadgeOpen
                : entry.kind === 'handoff' ? styles.whiteboardBadgeHandoff
                  : undefined),
          }}>{markerLabel(entry)}</span>
          <div style={styles.teamWhiteboardEntryCopy}>
            <div style={styles.whiteboardText}>{entry.text}</div>
            <div style={styles.teamWhiteboardSource}>
              {entry.worker}{entry.step != null ? ` · Round ${entry.step}` : ''}
            </div>
          </div>
        </div>
      ))}
      {sharedNotes && <div style={styles.teamWhiteboardShared}><Markdown variant="assistant">{sharedNotes}</Markdown></div>}
      {entries.length === 0 && !sharedNotes && (
        <div style={styles.teamWhiteboardEmpty}>No whiteboard updates yet.</div>
      )}
    </div>
  )
}

const TeamWhiteboardModal: React.FC<{
  workerMessages: ChatMessage[]
  footerMessages: ChatMessage[]
  onClose: () => void
}> = ({ workerMessages, footerMessages, onClose }) => {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [onClose])

  return (
    <div style={styles.teamWhiteboardModalBackdrop} onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Team whiteboard"
        style={styles.teamWhiteboardModal}
        onMouseDown={event => event.stopPropagation()}
      >
        <TeamWhiteboardPanel workerMessages={workerMessages} footerMessages={footerMessages} onClose={onClose} />
      </div>
    </div>
  )
}

const TeamSummaryPanel: React.FC<{ summary?: TeamRunSummary }> = ({ summary }) => {
  if (!summary) {
    return (
      <div style={styles.teamSummaryPanel}>
        <div style={styles.teamSummaryMuted}>Final summary will be available when the team finishes.</div>
      </div>
    )
  }

  return (
    <div style={styles.teamSummaryPanel}>
      <div style={styles.teamSummarySection}>
        <div style={styles.teamSummarySectionTitle}>Completed</div>
        {summary.completed.length > 0 ? (
          <ul style={styles.teamSummaryList}>
            {summary.completed.map((item, index) => <li key={index} style={styles.teamSummaryListItem}>{item.text}</li>)}
          </ul>
        ) : (
          <div style={styles.teamSummaryMuted}>No completed outcome was recorded</div>
        )}
      </div>

      {summary.failures.length > 0 && (
        <div style={styles.teamSummarySection}>
          <div style={{ ...styles.teamSummarySectionTitle, color: C.red }}>Problems</div>
          <ul style={styles.teamSummaryList}>
            {summary.failures.map((item, index) => <li key={index} style={styles.teamSummaryListItem}>{item.text}</li>)}
          </ul>
        </div>
      )}

      <div style={styles.teamSummarySection}>
        <div style={styles.teamSummarySectionTitle}>Next for you</div>
        {summary.nextUserActions.length > 0 ? (
          <ul style={styles.teamSummaryList}>
            {summary.nextUserActions.map((item, index) => <li key={index} style={styles.teamSummaryListItem}>{item.text}</li>)}
          </ul>
        ) : <div style={styles.teamSummaryMuted}>No user action required</div>}
      </div>
    </div>
  )
}

const groupPreview = (group: TeamMemberMessageGroup): string => {
  const visible = splitWhiteboardMarkers(group.latest.content).stripped
  return group.status === 'running' && !visible ? 'Working…' : extractPreview(visible || group.latest.content)
}

const TeamRoundDetail: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const tokenText = message.tokens != null ? formatTokens(message.tokens) : null
  const durationText = message.durationSec != null && Number.isFinite(message.durationSec) ? `${message.durationSec}s` : null
  return (
    <div style={styles.teamInlineRunDetail} onClick={event => event.stopPropagation()}>
      {message.advisorReason && (
        <div style={styles.teamInlineRunSection}>
          <div style={styles.teamInlineRunLabel}>Assigned task</div>
          <div style={styles.teamInlineRunReason}>{message.advisorReason}</div>
        </div>
      )}
      {message.thinking && (
        <div style={styles.teamInlineRunSection}>
          <ThinkingBlock
            thinking={message.thinking}
            hasAnswer={!!message.content.trim()}
            isComplete={message.isComplete !== false}
          />
        </div>
      )}
      {!!message.toolCalls?.length && (
        <div style={styles.teamInlineRunSection}>
          <div style={styles.teamInlineRunLabel}>Execution</div>
          <ToolCallList toolCalls={message.toolCalls} minimal />
        </div>
      )}
      <div style={styles.teamInlineRunSection}>
        <div style={styles.teamInlineRunLabel}>Output</div>
        <TeamWorkerContent content={message.content} />
      </div>
      {(tokenText || durationText) && (
        <div style={styles.teamInlineRunMeta}>
          {tokenText && `${tokenText} tok`}
          {tokenText && durationText && ' · '}
          {durationText}
        </div>
      )}
    </div>
  )
}

const TeamSpatialStage: React.FC<{
  mode: Extract<RenderItem, { kind: 'team' }>['teamMode']
  groups: TeamMemberMessageGroup[]
  rounds: ChatMessage[]
  totalRounds: number
  isStreaming: boolean
  expandedRounds: Map<string, boolean>
  onToggleRound: (message: ChatMessage) => void
  onSetAllRounds: (expanded: boolean) => void
}> = ({ mode, groups, rounds, totalRounds, isStreaming, expandedRounds, onToggleRound, onSetAllRounds }) => {
  const isRoundTable = mode === 'auto' || mode === 'parallel'
  if (groups.length === 0) return null

  const stageHeader = (title: string) => (
    <div style={styles.teamSpatialHeader}>
      <div style={styles.teamSpatialTitle}>{title}</div>
      <div style={styles.teamOverviewActions}>
        <button type="button" style={styles.teamGraphActionButton} onClick={() => onSetAllRounds(true)}>Expand all</button>
        <button type="button" style={styles.teamGraphActionButton} onClick={() => onSetAllRounds(false)}>Collapse all</button>
      </div>
    </div>
  )

  if (isRoundTable) {
    const workingCount = groups.filter(group => group.status === 'running').length
    return (
      <div style={styles.teamSpatialStage}>
        {stageHeader(`Round table · Round ${totalRounds}`)}
        <div style={styles.teamRoundTableSpace}>
          <div style={styles.teamRoundTableCenter}>
            <span style={styles.teamRoundTableCenterTitle}>{mode === 'parallel' ? 'Parallel room' : 'Auto team'}</span>
            <span style={styles.teamRoundTableCenterSub}>{workingCount > 0 ? `${workingCount} working` : `${groups.length} members`}</span>
          </div>
          {groups.map((group, index) => {
            const angle = (-Math.PI / 2) + (index * Math.PI * 2 / groups.length)
            const left = 50 + Math.cos(angle) * 37
            const top = 50 + Math.sin(angle) * 38
            const active = isStreaming && group.status === 'running'
            return (
              <div
                key={group.worker}
                style={{ ...styles.teamRoundTableMember, left: `${left}%`, top: `${top}%`, ...(active ? styles.teamRoundTableMemberActive : undefined) }}
                role="button"
                tabIndex={0}
                aria-expanded={expandedRounds.get(group.latest.id) ?? false}
                onClick={() => onToggleRound(group.latest)}
                onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggleRound(group.latest) } }}
              >
                <span style={styles.teamSpatialAvatar} aria-label={`${group.worker} avatar`}>
                  {workerAvatar(group.worker)}
                  <span style={{
                    ...styles.teamSpatialStatus,
                    background: group.status === 'failed' ? C.red : group.status === 'askedUser' ? C.yellow : active ? C.accent : C.green,
                    boxShadow: active ? `0 0 7px ${C.accent}` : 'none',
                  }} />
                </span>
                <div style={styles.teamSpatialMemberCopy}>
                  <div style={styles.teamSpatialMemberName}>{group.worker}</div>
                  <div style={styles.teamSpatialSpeech}>{groupPreview(group)}</div>
                </div>
              </div>
            )
          })}
        </div>
        {groups.filter(group => expandedRounds.get(group.latest.id)).map(group => (
          <div key={group.latest.id} style={styles.teamRoundTableDetail}>
            <div style={styles.teamWorkflowCardHead}>
              <span style={styles.teamSpatialAvatar} aria-label={`${group.worker} avatar`}>{workerAvatar(group.worker)}</span>
              <span style={styles.teamSpatialMemberName}>{group.worker}</span>
              <span style={styles.teamMemberRoundsLabel}>Round {group.latest.step}</span>
            </div>
            <TeamRoundDetail message={group.latest} />
          </div>
        ))}
      </div>
    )
  }

  const workflowRounds = [...rounds].sort((a, b) => (a.step ?? 0) - (b.step ?? 0))

  return (
    <div style={styles.teamSpatialStage}>
      {stageHeader(`${mode === 'graph' ? 'Flow progress' : 'Sequential workflow'} · ${totalRounds} rounds`)}
      <div style={styles.teamWorkflow}>
        {workflowRounds.map((message, index) => {
          const active = isStreaming && message.workerStatus === 'running'
          const visible = splitWhiteboardMarkers(message.content).stripped
          const preview = active && !visible ? 'Working…' : extractPreview(visible || message.content)
          const expanded = expandedRounds.get(message.id) ?? active
          return (
            <div
              key={message.id}
              style={styles.teamWorkflowStage}
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              onClick={() => onToggleRound(message)}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggleRound(message) } }}
            >
              {index < workflowRounds.length - 1 && <span style={styles.teamWorkflowLine} />}
              <span style={{ ...styles.teamWorkflowIndex, ...(active ? styles.teamWorkflowIndexActive : undefined) }}>{message.step ?? index + 1}</span>
              <span style={styles.teamSpatialAvatar} aria-label={`${message.worker} avatar`}>
                {workerAvatar(message.worker ?? '')}
                <span style={{
                  ...styles.teamSpatialStatus,
                  background: message.workerStatus === 'failed' ? C.red : message.workerStatus === 'askedUser' ? C.yellow : active ? C.accent : C.green,
                  boxShadow: active ? `0 0 7px ${C.accent}` : 'none',
                }} />
              </span>
              <div style={styles.teamWorkflowColumn}>
                <div style={{ ...styles.teamWorkflowCard, ...(active ? styles.teamWorkflowCardActive : undefined) }}>
                  <div style={styles.teamWorkflowCardHead}>
                    <span style={{ ...styles.teamStepChevron, transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                    <span style={styles.teamSpatialMemberName}>{message.worker}</span>
                    <span style={styles.teamMemberRoundsLabel}>Round {message.step ?? index + 1}</span>
                    {message.model && <span style={styles.modelBadge}>{message.model}</span>}
                    {active && <span style={styles.teamStepRunning}>working</span>}
                  </div>
                  {!expanded && <div style={styles.teamWorkflowSpeech}>{preview}</div>}
                </div>
                {expanded && <TeamRoundDetail message={message} />}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const TeamMessage: React.FC<{
  messageId: string
  parsed: NonNullable<ReturnType<typeof parseTeamMessage>>
  isStreaming: boolean
  isComplete: boolean
  thinkingByStep?: Record<number, string>
  expanded: Set<string>
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>
}> = ({ messageId, parsed, isStreaming, isComplete, thinkingByStep, expanded, setExpanded }) => {
  const lastIdx = parsed.steps.length - 1
  return (
    <div>
      {parsed.summary && (
        <div style={styles.teamSummary}>🧭 {parsed.summary}</div>
      )}
      {parsed.steps.map((s, i) => {
        const baseKey = `${messageId}::${s.step}`
        const bodyKey = `${baseKey}::body`
        const isLastDuringStream = isStreaming && i === lastIdx
        const cardStyle = isLastDuringStream
          ? { ...styles.teamStepCard, ...styles.teamStepCardActive }
          : styles.teamStepCard
        return (
          <div key={baseKey} id={stepDomId(messageId, s.step)} style={cardStyle}>
            <div style={styles.teamStepHeader}>
              <span style={styles.teamStepLabel}>Step {s.step}: {s.worker}</span>
              {isLastDuringStream && <span style={styles.teamStepRunning}>● running</span>}
            </div>
            <div style={styles.teamStepBody}>
              {isLastDuringStream ? (
                <Markdown variant="assistant">{s.output || '…'}</Markdown>
              ) : (
                <div>
                  {thinkingByStep?.[s.step] && (
                    <ThinkingBlock
                      thinking={thinkingByStep[s.step]}
                      hasAnswer={!!s.output.trim()}
                      isComplete={isComplete}
                    />
                  )}
                  <Markdown variant="assistant">{s.output}</Markdown>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const TeamRunGroup: React.FC<{
  item: Extract<RenderItem, { kind: 'team' }>
  isStreaming: boolean
}> = ({ item, isStreaming }) => {
  const [collapsed, setCollapsed] = React.useState(false)
  const [summaryOpen, setSummaryOpen] = React.useState(false)
  const [whiteboardOpen, setWhiteboardOpen] = React.useState(false)
  const [roundExpansion, setRoundExpansion] = React.useState<Map<string, boolean>>(new Map())
  const workerMessages = item.messages.filter(m => !!m.worker)
  const memberGroups = groupTeamMessagesByMember(workerMessages)
  const footerMessages = item.messages.filter(m => !m.worker && !!m.content.trim())
  const finalSummary = [...item.messages].reverse().find(message => message.teamSummary)?.teamSummary
  const completedCount = workerMessages.filter(m => m.workerStatus && m.workerStatus !== 'running').length
  const failedCount = workerMessages.filter(m => m.workerStatus === 'failed').length
  const activeCount = workerMessages.filter(m => m.workerStatus === 'running').length
  const modeLabel = item.teamMode === 'auto'
    ? 'Auto'
    : item.teamMode === 'parallel'
      ? 'Parallel'
      : 'Sequential'
  const toggleRound = (message: ChatMessage) => setRoundExpansion(current => {
    const next = new Map(current)
    next.set(message.id, !(current.get(message.id) ?? (isStreaming && message.workerStatus === 'running')))
    return next
  })
  const setAllRounds = (expanded: boolean) => {
    setRoundExpansion(new Map(workerMessages.map(message => [message.id, expanded])))
  }
  return (
    <div style={styles.teamGroup}>
      <div style={styles.teamGroupHeader} onClick={() => setCollapsed(c => !c)}>
        <span style={{ ...styles.teamStepChevron, transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}>▶</span>
        <div style={styles.teamGroupIdentity}>
          <span style={styles.teamGroupTitle}>{item.teamName ?? 'Team'}</span>
          <span style={styles.teamModeBadge}>{modeLabel}</span>
        </div>
        <span style={styles.teamGroupProgress}>
          {memberGroups.length} {memberGroups.length === 1 ? 'member' : 'members'} · {activeCount > 0 && isStreaming ? `${completedCount}/${workerMessages.length} ${workerMessages.length === 1 ? 'round' : 'rounds'}` : failedCount ? `${completedCount}/${workerMessages.length} ${workerMessages.length === 1 ? 'round' : 'rounds'} · ${failedCount} failed` : `${completedCount}/${workerMessages.length} ${workerMessages.length === 1 ? 'round' : 'rounds'}`}
        </span>
        <div style={styles.teamGroupHeaderActions} onClick={event => event.stopPropagation()}>
          <button
            type="button"
            style={{ ...styles.teamWhiteboardButton, ...(whiteboardOpen ? styles.teamWhiteboardButtonActive : undefined) }}
            aria-expanded={whiteboardOpen}
            onClick={() => {
              if (collapsed) setCollapsed(false)
              setWhiteboardOpen(open => collapsed ? true : !open)
            }}
          >
            Whiteboard
          </button>
        </div>
      </div>
      {whiteboardOpen && (
        <TeamWhiteboardModal
          workerMessages={workerMessages}
          footerMessages={footerMessages}
          onClose={() => setWhiteboardOpen(false)}
        />
      )}
      {!collapsed && (
        <TeamSpatialStage
          mode={item.teamMode}
          groups={memberGroups}
          rounds={workerMessages}
          totalRounds={workerMessages.length}
          isStreaming={isStreaming}
          expandedRounds={roundExpansion}
          onToggleRound={toggleRound}
          onSetAllRounds={setAllRounds}
        />
      )}
      {!collapsed && footerMessages.map(m => <TeamRunFooter key={m.id} content={m.content} />)}
      {!collapsed && (
        <div style={styles.teamSummaryCollapse}>
          <button
            type="button"
            style={{ ...styles.teamSummaryToggle, ...(summaryOpen ? styles.teamSummaryToggleOpen : undefined) }}
            aria-expanded={summaryOpen}
            onClick={() => setSummaryOpen(open => !open)}
          >
            <span style={{ ...styles.teamStepChevron, transform: summaryOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
            <span>{finalSummary ? 'Final summary' : 'Summary'}</span>
          </button>
          {summaryOpen && <TeamSummaryPanel summary={finalSummary} />}
        </div>
      )}
    </div>
  )
}

export const ChatTab: React.FC<Props> = ({
  chatId, isGatewayRunning, coreFailed,
  rightPanelMode, onRightPanelModeChange, rightPanelWidth, onRightPanelResize,
  browserLoginWait, onConfirmBrowserLogin, onDismissBrowserLogin,
}) => {
  const { state, sendMessage, stopChat, clearRestore, ensureWorktree, setSelection, setAgentModel, setWorkingDir: setChatWorkingDir, setContextPanelOpen, setSoloAdvisor, linkChannel, unlinkChannel, resolvePermission, generateTaskBrief } = useChats()
  const chat = state.chats[chatId]
  const flight = state.inFlight[chatId]
  const worktreeEnsureAttemptedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!chat || chat.kind === 'automation' || !isGatewayRunning || chat.gitContext) return
    if (worktreeEnsureAttemptedRef.current === chat.id) return
    worktreeEnsureAttemptedRef.current = chat.id
    void ensureWorktree(chat.id).catch(error => {
      console.error(`Failed to isolate chat ${chat.id}:`, error)
    })
  }, [chat?.id, chat?.kind, chat?.gitContext, isGatewayRunning, ensureWorktree])

  // Voice for this chat: the transcript is sent through the normal chat path
  // below, and only the reply is read aloud.
  const voiceAutoSendRef = useRef(false)
  const prevFlightRef = useRef<unknown>(null)
  // Whether the turn currently in flight was started by speaking. `mode` is
  // sticky (it remembers which button you used last), so keying playback off
  // it read every typed message aloud too.
  const spokenTurnRef = useRef(false)
  const voiceAckGenerationRef = useRef(0)
  const voice = useChatVoice({
    onTranscript: (text, mode) => {
      if (mode === 'converse') {
        voiceAutoSendRef.current = true
        setInput(text)
      } else {
        // Dictation appends, so a second pass adds to what's already there.
        setInput(prev => (prev.trim() ? `${prev.trim()} ${text}` : text))
      }
    },
    onError: msg => void window.codey.voice.showError(msg),
  })
  // Seed from the per-chat draft store so unsent text/attachments survive the
  // remount that happens when switching chats (App.tsx keys ChatTab by chat id).
  const [input, setInput] = useState(() => getDraft(chatId).text)
  const [inputHistoryIndex, setInputHistoryIndex] = useState<number | null>(null)
  const [workers, setWorkers] = useState<WorkerDto[]>([])
  const [teamNames, setTeamNames] = useState<string[]>([])
  const [models, setModels] = useState<ModelEntry[]>([])
  const [enabledAgents, setEnabledAgents] = useState<string[]>([...AGENT_NAMES])
  const [defaultAgent, setDefaultAgent] = useState<string | null>(null)
  const [agentDefaultModels, setAgentDefaultModels] = useState<Record<string, string | undefined>>({})
  const [advisorConfig, setAdvisorConfig] = useState<{ agent?: string; model?: string }>({})
  const [pendingAttachments, setPendingAttachments] = useState<FileAttachment[]>(() => getDraft(chatId).attachments)
  const [isDragging, setIsDragging] = useState(false)
  const [slashCommands, setSlashCommands] = useState<Array<{ name: string; description: string; source: 'agent' | 'gateway' | 'skill' }>>([])
  const [slashIdx, setSlashIdx] = useState(0)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const [panelTab, setPanelTab] = useState<ContextPanelTab>('current')
  const qqInputRef = useRef<HTMLTextAreaElement>(null)
  const { ask: askQuickQuestion } = useQuickQuestion()
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [pairings, setPairings] = useState<Array<{ channel: 'telegram'|'discord'|'imessage'; channelUserId: string }>>([])
  const [pairingModal, setPairingModal] = useState<null | 'telegram' | 'discord' | 'imessage'>(null)
  // Channel the user clicked "Connect" for in the link menu. If the pairing
  // didn't exist yet we open the modal; once it does, auto-link this chat.
  const pendingLinkChannelRef = useRef<null | 'telegram' | 'discord' | 'imessage'>(null)
  const [linkMenuOpen, setLinkMenuOpen] = useState(false)
  const [editorMenuOpen, setEditorMenuOpen] = useState(false)
  const [editors, setEditors] = useState<Array<{ id: string; name: string; installed: boolean }>>([])
  const [editorsLoaded, setEditorsLoaded] = useState(false)
  const [openingEditor, setOpeningEditor] = useState<string | null>(null)
  const [preferredEditorId, setPreferredEditorId] = useState(() => localStorage.getItem('codey.preferredEditor') ?? '')
  const [runSettingsOpen, setRunSettingsOpen] = useState(false)
  useEffect(() => {
    if (!isGatewayRunning || !runSettingsOpen) return
    let stale = false
    window.codey.dispatcher.get().then(result => {
      if (!stale && result.ok) setAdvisorConfig(result.data)
    }).catch(() => {})
    return () => { stale = true }
  }, [isGatewayRunning, runSettingsOpen])
  const [followLatest, setFollowLatest] = useState(true)
  // Selected option labels for the active multi-select AskUserQuestion. Reset
  // whenever a new message arrives (the prompt is always the last message).
  const [multiChoice, setMultiChoice] = useState<string[]>([])
  const [selectedTurnIdState, setSelectedTurnIdState] = useState<string | null>(null)
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  // The turn header owns the thinking chevron, so the disclosure state has to
  // live above it. Only a user's explicit toggle is stored; `undefined` means
  // fall back to defaultThinkingExpanded, which auto-opens thinking while the
  // agent is still working and has produced no answer yet.
  const [thinkingToggles, setThinkingToggles] = useState<Record<string, boolean>>({})
  const [taskBriefLoading, setTaskBriefLoading] = useState(false)
  // This is a single app-wide display preference, not chat state. ChatTab is
  // remounted on chat switches, so seed it from localStorage and write changes
  // synchronously before a switch can occur.
  const [statusSidecarHidden, setStatusSidecarHidden] = useState(
    () => localStorage.getItem(STATUS_SIDECAR_HIDDEN_KEY) === '1',
  )
  const [bottomTerminalOpen, setBottomTerminalOpen] = useState(false)
  const [bottomTerminalHeight, setBottomTerminalHeight] = useState<number>(() => {
    const value = Number(localStorage.getItem('codey.bottomTerminalHeight'))
    return Number.isFinite(value) ? Math.max(180, Math.min(560, value)) : 280
  })
  // Manual composer height (px). null = auto-grow up to 120px (default
  // behavior). Once the user drags the handle we pin an explicit height so
  // long, multi-line commands stay fully visible.
  const [composerHeight, setComposerHeight] = useState<number | null>(() => {
    const v = localStorage.getItem('codey.composerHeight')
    const n = v ? parseInt(v, 10) : NaN
    return Number.isFinite(n) ? n : null
  })
  const [composerHandleHover, setComposerHandleHover] = useState(false)
  const [composerResizing, setComposerResizing] = useState(false)
  const dragDepthRef = useRef(0)
  const composerResizeRef = useRef<{ y: number; h: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (composerHeight != null) localStorage.setItem('codey.composerHeight', String(composerHeight))
  }, [composerHeight])

  const startComposerResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startH = composerHeight ?? taRef.current?.offsetHeight ?? 40
    composerResizeRef.current = { y: e.clientY, h: startH }
    setComposerResizing(true)
    const onMove = (ev: MouseEvent) => {
      const s = composerResizeRef.current
      if (!s) return
      const dy = s.y - ev.clientY // drag up => taller
      setComposerHeight(Math.max(40, Math.min(window.innerHeight * 0.6, s.h + dy)))
    }
    const onUp = () => {
      composerResizeRef.current = null
      setComposerResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  useEffect(() => { apiService.listWorkers().then(setWorkers) }, [])
  const refreshPairings = async () => {
    try {
      const p = await apiService.listPairings()
      setPairings(p as any)
      return p as Array<{ channel: 'telegram'|'discord'|'imessage'; channelUserId: string }>
    } catch {
      return [] as Array<{ channel: 'telegram'|'discord'|'imessage'; channelUserId: string }>
    }
  }
  useEffect(() => { refreshPairings() }, [])
  useEffect(() => {
    // Push event from the gateway when a user completes /pair on a channel.
    // Refresh pairings, dismiss any open pairing modal, and auto-link this
    // chat if the user had clicked "Connect" for the same channel.
    const off = apiService.onPairingEvent(async (ev) => {
      if (ev.type !== 'completed') return
      const fresh = await refreshPairings()
      if (pairingModal === ev.channel) setPairingModal(null)
      const pending = pendingLinkChannelRef.current
      if (pending && pending === ev.channel) {
        pendingLinkChannelRef.current = null
        const newly = fresh.find(p => p.channel === ev.channel) ?? { channel: ev.channel, channelUserId: ev.channelUserId }
        const alreadyOnChat = chat.routes?.some(r => r.channel === ev.channel && r.channelUserId === newly.channelUserId)
        if (!alreadyOnChat) {
          try { await linkChannel(chat.id, ev.channel, newly.channelUserId) } catch { /* noop */ }
        }
      }
    })
    return off
  }, [chat.id, chat.routes, pairingModal, linkChannel])
  useEffect(() => {
    const ws = chat?.workspaceName
    if (!ws) return
    // Teams are global — every workspace can run every team — so list the full
    // global library rather than a per-workspace enabled subset.
    const refresh = () =>
      apiService.getGlobalTeams()
        .then(lib => setTeamNames(Object.keys(lib)))
        .catch(() => setTeamNames([]))
    refresh()
    // Re-fetch when teams are enabled/edited in the Settings overlay, which
    // stays mounted alongside this tab so workspaceName never changes.
    return onTeamsChanged(refresh)
  }, [chat?.workspaceName])
  const [workspaceDir, setWorkspaceDir] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!chat?.workspaceName) return
    apiService.getWorkspaceInfo(chat.workspaceName)
      .then(info => setWorkspaceDir(info.workingDir))
      .catch(() => setWorkspaceDir(undefined))
  }, [chat?.workspaceName])
  // The effective working dir is the chat's per-chat override (a bound
  // worktree) when set, otherwise the workspace's repo root. Git status and the
  // header BranchPicker both operate on this effective dir.
  const workingDir = chat?.workingDirOverride || workspaceDir

  const changeRightPanelMode = useCallback((mode: WorkspaceDockTool | null) => {
    onRightPanelModeChange(mode)
    if (chat) void setContextPanelOpen(chat.id, mode !== null)
  }, [chat?.id, onRightPanelModeChange, setContextPanelOpen])

  // Browser requests can originate in the main shell (agent control,
  // permissions, sidebar). Persist the shared panel's open state on the chat
  // when one of those requests selects a tool.
  useEffect(() => {
    if (rightPanelMode && chat && !chat.contextPanelOpen) void setContextPanelOpen(chat.id, true)
  }, [rightPanelMode, chat?.id, chat?.contextPanelOpen, setContextPanelOpen])

  const loadEditors = useCallback(async () => {
    if (editorsLoaded) return editors
    const result = await window.codey.editors.list()
    const next = result.ok ? result.data : []
    if (result.ok) setEditors(next)
    setEditorsLoaded(true)
    return next
  }, [editors, editorsLoaded])

  useEffect(() => { void loadEditors() }, [])

  useEffect(() => {
    if (!editorsLoaded) return
    const installed = editors.filter(editor => editor.installed)
    if (installed.length === 0 || installed.some(editor => editor.id === preferredEditorId)) return
    setPreferredEditorId(installed[0].id)
    localStorage.setItem('codey.preferredEditor', installed[0].id)
  }, [editors, editorsLoaded, preferredEditorId])

  const toggleEditorMenu = async () => {
    if (!editorsLoaded) await loadEditors()
    setEditorMenuOpen(open => !open)
  }

  const openInEditor = async (editor: { id: string; name: string }) => {
    if (!workingDir) return
    setOpeningEditor(editor.id)
    const result = await window.codey.editors.open(editor.id, workingDir)
    setOpeningEditor(null)
    if (!result.ok) {
      alert(`Couldn’t open ${editor.name}: ${result.error}`)
      return
    }
    setPreferredEditorId(editor.id)
    localStorage.setItem('codey.preferredEditor', editor.id)
    setEditorMenuOpen(false)
  }

  const openPreferredEditor = async () => {
    const available = (editorsLoaded ? editors : await loadEditors()).filter(editor => editor.installed)
    const preferred = available.find(editor => editor.id === preferredEditorId) ?? available[0]
    if (preferred) await openInEditor(preferred)
  }

  const preferredEditor = editors.find(editor => editor.id === preferredEditorId && editor.installed)

  const { status: gitStatus, refresh: refreshGit } = useGitStatus(workingDir)
  const [showPrModal, setShowPrModal] = useState(false)
  // Derived from the gitStatus useGitStatus already fetches — no extra IPC round-trip.
  // PR-able: on a non-default branch with commits the default branch doesn't have
  // (ahead is null when there's no remote default ref — fall back to branch check only).
  const branchAhead = !!gitStatus
    && gitStatus.branch !== (gitStatus.defaultBranch ?? 'main')
    && gitStatus.branch !== 'HEAD'
    && (gitStatus.ahead == null || gitStatus.ahead > 0)
  useEffect(() => {
    if (!isGatewayRunning) return
    ;(async () => {
      try {
        const [m, fb] = await Promise.all([
          window.codey.models.list(),
          window.codey.fallback.get(),
        ])
        if (m.ok) setModels(m.data as ModelEntry[])
        // Everything we need (which agents are usable, which is the default,
        // and per-agent default model) is encoded in fallback.order. Membership
        // == enabled; order[0] is the gateway default; first entry per agent
        // that pins a model is that agent's default model.
        if (fb.ok) {
          const order = fb.data.order ?? []
          setEnabledAgents(AGENT_NAMES.filter(n => order.some(e => e.agent === n)))
          setDefaultAgent(order[0]?.agent ?? null)
          const defaults: Record<string, string | undefined> = {}
          for (const n of AGENT_NAMES) {
            defaults[n] = order.find(e => e.agent === n && !!e.model)?.model
          }
          setAgentDefaultModels(defaults)
        }
      } catch { /* surface via dropdown placeholders */ }
    })()
  }, [isGatewayRunning])
  const lastMsg = chat?.messages?.[chat.messages.length - 1]
  // A fresh prompt clears any pending multi-select picks from a prior question.
  useEffect(() => { setMultiChoice([]) }, [chatId, lastMsg?.id])
  const prevChatIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!followLatest) return
    const switched = prevChatIdRef.current !== chatId
    prevChatIdRef.current = chatId
    messagesEndRef.current?.scrollIntoView(switched ? { block: 'end' } : { behavior: 'smooth' })
  }, [chatId, chat?.messages?.length, lastMsg?.content, lastMsg?.toolCalls?.length, chat?.contextPanelOpen, followLatest])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && flight) stopChat(chatId)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [flight, chatId])
  // Refresh the Status task brief on each turn boundary — when a turn is sent
  // and again when it completes — while the Status tab is open, so it reflects
  // the live history. The tab-switch trigger alone misses these: nothing
  // re-fires during a run, and a completed assistant message keeps its
  // send-time timestamp so the staleness check can't see the finished turn.
  // Key off the boolean (not `flight` itself, which churns every token).
  const turnActive = !!flight
  const prevTurnActiveRef = useRef(turnActive)
  useEffect(() => {
    const toggled = prevTurnActiveRef.current !== turnActive
    prevTurnActiveRef.current = turnActive
    if (!toggled) return
    if (!turnActive) void refreshGit()
    if (!chat || panelTab !== 'task') return
    const sharedDigestIsCurrent = !turnActive
      && !!chat.taskBrief?.teamTurnId
      && chat.messages.some(message =>
        message.teamTurnId === chat.taskBrief?.teamTurnId && !!message.teamSummary)
    if (sharedDigestIsCurrent) return
    setTaskBriefLoading(true)
    generateTaskBrief(chat.id).finally(() => setTaskBriefLoading(false))
  }, [turnActive, panelTab, chatId])
  // Keep the per-chat draft store in sync so the current text/attachments are
  // preserved when ChatTab remounts on a chat switch. setDraft drops the entry
  // once both are empty (e.g. after send), so this also clears sent drafts.
  useEffect(() => {
    setDraft(chatId, { text: input, attachments: pendingAttachments })
  }, [chatId, input, pendingAttachments])
  useEffect(() => { setInputHistoryIndex(null) }, [chatId, chat?.messages.length])
  // When a turn is interrupted, lift the original prompt back into the input
  // and focus the textarea so the user can edit/resend without retyping.
  const restoreText = state.pendingRestores[chatId]
  useEffect(() => {
    if (restoreText === undefined) return
    setInput(restoreText)
    clearRestore(chatId)
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      ta.focus()
      const len = ta.value.length
      try { ta.setSelectionRange(len, len) } catch { /* not supported */ }
    })
  }, [restoreText, chatId])
  useEffect(() => { localStorage.setItem('codey.bottomTerminalHeight', String(bottomTerminalHeight)) }, [bottomTerminalHeight])
  // Track window width so the context panel can shrink (or be hidden) when
  // the user resizes Codey down — at small widths the middle column was
  // collapsing to ~200px and wrapping CJK characters one per line.
  const [windowWidth, setWindowWidth] = useState<number>(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useEffect(() => {
    setFollowLatest(true)
    setSelectedTurnIdState(null)
  }, [chatId])
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === '\\') {
        e.preventDefault()
        changeRightPanelMode((rightPanelMode ?? (chat?.contextPanelOpen ? 'overview' : null)) ? null : 'overview')
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setBottomTerminalOpen(open => {
          const next = !open
          if (next && rightPanelMode === 'terminal') changeRightPanelMode('overview')
          return next
        })
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [chat?.id, chat?.contextPanelOpen, rightPanelMode, changeRightPanelMode])

  const drainPendingPairing = React.useCallback(() => {
    const ch = consumePendingPairing(chatId)
    if (!ch) return
    ;(async () => {
      const fresh = await refreshPairings()
      const existing = fresh.find(p => p.channel === ch)
      const alreadyOnChat = chat?.routes?.some(r => r.channel === ch)
      if (existing && !alreadyOnChat) {
        try { await linkChannel(chatId, ch, existing.channelUserId) } catch { /* noop */ }
        return
      }
      pendingLinkChannelRef.current = ch
      setPairingModal(ch)
    })()
  }, [chatId, chat?.routes, linkChannel])

  useEffect(() => { drainPendingPairing() }, [chatId])

  useEffect(() => {
    const handler = () => drainPendingPairing()
    window.addEventListener('pendingPairing', handler)
    return () => window.removeEventListener('pendingPairing', handler)
  }, [drainPendingPairing])

  if (!chat) return null

  const latestAssistantId: string | null = (() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'assistant') return chat.messages[i].id
    }
    return null
  })()
  const selectedTurnId: string | null = followLatest ? latestAssistantId : selectedTurnIdState
  const selectedTurnIndex: number | null = (() => {
    if (!selectedTurnId) return null
    let n = 0
    for (const m of chat.messages) {
      if (m.role === 'assistant') {
        n++
        if (m.id === selectedTurnId) return n
      }
    }
    return null
  })()
  const resolvedRightPanelMode: WorkspaceDockTool | null = rightPanelMode
    ?? (chat?.contextPanelOpen ? 'overview' : null)
  const panelOpen = resolvedRightPanelMode !== null
  const overviewOpen = resolvedRightPanelMode === 'overview'

  // The Status sidecar floats over the chat's top-right when the panel is
  // closed (it's absolutely positioned, so it takes no layout space). The full
  // card stays off narrow windows; its compact global control always fits.
  const SIDECAR_W = 264
  const sidecarFits = windowWidth >= 720
  const hasAssistantMsg = (chat?.messages ?? []).some(m => m.role === 'assistant')
  const sidecarVisible = !panelOpen
    && (statusSidecarHidden || sidecarFits)
    && !!chat
    && hasAssistantMsg

  const setGlobalStatusSidecarHidden = (hidden: boolean) => {
    localStorage.setItem(STATUS_SIDECAR_HIDDEN_KEY, hidden ? '1' : '0')
    setStatusSidecarHidden(hidden)
  }

  // Self-populate the Status sidecar's brief while the panel is closed. Mirrors
  // the panel's turn-boundary refresh but gates on the sidecar being visible
  // instead of the Status tab being open. One brief, two views. Waits for the
  // turn to settle (!turnActive) so we never regenerate mid-stream, and skips
  // when a generation is already running to avoid double-firing with the panel.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!sidecarVisible || turnActive || taskBriefLoading || !chat) return
    if (!isTaskBriefStale(chat)) return
    setTaskBriefLoading(true)
    generateTaskBrief(chat.id).finally(() => setTaskBriefLoading(false))
  }, [sidecarVisible, turnActive, chatId, chat?.messages.length, chat?.taskBrief?.generatedAt])

  const selectionValue: string = chat.selection.type === 'worker'
    ? `worker:${chat.selection.name}`
    : chat.selection.type === 'team'
      ? `team:${chat.selection.name ?? ''}`
      : 'none'

  const onSelectionChange = async (v: string) => {
    let next: ChatSelection
    if (v === 'none') next = { type: 'none' }
    else if (v.startsWith('team:')) next = { type: 'team', name: v.slice('team:'.length) }
    else next = { type: 'worker', name: v.slice('worker:'.length) }
    await setSelection(chat.id, next)
  }

  // Resolve which agent/model are *actually* used for this chat.
  // Priority: per-chat override → worker config → gateway fallback default.
  const selectedWorker = chat.selection.type === 'worker'
    ? workers.find(w => w.name === chat.selection.name)
    : undefined
  const workerAgent = selectedWorker?.config.codingAgent
  const workerModel = selectedWorker?.config.model
  const effectiveAgent: string = chat.agent ?? workerAgent ?? defaultAgent ?? 'claude-code'
  const effectiveModel: string | undefined = chat.model ?? workerModel ?? agentDefaultModels[effectiveAgent]
  const effectiveAdvisorAgent = advisorConfig.agent ?? defaultAgent ?? 'claude-code'
  const effectiveAdvisorModel = advisorConfig.model ?? agentDefaultModels[effectiveAdvisorAgent] ?? 'Default model'
  const apiTypeForAgent = AGENT_API_TYPE[effectiveAgent]
  const modelsForAgent = models.filter(m => m.apiType === apiTypeForAgent)

  useEffect(() => {
    let stale = false
    window.codey.agents.slashCommands(effectiveAgent).then(r => {
      if (stale) return
      if (r.ok) setSlashCommands(r.data)
    })
    return () => { stale = true }
  }, [effectiveAgent])

  // Skills can be installed while this chat remains mounted behind Settings.
  // Re-scan when the slash menu is opened so newly loaded skills appear
  // immediately without requiring an agent switch or app restart.
  useEffect(() => {
    if (input !== '/') return
    let stale = false
    window.codey.agents.slashCommands(effectiveAgent).then(r => {
      if (!stale && r.ok) setSlashCommands(r.data)
    })
    return () => { stale = true }
  }, [input, effectiveAgent])

  useEffect(() => { setSlashIdx(0) }, [input])
  useEffect(() => {
    const el = slashMenuRef.current?.children[slashIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [slashIdx])
  const slashQuery = input.match(/^\/(\S*)$/)?.[1]?.toLowerCase() ?? null
  const filteredSlash = slashQuery !== null
    ? slashCommands.filter(c => c.name.toLowerCase().includes(slashQuery)).slice(0, 12)
    : []
  const showSlashMenu = filteredSlash.length > 0

  const onAgentChange = async (v: string) => {
    const nextAgent = v === '' ? null : v
    // Clear the model override when switching agents — the previous model id
    // is unlikely to be valid for the new agent's apiType.
    await setAgentModel(chat.id, nextAgent, null)
  }
  const onModelChange = async (v: string) => {
    await setAgentModel(chat.id, chat.agent ?? null, v === '' ? null : v)
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

  // Without this, dropping a file outside the chat's own drop zone (or on the
  // composer/textarea) makes Electron navigate to file:// and "open" the file.
  // Swallow file drags window-wide; the chat's onDrop still handles the upload
  // for drops inside the conversation column.
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault()
      }
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

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

  const openQuickQuestion = (initial?: string) => {
    changeRightPanelMode('overview')
    setPanelTab('qq')
    if (initial && initial.trim()) {
      void askQuickQuestion(chat.id, initial.trim())
    } else {
      // Focus the QQ composer on the next paint, once the panel has mounted.
      setTimeout(() => qqInputRef.current?.focus(), 50)
    }
  }

  const startBottomTerminalResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = bottomTerminalHeight
    const move = (next: PointerEvent) => {
      setBottomTerminalHeight(Math.max(180, Math.min(window.innerHeight * 0.7, startHeight + startY - next.clientY)))
    }
    const up = (next: PointerEvent) => {
      move(next)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const send = async () => {
    if ((!input.trim() && pendingAttachments.length === 0) || !isGatewayRunning || !!flight) return

    // Quick Question triggers — these never go to the main chat.
    const trimmed = input.trim()
    if (trimmed.toLowerCase() === 'qq') {
      setInput('')
      if (taRef.current && composerHeight == null) taRef.current.style.height = 'auto'
      openQuickQuestion()
      return
    }
    const qqMatch = trimmed.match(/^\/qq(?:\s+([\s\S]*))?$/i)
    if (qqMatch) {
      setInput('')
      if (taRef.current && composerHeight == null) taRef.current.style.height = 'auto'
      openQuickQuestion(qqMatch[1] ?? '')
      return
    }

    const text = input
    const atts = pendingAttachments.length > 0 ? [...pendingAttachments] : undefined
    setInput('')
    setPendingAttachments([])
    if (taRef.current && composerHeight == null) taRef.current.style.height = 'auto'
    setFollowLatest(true)
    await sendMessage(chat.id, text, atts)
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIdx(i => Math.min(i + 1, filteredSlash.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIdx(i => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        const cmd = filteredSlash[slashIdx]
        if (cmd) setInput(`/${cmd.name} `)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setInput('')
        return
      }
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      // Start history navigation only from a blank composer. Once navigation
      // has started, both arrows continue to move through this chat's prompts.
      if (inputHistoryIndex !== null || input.length === 0) {
        const moved = moveInInputHistory(
          chatInputHistory(chat.messages),
          inputHistoryIndex,
          e.key === 'ArrowUp' ? 'up' : 'down',
        )
        if (moved) {
          e.preventDefault()
          setInputHistoryIndex(moved.index)
          setInput(moved.value)
          requestAnimationFrame(() => {
            const ta = taRef.current
            if (!ta) return
            try { ta.setSelectionRange(ta.value.length, ta.value.length) } catch { /* unsupported */ }
          })
          return
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const isLinked = (channel: string, userId: string) =>
    chat.routes?.some(r => r.channel === channel && r.channelUserId === userId) ?? false

  const onLinkButton = async () => {
    if (pairings.length === 0) {
      setPairingModal('telegram')
      return
    }
    if (pairings.length === 1) {
      const p = pairings[0]
      if (isLinked(p.channel, p.channelUserId)) {
        await unlinkChannel(chat.id, p.channel, p.channelUserId)
      } else {
        await linkChannel(chat.id, p.channel, p.channelUserId)
      }
      return
    }
    const choice = window.prompt(`Pick a pairing to toggle:\n${pairings.map((p, i) => `${i+1}. ${p.channel}:${p.channelUserId}`).join('\n')}\n\nEnter number:`)
    const idx = choice ? parseInt(choice, 10) - 1 : -1
    if (idx >= 0 && idx < pairings.length) {
      const p = pairings[idx]
      if (isLinked(p.channel, p.channelUserId)) {
        await unlinkChannel(chat.id, p.channel, p.channelUserId)
      } else {
        await linkChannel(chat.id, p.channel, p.channelUserId)
      }
    }
  }


  // A finished transcript sends itself — the point of voice mode is not
  // touching the keyboard, so stopping at a filled-in composer defeats it.
  useEffect(() => {
    if (!voiceAutoSendRef.current || !input.trim()) return
    voiceAutoSendRef.current = false
    const spoken = input
    spokenTurnRef.current = true
    void send()
    // Acknowledge immediately. An agent turn routinely runs for 30s to
    // several minutes, and unbroken silence in a voice interface reads as
    // "it died" rather than "it's working". Routed through the gateway like
    // the reply so both use the same voice; verbatim because a one-line ack
    // has nothing to digest, and no conversationId so it can't displace the
    // cached reply behind "more detail".
    const ackGeneration = ++voiceAckGenerationRef.current
    void window.codey.voice.ack(spoken).then(result => {
      // A very fast agent reply can beat acknowledgement generation. Never
      // let a late ack interrupt the actual answer or leak into a newer turn.
      if (ackGeneration !== voiceAckGenerationRef.current || !spokenTurnRef.current) return
      const fallback = /[\u4e00-\u9fff]/.test(spoken) ? '好的，我去处理' : 'Got it, working on it.' // lint-allow-non-english
      void voice.speak(result.ok ? result.data.text : fallback, undefined, true)
    })
  }, [input]) // eslint-disable-line react-hooks/exhaustive-deps

  // Read the reply aloud once the turn settles. Keyed off the in-flight
  // marker clearing rather than off message content, so partial streamed
  // text is never spoken mid-generation.
  useEffect(() => {
    const wasInFlight = prevFlightRef.current
    prevFlightRef.current = flight
    if (!wasInFlight || flight) return
    // Only speak a reply to something that was actually spoken. Typing into a
    // chat you happen to have used voice in before should stay silent.
    if (!spokenTurnRef.current) return
    spokenTurnRef.current = false
    voiceAckGenerationRef.current += 1
    const messages = chat?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === 'assistant' && message.content?.trim()) {
        void voice.speak(message.content, chatId)
        return
      }
    }
  }, [flight]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep one IPC listener mounted for the lifetime of the chat. The voice
  // callback changes as recording state and transcript handlers update; using
  // a ref avoids a brief unsubscribe/re-subscribe gap exactly when the second
  // hotkey press is meant to stop and send the recording.
  const voiceToggleRef = useRef(voice.toggle)
  voiceToggleRef.current = voice.toggle
  const voiceCancelRef = useRef(voice.cancel)
  voiceCancelRef.current = voice.cancel
  useEffect(() => window.codey.voice.onConverseHotkey(() => {
    voiceToggleRef.current('converse', { fromHotkey: true })
  }), [])
  useEffect(() => window.codey.voice.onCancelConverse(() => {
    voiceCancelRef.current()
  }), [])

  // Drive the floating capsule. Only converse turns get one — dictation is a
  // brief, eyes-on-screen action, and its status shows inline in the composer
  // instead.
  useEffect(() => {
    // Clicking the button means you're already looking at the window; the
    // floating capsule is for the hotkey, where you may not be.
    const showable = voice.fromHotkey && voice.mode === 'converse' && voice.state !== 'idle'
    void window.codey.voice.setHudState(showable ? voice.state : 'idle')
  }, [voice.state, voice.mode, voice.fromHotkey])

  useEffect(() => {
    if (voice.fromHotkey && voice.mode === 'converse' && voice.state !== 'idle') {
      window.codey.voice.setHudLevel(voice.level)
    }
  }, [voice.level, voice.mode, voice.state, voice.fromHotkey])

  // Esc abandons a voice turn: drop the recording rather than sending it, or
  // stop a reply mid-sentence. Captured so it doesn't also reach the composer.
  useEffect(() => {
    if (voice.state === 'idle') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      voice.cancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [voice.state, voice.cancel])

  const voiceBusy = voice.state === 'recording' || voice.state === 'transcribing'
  const isSending = !!flight
  const orphaned = state.workspaces.length > 0 && !state.workspaces.includes(chat.workspaceName)
  const canSend = isGatewayRunning && !coreFailed && !isSending && (!!input.trim() || pendingAttachments.length > 0) && !orphaned
  // Three layers when the agent gave us its task list: what it is on, the tool
  // it is running right now, and how far through it is — a bare "Editing…"
  // withholds information we already have in hand.
  const flightToolCalls = flight
    ? chat.messages.find(m => m.id === flight.assistantMessageId)?.toolCalls
    : undefined
  const live = flight && flight.agentStatus !== 'idle'
    ? statusLine({
        checklist: chat.checklist,
        entries: flightToolCalls,
        format: formatHeadline,
        fallback: ACTIVITY_LABEL[flight.agentStatus],
      })
    : null
  const statusLabel = flight?.queuedPosition
    ? `Queued (#${flight.queuedPosition})`
    // The trailing ellipsis is the "still going" cue for a lone verb; with real
    // detail the shimmer already says that, and the dots just add noise.
    : live ? (live.parts.length > 1 ? live.parts.join(' · ') : `${live.parts[0]}…`)
    : ''

  const openChatTerminal = () => {
    if (!workingDir) return
    setBottomTerminalOpen(true)
    if (resolvedRightPanelMode === 'terminal') changeRightPanelMode('overview')
  }

  const panelWorkerName = chat.selection.type === 'worker' ? chat.selection.name : undefined
  const panelTeamName = chat.selection.type === 'team' ? chat.selection.name : undefined
  const runSettingsSummary = chat.selection.type === 'team'
    ? `${chat.selection.name ?? 'Team'} · per-runner routing`
    : [
        chat.selection.type === 'worker' ? chat.selection.name : null,
        effectiveAgent,
        effectiveModel ?? 'default model',
        chat.soloAdvisor ? 'Advisor on' : null,
      ].filter(Boolean).join(' · ')
  const [panelTeamGraph, setPanelTeamGraph] = useState<import('../../../packages/core/src/team-graph').TeamGraph | undefined>(undefined)
  useEffect(() => {
    if (!panelTeamName) { setPanelTeamGraph(undefined); return }
    apiService.getGlobalTeams()
      .then(teams => setPanelTeamGraph((teams[panelTeamName] as any)?.graph))
      .catch(() => setPanelTeamGraph(undefined))
  }, [panelTeamName])

  return (
    <div style={styles.outer}>
      <div
        style={styles.container}
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
      <div style={styles.header}>
        <div style={styles.headerIdentity}>
          <span style={styles.workspaceTag}><UIIcon name="workspace" size={13} />{chat.workspaceName}</span>
        </div>
        <BranchPicker
          workingDir={workingDir}
          repoRoot={workspaceDir}
          boundWorktreePath={chat?.gitContext?.worktreePath ?? chat?.workingDirOverride}
          gitContext={chat?.gitContext}
          onBindWorktree={async (path) => {
            if (!chat) return
            await setChatWorkingDir(chat.id, path)
          }}
          onOpenTerminal={openChatTerminal}
        />
        <div style={{ ...styles.openInWrap, marginLeft: 'auto' }}>
          <div style={styles.openInSplit}>
            <button
              onClick={() => void openPreferredEditor()}
              style={styles.openInPrimary}
              disabled={!workingDir || openingEditor !== null || (editorsLoaded && !editors.some(editor => editor.installed))}
              title={workingDir
                ? `Open this project${preferredEditor ? ` in ${preferredEditor.name}` : ''}`
                : 'Project directory is unavailable'}
              aria-label={preferredEditor ? `Open in ${preferredEditor.name}` : 'Open in editor'}
            >
              {preferredEditor && EDITOR_LOGOS[preferredEditor.id] ? (
                <img src={EDITOR_LOGOS[preferredEditor.id]} alt="" style={styles.editorIcon} />
              ) : (
                <UIIcon name="code" size={15} />
              )}
              {openingEditor && <span style={styles.editorOpeningLabel}>Opening…</span>}
            </button>
            <button
              onClick={() => void toggleEditorMenu()}
              style={styles.openInDropdown}
              disabled={!workingDir}
              title="Choose another editor"
              aria-label="Choose another editor"
            >
              <span style={{ display: 'inline-flex', transform: editorMenuOpen ? 'rotate(-90deg)' : 'rotate(90deg)' }}><UIIcon name="chevron" size={12} /></span>
            </button>
          </div>
          {editorMenuOpen && (
            <>
              <div onClick={() => setEditorMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
              <div style={styles.editorMenu} onClick={event => event.stopPropagation()}>
                {!editorsLoaded ? (
                  <div style={styles.editorMenuEmpty}>Checking installed editors…</div>
                ) : editors.filter(editor => editor.installed).length > 0 ? (
                  editors.filter(editor => editor.installed).map(editor => (
                    <button
                      key={editor.id}
                      style={styles.editorMenuItem}
                      disabled={openingEditor !== null}
                      onClick={() => void openInEditor(editor)}
                    >
                      {EDITOR_LOGOS[editor.id]
                        ? <img src={EDITOR_LOGOS[editor.id]} alt="" style={styles.editorMenuIcon} />
                        : <UIIcon name="code" size={14} />}
                      <span>{openingEditor === editor.id ? `Opening ${editor.name}…` : editor.name}</span>
                      {editor.id === preferredEditorId && <UIIcon name="check" size={14} />}
                    </button>
                  ))
                ) : (
                  <div style={styles.editorMenuEmpty}>No supported editor found in Applications.</div>
                )}
              </div>
            </>
          )}
        </div>
        <div style={styles.runSettingsWrap}>
          <button
            onClick={() => setRunSettingsOpen(open => !open)}
            style={styles.runSettingsButton}
            title="Configure worker, agent, model, and advisor"
          >
            <span style={styles.runSettingsButtonSummary}>{runSettingsSummary}</span>
            <span style={{ display: 'inline-flex', transform: runSettingsOpen ? 'rotate(-90deg)' : 'rotate(90deg)' }}><UIIcon name="chevron" size={12} /></span>
          </button>
          {runSettingsOpen && (
            <>
              <div onClick={() => setRunSettingsOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
              <div style={styles.runSettingsMenu} onClick={event => event.stopPropagation()}>
                <label style={styles.runSettingGroup}>
                  <span style={styles.runSettingLabel}>Worker</span>
                  <select value={selectionValue} onChange={e => void onSelectionChange(e.target.value)} style={styles.runSettingSelect}>
                    <option value="none">No worker</option>
                    {workers.length > 0 && (
                      <optgroup label="Workers">
                        {workers.map(w => <option key={w.name} value={`worker:${w.name}`}>{w.name}</option>)}
                      </optgroup>
                    )}
                    {teamNames.length > 0 && (
                      <optgroup label="Teams">
                        {teamNames.map(n => <option key={n} value={`team:${n}`}>{n}</option>)}
                      </optgroup>
                    )}
                  </select>
                </label>
                {chat.selection.type === 'team' ? (
                  <div style={styles.runSettingsHint}>Teams choose their own agent routing.</div>
                ) : (
                  <>
                    <label style={styles.runSettingGroup}>
                      <span style={styles.runSettingLabel}>Agent</span>
                      <select
                        value={chat.agent ?? ''}
                        onChange={e => void onAgentChange(e.target.value)}
                        style={styles.runSettingSelect}
                        title={`Agent: ${effectiveAgent}${chat.agent ? ' (override)' : workerAgent ? ` (worker: ${selectedWorker!.name})` : ' (default)'}`}
                      >
                        <option value="">{effectiveAgent}</option>
                        {AGENT_NAMES.filter(n => enabledAgents.includes(n) || n === chat.agent).map(n => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </label>
                    <label style={styles.runSettingGroup}>
                      <span style={styles.runSettingLabel}>Model</span>
                      <select
                        value={chat.model ?? ''}
                        onChange={e => void onModelChange(e.target.value)}
                        style={styles.runSettingSelect}
                        title={`Model: ${effectiveModel ?? 'unset'}${chat.model ? ' (override)' : workerModel ? ` (worker: ${selectedWorker!.name})` : ' (default)'}`}
                        disabled={modelsForAgent.length === 0}
                      >
                        <option value="">{effectiveModel ?? 'agent default'}</option>
                        {modelsForAgent.map(m => (
                          <option key={m.model} value={m.model}>{m.model}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      onClick={() => void setSoloAdvisor(chat.id, !(chat.soloAdvisor ?? false))}
                      style={{ ...styles.advisorSetting, ...(chat.soloAdvisor ? styles.advisorSettingActive : undefined) }}
                      title={chat.soloAdvisor
                        ? `Advisor is on — ${effectiveAdvisorModel} can help when the selected model gets stuck`
                        : `Enable ${effectiveAdvisorModel} for help when the selected model gets stuck`}
                      role="switch"
                      aria-checked={chat.soloAdvisor ?? false}
                    >
                      <span style={styles.advisorSettingIdentity}>
                        <UIIcon name="sparkle" size={14} />
                        <span>Advisor</span>
                        <span style={styles.advisorModelName}>{effectiveAdvisorModel}</span>
                      </span>
                      <span>{chat.soloAdvisor ? 'On' : 'Off'}</span>
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setLinkMenuOpen(o => !o)}
            style={styles.linkBtn}
            title={chat.routes?.length ? 'Manage channel links' : 'Link to a channel'}
            aria-label="More actions"
          >
            <UIIcon name="more" size={17} />
          </button>
          {linkMenuOpen && (
            <>
              <div
                onClick={() => setLinkMenuOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 999 }}
              />
              <div style={styles.linkMenu} onClick={e => e.stopPropagation()}>
                {(['telegram', 'discord', 'imessage'] as const).map(ch => {
                  const linked = chat.routes?.find(r => r.channel === ch)
                  const label = ch === 'telegram' ? '✈ Telegram' : ch === 'discord' ? '◈ Discord' : '◐ iMessage'
                  return (
                    <button
                      key={ch}
                      style={{
                        ...styles.linkMenuItem,
                        background: linked ? C.red + '22' : 'transparent',
                        border: linked ? `1px solid ${C.red}55` : '1px solid transparent',
                        color: linked ? C.red : C.fg2,
                      }}
                      onClick={async () => {
                        setLinkMenuOpen(false)
                        if (linked) {
                          await unlinkChannel(chat.id, linked.channel, linked.channelUserId)
                          return
                        }
                        const existing = pairings.find(p => p.channel === ch)
                        if (existing) {
                          await linkChannel(chat.id, ch, existing.channelUserId)
                          return
                        }
                        pendingLinkChannelRef.current = ch
                        setPairingModal(ch)
                      }}
                      title={linked
                        ? `Disconnect ${ch} (${linked.channelUserId})`
                        : `Connect ${ch}`}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span
                          style={{
                            width: 6, height: 6, borderRadius: '50%',
                            background: linked ? C.green : C.fg3,
                            boxShadow: linked ? `0 0 6px ${C.green}` : 'none',
                          }}
                        />
                        {label}
                      </span>
                      <span style={{
                        fontSize: 14, fontWeight: 600,
                        color: linked ? C.red : C.accent,
                      }}>
                        {linked ? '✕' : '+'}
                      </span>
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
        <button
          onClick={() => bottomTerminalOpen ? setBottomTerminalOpen(false) : openChatTerminal()}
          style={{ ...styles.linkBtn, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '4px 6px' }}
          title={bottomTerminalOpen
            ? 'Hide bottom Terminal (⌘J)'
            : workingDir ? `Open Terminal in ${workingDir} (⌘J)` : 'Chat worktree is unavailable'}
          disabled={!workingDir}
          aria-label={bottomTerminalOpen ? 'Hide bottom Terminal' : 'Show bottom Terminal'}
        >
          <UIIcon name="terminal" color={C.fg} filled={bottomTerminalOpen} />
        </button>
        <button
          onClick={() => changeRightPanelMode(panelOpen ? null : 'overview')}
          style={{ ...styles.linkBtn, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '4px 6px' }}
          title={panelOpen ? 'Hide context panel (⌘\\)' : 'Show context panel (⌘\\)'}
          aria-label={panelOpen ? 'Hide context panel' : 'Show context panel'}
        >
          <UIIcon name="panel" color={C.fg} filled={panelOpen} />
        </button>
      </div>

      <div
        style={{ ...styles.messages, position: 'relative' }}
      >
        {groupMessages(chat.messages).map((item, idx) => {
          if (item.kind === 'team') {
            return (
              <TeamRunGroup
                key={item.teamTurnId}
                item={item}
                isStreaming={!!flight && item.messages[item.messages.length - 1]?.id === lastMsg?.id}
              />
            )
          }
          const msg = item.message
          const isUser = msg.role === 'user'
          const isSelected = !isUser && msg.id === selectedTurnId && overviewOpen
          return (
            <div key={msg.id}
              onDoubleClick={isUser ? undefined : () => {
                setSelectedTurnIdState(msg.id)
                setFollowLatest(false)
                // Double-click only selects the turn; it never reveals the
                // right panel. Use the panel toggle (⌘\) for that.
                if (overviewOpen) setPanelTab('current')
              }}
              style={{
                display: 'flex', flexDirection: 'column',
                alignItems: isUser ? 'flex-end' : 'flex-start',
                marginBottom: isUser ? 12 : 20,
                cursor: isUser ? 'default' : 'pointer',
                paddingLeft: !isUser ? MESSAGE_ROW_INSET : 0,
                transform: isSelected ? 'translateY(-3px)' : 'translateY(0)',
                transition: 'transform 0.18s ease',
              }}
            >
              <div style={isUser ? {
                minWidth: 0, maxWidth: '72%', padding: `10px ${USER_BUBBLE_PADDING_X}px`,
                borderRadius: '16px 16px 4px 16px',
                background: C.userBg,
                color: C.onAccent, fontSize: 13, lineHeight: 1.55,
                overflowWrap: 'anywhere', wordBreak: 'break-word',
              } : {
                // The bubble marks "what the user said". An assistant reply
                // reads as a document; the header rule below carries the
                // boundary the bubble used to provide.
                //
                // `ch` resolves against this element's 13px font, so 78ch is
                // ~562px. box-sizing is border-box, so the rail and the 27px of
                // horizontal padding come out of that, leaving ~535px of text —
                // about 68 characters of the 14px roomy body, or ~41 Chinese
                // characters. Unlike the old 72%, it does not grow with the
                // window.
                minWidth: 0, width: '100%', maxWidth: 'min(100%, 78ch)',
                // Padding on all four sides so the selected highlight reads as a
                // card rather than a rectangle cut through the text. It is
                // unconditional — applying it only when selected would shift the
                // whole reply the moment you click it.
                //
                // Right padding equals rail + left padding, so the text sits the
                // same distance from both inner edges of the highlight.
                padding: `8px ${TURN_RAIL_WIDTH + TURN_TEXT_PADDING}px 6px ${TURN_TEXT_PADDING}px`,
                // The rail is always present, transparent when unselected, so
                // selecting a turn never shifts the text column sideways.
                borderLeft: `${TURN_RAIL_WIDTH}px solid ${isSelected ? C.accent : 'transparent'}`,
                borderRadius: 10,
                background: isSelected ? C.accentDim : 'transparent',
                // Same treatment the rest of the app gives an active card
                // (teamStepCardActive, teamRoundTableMemberActive): a tint plus a
                // 1px accent ring, which defines the edge without a hard border.
                boxShadow: isSelected ? `0 0 0 1px ${C.accentDim}` : 'none',
                // fontSize/lineHeight stay compact: non-Markdown children
                // inherit them. Roomy applies inside <Markdown layout="roomy">.
                color: C.fg, fontSize: 13, lineHeight: 1.55,
                overflowWrap: 'anywhere', wordBreak: 'break-word',
                transition: 'border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease',
              }}>
                {!isUser && (() => {
                  const thinking = msg.thinking?.trim() ?? ''
                  // Keyed off the in-flight turn rather than msg.isComplete:
                  // messages persisted before isComplete existed would
                  // otherwise lose their rule and timestamp for good.
                  const streaming = !!flight && msg === lastMsg
                  const expanded = thinkingToggles[msg.id]
                    ?? defaultThinkingExpanded({
                      hasAnswer: !!msg.content.trim(),
                      isComplete: msg.isComplete ?? false,
                    })
                  return (
                    <>
                      <TurnHeader
                        msg={msg}
                        hasThinking={!!thinking}
                        turnComplete={!streaming}
                        expanded={expanded}
                        onToggle={() => setThinkingToggles(p => ({ ...p, [msg.id]: !expanded }))}
                      />
                      {!!thinking && expanded && (
                        <div style={styles.thinkingBody}>{thinking}</div>
                      )}
                    </>
                  )
                })()}
                {!isUser && !!flight && msg === lastMsg && (
                  <LiveActivity toolCalls={msg.toolCalls} />
                )}
                {(msg.content || (!isUser && msg.userQuestion?.question)) && (() => {
                  if (isUser) return <UserMessageContent content={msg.content} />
                  const text = msg.content || msg.userQuestion?.question || ''
                  const parsed = parseTeamMessage(text)
                  const isStreaming = !!flight && msg === lastMsg
                  if (!parsed) return (
                    <div>
                      <Markdown variant="assistant" layout="roomy">{text}</Markdown>
                    </div>
                  )
                  return (
                    <TeamMessage
                      messageId={msg.id}
                      parsed={parsed}
                      isStreaming={isStreaming}
                      isComplete={msg.isComplete ?? false}
                      thinkingByStep={msg.thinkingByStep}
                      expanded={expandedSteps}
                      setExpanded={setExpandedSteps}
                    />
                  )
                })()}
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
              {msg.role === 'assistant'
                && idx === chat.messages.length - 1
                && chat.messages[chat.messages.length - 1]?.role !== 'user'
                && msg.userQuestion
                && msg.userQuestion.options.length > 0
                && (
                  msg.userQuestion.multiSelect ? (
                    <div style={styles.choiceRow} onDoubleClick={e => e.stopPropagation()}>
                      {msg.userQuestion.options.map((opt, i) => {
                        const picked = multiChoice.includes(opt.label)
                        return (
                          <button
                            key={i}
                            style={{
                              ...styles.choiceButton,
                              ...(picked ? styles.choiceButtonPicked : null),
                            }}
                            disabled={isSending || !!flight}
                            onClick={() => setMultiChoice(prev =>
                              prev.includes(opt.label)
                                ? prev.filter(l => l !== opt.label)
                                : [...prev, opt.label]
                            )}
                          >
                            <span style={styles.choiceLabel}>
                              <span style={styles.choiceCheck}>{picked ? '☑' : '☐'}</span>
                              {opt.label}
                            </span>
                            {opt.description && <span style={styles.choiceDesc}>{opt.description}</span>}
                          </button>
                        )
                      })}
                      <button
                        style={{
                          ...styles.choiceSubmit,
                          opacity: multiChoice.length === 0 ? 0.5 : 1,
                          cursor: multiChoice.length === 0 ? 'default' : 'pointer',
                        }}
                        disabled={isSending || !!flight || multiChoice.length === 0}
                        onClick={() => { void sendMessage(chat.id, multiChoice.join(', ')) }}
                      >
                        Submit{multiChoice.length > 0 ? ` (${multiChoice.length})` : ''}
                      </button>
                    </div>
                  ) : (
                    <div style={styles.choiceRow} onDoubleClick={e => e.stopPropagation()}>
                      {msg.userQuestion.options.map((opt, i) => (
                        <button
                          key={i}
                          style={styles.choiceButton}
                          disabled={isSending || !!flight}
                          onClick={() => { void sendMessage(chat.id, opt.label) }}
                        >
                          <span style={styles.choiceLabel}>{opt.label}</span>
                          {opt.description && <span style={styles.choiceDesc}>{opt.description}</span>}
                        </button>
                      ))}
                    </div>
                  )
                )
              }
              {msg.role === 'assistant'
                && !msg.userQuestion
                && msg.choices
                && msg.choices.length > 0
                && idx === chat.messages.length - 1
                && chat.messages[chat.messages.length - 1]?.role !== 'user'
                && (
                  <div style={styles.choiceRow}>
                    {msg.choices.map((label, i) => (
                      <button
                        key={i}
                        style={styles.choiceButton}
                        disabled={isSending || !!flight}
                        onClick={() => { void sendMessage(chat.id, label) }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )
              }
              {msg.role === 'assistant'
                && idx === chat.messages.length - 1
                && state.pendingPermissions[chatId]
                && (
                  <div style={styles.permissionBanner}>
                    <span style={styles.permissionText}>
                      Needs permission: {state.pendingPermissions[chatId].join(', ')}
                    </span>
                    <div style={styles.permissionActions}>
                      <button style={styles.permissionAllow} onClick={() => {
                        void resolvePermission(chatId, true).catch(err => alert(`Couldn’t grant permission: ${(err as Error).message}`))
                      }}>Accept</button>
                      <button style={styles.permissionDeny} onClick={() => { void resolvePermission(chatId, false) }}>Deny</button>
                    </div>
                  </div>
                )
              }
              {/* Model, fallback, tokens and duration now live in TurnHeader.
                  The timestamp stays here so it does not compete with the
                  turn's identity for the reader's attention. */}
              {/* The timestamp records when the turn landed, so it waits until
                  the turn has landed. */}
              {!(!isUser && !!flight && msg === lastMsg) && (
              <div
                style={{
                  ...styles.tsLabel,
                  // A user turn is right-aligned, so its timestamp lines up on
                  // the bubble's right text edge; an assistant turn is
                  // left-aligned, so its timestamp lines up on the left. The
                  // footer sits inside the message row, which already carries
                  // MESSAGE_ROW_INSET, so only the remainder is needed there.
                  paddingLeft: isUser ? 0 : TURN_TEXT_INSET - MESSAGE_ROW_INSET,
                  paddingRight: isUser ? USER_BUBBLE_PADDING_X : 0,
                }}
              >
                <span>{fmtTime(msg.timestamp)}</span>
              </div>
              )}
            </div>
          )
        })}
        {statusLabel && (
          <div style={styles.typingRow}>
            <ShimmerStatus label={statusLabel} />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {orphaned && (
        <div style={styles.orphanBanner}>
          Workspace "{chat.workspaceName}" no longer exists. Sending is disabled.
        </div>
      )}
      <div style={{ ...styles.inputContainer, position: 'relative' as const }}>
        {showSlashMenu && (
          <div ref={slashMenuRef} style={styles.slashMenu}>
            {filteredSlash.map((cmd, i) => (
              <div
                key={cmd.name}
                style={{ ...styles.slashMenuItem, ...(i === slashIdx ? styles.slashMenuItemActive : {}) }}
                onMouseDown={e => { e.preventDefault(); setInput(`/${cmd.name} `) }}
                onMouseEnter={() => setSlashIdx(i)}
              >
                <span style={styles.slashCmdName}>/{cmd.name}</span>
                <span style={styles.slashCmdDesc}>{cmd.description}</span>
              </div>
            ))}
          </div>
        )}
        {uploadError && (
          <div style={styles.uploadError}>{uploadError}</div>
        )}
        <div style={styles.composer}>
          <div
            style={styles.composerResizeHandle}
            onMouseEnter={() => setComposerHandleHover(true)}
            onMouseLeave={() => setComposerHandleHover(false)}
            onMouseDown={startComposerResize}
            onDoubleClick={() => setComposerHeight(null)}
            title="Drag to resize · double-click to reset"
          >
            <div style={{
              ...styles.composerResizeGrip,
              opacity: composerHandleHover || composerResizing ? 1 : 0,
            }} />
          </div>
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
          <div style={styles.composerInputRow}>
            <textarea
              ref={taRef}
              value={input}
              onChange={e => { setInputHistoryIndex(null); setInput(e.target.value) }}
              onKeyDown={handleKey}
              onInput={e => {
                if (composerHeight != null) return // manual height pinned
                const el = e.currentTarget
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 120) + 'px'
              }}
              placeholder={composerPlaceholder({ coreFailed: !!coreFailed, isGatewayRunning, isSending })}
              disabled={!isGatewayRunning || !!coreFailed}
              rows={1}
              style={composerHeight != null
                ? { ...styles.input, height: composerHeight, maxHeight: 'none' }
                : styles.input}
            />
          </div>
          <div style={styles.composerToolbar}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,text/*,.json,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.css,.html,.md,.yaml,.yml,.toml,.xml,.sh,.bash,.zsh,.log,.csv,.sql"
              style={{ display: 'none' }}
              onChange={handleFilePick}
            />
            <div style={styles.composerTools}>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={!isGatewayRunning || !!coreFailed || isSending}
                style={styles.attachButton}
                title="Attach file"
              >
                <PaperclipIcon color={isGatewayRunning && !isSending ? C.fg2 : C.fg3} />
              </button>
            </div>
            <div style={styles.voiceIndicatorSlot}>
              {voice.state !== 'idle' && (
                <div
                  style={styles.voiceIndicator}
                  role="status"
                  aria-label={`${voice.mode === 'converse' ? 'Conversation' : 'Dictation'} ${voice.state}`}
                >
                  <VoiceMeter
                    level={voice.level}
                    idle={voice.state === 'transcribing' || (voice.state === 'speaking' && voice.level === 0)}
                    height={24}
                    barCount={7}
                    sensitivity={2.4}
                    color={C.green}
                    colors={voice.mode === 'converse' ? VOICE_GRADIENT_COLORS : undefined}
                  />
                  {voice.state === 'recording' && <VoiceElapsed since={voice.recordingStartedAt} />}
                </div>
              )}
            </div>
            <div style={styles.composerActions}>
              {/* Two ways to use your voice: dictate into the composer, or
                  hold a spoken conversation that reads the reply back. */}
              {!(voice.state === 'recording' && voice.mode === 'converse') && <button
                onClick={() => voice.toggle('dictate')}
                disabled={!isGatewayRunning || !!coreFailed}
                style={{
                  ...styles.voiceButton,
                  background: voiceBusy && voice.mode === 'dictate' ? C.red : 'transparent',
                  cursor: isGatewayRunning && !coreFailed ? 'pointer' : 'default',
                }}
                title={
                  voiceBusy && voice.mode === 'dictate'
                    ? (voice.state === 'transcribing' ? 'Transcribing…' : 'Stop — text goes to the box')
                    : 'Dictate into the message box'
                }
              >
                {voice.state === 'recording' && voice.mode === 'dictate'
                  ? <StopIcon color="#fff" />
                  : <UIIcon
                      name="mic"
                      size={19}
                      color={voiceBusy && voice.mode === 'dictate' ? '#fff' : C.fg2}
                    />}
              </button>}
              {!(voice.state === 'recording' && voice.mode === 'dictate') && <button
                onClick={() => voice.toggle('converse')}
                disabled={!isGatewayRunning || !!coreFailed}
                style={{
                  ...styles.voiceButton,
                  background: voice.state === 'recording' && voice.mode === 'converse' ? C.red
                    : voice.state === 'speaking' ? C.accent
                    : 'transparent',
                  cursor: isGatewayRunning && !coreFailed ? 'pointer' : 'default',
                }}
                title={
                  voice.state === 'speaking' ? 'Speaking — click to interrupt and talk'
                  : voiceBusy && voice.mode === 'converse'
                    ? (voice.state === 'transcribing' ? 'Transcribing…' : 'Stop and send')
                    : 'Talk to this chat — the reply is read back'
                }
              >
                {voice.state === 'recording' && voice.mode === 'converse'
                  ? <StopIcon color="#fff" />
                  : <UIIcon
                      name="waveform"
                      size={19}
                      color={voice.state === 'speaking' ? C.onAccent : C.fg2}
                    />}
              </button>}
              {isSending ? (
                <button
                  onClick={() => stopChat(chatId)}
                  style={{ ...styles.sendButton, background: C.red, cursor: 'pointer' }}
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
                  <SendIcon color={canSend ? C.onAccent : C.fg3} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {pairingModal && (
        <PairingModal
          channel={pairingModal}
          onClose={async () => {
            const ch = pairingModal
            setPairingModal(null)
            const fresh = await refreshPairings()
            const pending = pendingLinkChannelRef.current
            pendingLinkChannelRef.current = null
            if (pending && pending === ch) {
              const newly = fresh.find(p => p.channel === pending)
              const alreadyOnChat = chat.routes?.some(r => r.channel === pending)
              if (newly && !alreadyOnChat) {
                try { await linkChannel(chat.id, pending, newly.channelUserId) } catch { /* noop */ }
              }
            }
          }}
        />
      )}
      {showPrModal && (
        <CreatePrModal
          defaultTitle={chat?.taskBrief?.goal || gitStatus?.branch || ''}
          onCancel={() => setShowPrModal(false)}
          onCreate={async (input) => {
            if (!workingDir) return { ok: false, error: 'No working dir' }
            const r = await window.codey.git.createPr(workingDir, input)
            return r.ok ? r.data : { ok: false, error: r.error || 'Failed' }
          }}
        />
      )}
      {bottomTerminalOpen && workingDir && (
        <div style={{ ...styles.bottomTerminal, height: bottomTerminalHeight }}>
          <div
            style={styles.bottomTerminalResizer}
            onPointerDown={startBottomTerminalResize}
            title="Resize bottom Terminal"
          />
          <TerminalPanel
            key={`${chat.id}:${workingDir}`}
            chatId={chat.id}
            workingDir={workingDir}
            placement="bottom"
            onMove={() => {
              setBottomTerminalOpen(false)
              changeRightPanelMode('terminal')
            }}
            onClose={() => setBottomTerminalOpen(false)}
          />
        </div>
      )}
      </div>
      {/* Overview, Terminal, and Browser share this single right panel. On a
          narrow window it overlays the chat so the conversation remains usable. */}
      {(() => {
        const CHAT_LIST_W = windowWidth < 600 ? 180 : 240
        const MIN_MIDDLE = 360

        if (panelOpen && resolvedRightPanelMode) {
          const MIN_PANEL = 320
          const available = windowWidth - CHAT_LIST_W - MIN_MIDDLE
          const overlay = available < MIN_PANEL
          const effectiveWidth = overlay
            ? Math.min(rightPanelWidth, Math.max(MIN_PANEL, windowWidth - 72))
            : Math.min(rightPanelWidth, available)
          const overview = (
            <ChatContextPanel
              chat={chat}
              selectedTurnId={selectedTurnId}
              followLatest={followLatest}
              selectedTurnIndex={selectedTurnIndex}
              effectiveAgent={effectiveAgent}
              effectiveModel={effectiveModel}
              workerName={panelWorkerName}
              teamName={panelTeamName}
              teamGraph={panelTeamGraph}
              workingDir={workingDir}
              width={effectiveWidth}
              embedded
              onFollowLatest={() => setFollowLatest(true)}
              onClose={() => changeRightPanelMode(null)}
              onResize={onRightPanelResize}
              onRevealFile={(p) => apiService.revealInFolder(p)}
              onScrollToStep={(mid, step) => {
                document.getElementById(stepDomId(mid, step))?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }}
              isTurnStreaming={!!flight && selectedTurnId === lastMsg?.id}
              activeTab={panelTab}
              onTabChange={setPanelTab}
              qqInputRef={qqInputRef}
              onAnswerNextAction={() => taRef.current?.focus()}
              taskBriefLoading={taskBriefLoading}
              onTaskTabShown={async () => {
                if (!isTaskBriefStale(chat)) return
                setTaskBriefLoading(true)
                try { await generateTaskBrief(chat.id) } finally { setTaskBriefLoading(false) }
              }}
            />
          )
          return (
            <WorkspaceDock
              tool={resolvedRightPanelMode}
              width={effectiveWidth}
              overview={overview}
              chatId={chat.id}
              workingDir={workingDir}
              loginWait={browserLoginWait}
              onConfirmLoginWait={onConfirmBrowserLogin}
              onDismissLoginWait={onDismissBrowserLogin}
              onSelectTool={(tool) => {
                if (tool === 'terminal') setBottomTerminalOpen(false)
                changeRightPanelMode(tool)
              }}
              onClose={() => changeRightPanelMode(null)}
              onResize={onRightPanelResize}
              onDockTerminalBottom={() => {
                setBottomTerminalOpen(true)
                changeRightPanelMode('overview')
              }}
              overlay={overlay}
            />
          )
        }

        // Panel closed → light Status sidecar. Hidden until there's a brief to
        // show (self-population kicks it off via the effect above).
        if (!sidecarVisible || !chat?.taskBrief) return null
        return (
          <StatusSidecar
            view={extractSidecarBrief(chat.taskBrief)}
            checklist={chat.checklist}
            loading={taskBriefLoading}
            compact={statusSidecarHidden}
            width={SIDECAR_W}
            onHide={() => setGlobalStatusSidecarHidden(true)}
            onRestore={() => setGlobalStatusSidecarHidden(false)}
            branchAhead={branchAhead}
            onCreatePr={() => setShowPrModal(true)}
            onOpen={() => { changeRightPanelMode('overview'); setPanelTab('task') }}
          />
        )
      })()}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  outer: { display: 'flex', flexDirection: 'row', height: '100%', minHeight: 0, position: 'relative' },
  container: { display: 'flex', flexDirection: 'column', height: '100%', flex: 1, minWidth: 0, position: 'relative' },
  bottomTerminal: {
    position: 'relative', flexShrink: 0, minHeight: 180, maxHeight: '70%',
    borderTop: `1px solid ${C.border2}`, boxShadow: '0 -10px 28px rgba(0,0,0,0.14)', zIndex: 8,
  },
  bottomTerminalResizer: {
    position: 'absolute', left: 0, right: 0, top: -4, height: 8, cursor: 'row-resize', zIndex: 20,
  },
  header: {
    padding: '10px 18px', borderBottom: `1px solid ${C.border}`,
    display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
    flexWrap: 'wrap', rowGap: 8, background: C.surface,
  },
  headerIdentity: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  workspaceTag: { color: C.fg2, fontSize: 11, fontWeight: 650, flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5 },
  gitBadge: {
    color: C.fg3, fontSize: 11, flexShrink: 0,
    background: C.surface3, border: `1px solid ${C.border2}`,
    borderRadius: 4, padding: '2px 6px',
    fontFamily: 'SF Mono, Menlo, monospace',
    maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  },
  workerSelect: {
    background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 6,
    color: C.fg2, fontSize: 12, padding: '4px 8px', outline: 'none',
    flexShrink: 0, maxWidth: 180,
  },
  openInWrap: { position: 'relative', flexShrink: 0 },
  openInSplit: { display: 'inline-flex', alignItems: 'stretch', height: 32 },
  openInPrimary: {
    border: `1px solid ${C.border2}`, borderRadius: '6px 0 0 6px', padding: '4px 8px', background: C.surface3,
    color: C.fg2, cursor: 'pointer', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5,
    height: 32, boxSizing: 'border-box',
  },
  openInDropdown: {
    border: `1px solid ${C.border2}`, borderLeft: 'none', borderRadius: '0 6px 6px 0', padding: '4px 6px', background: C.surface3,
    color: C.fg3, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    height: 32, boxSizing: 'border-box',
  },
  runSettingsWrap: { position: 'relative', flexShrink: 0 },
  runSettingsButton: {
    border: `1px solid ${C.border2}`, borderRadius: 6, padding: '4px 8px', background: C.surface3,
    color: C.fg2, cursor: 'pointer', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 7,
    maxWidth: 310, textAlign: 'left', height: 32, boxSizing: 'border-box',
  },
  runSettingsButtonSummary: { color: C.fg2, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  runSettingsMenu: {
    position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 1000, minWidth: 244,
    padding: 10, borderRadius: 9, background: C.surface2, border: `1px solid ${C.border2}`,
    boxShadow: '0 12px 28px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column', gap: 9,
  },
  runSettingGroup: { display: 'flex', flexDirection: 'column', gap: 4 },
  runSettingLabel: { color: C.fg3, fontSize: 10, fontWeight: 700, letterSpacing: 0.45, textTransform: 'uppercase' },
  runSettingSelect: {
    width: '100%', minWidth: 0, background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 6,
    color: C.fg2, fontSize: 12, padding: '6px 8px', outline: 'none',
  },
  runSettingsHint: { padding: '4px 0', color: C.fg3, fontSize: 11, lineHeight: 1.4 },
  advisorSetting: {
    width: '100%', border: `1px solid ${C.border2}`, borderRadius: 6, padding: '7px 8px', background: C.surface3,
    color: C.fg3, cursor: 'pointer', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  },
  advisorSettingIdentity: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 },
  advisorModelName: {
    maxWidth: 112, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
    color: C.fg3, fontSize: 10, fontFamily: 'monospace', fontWeight: 500,
  },
  advisorSettingActive: { border: `1px solid ${C.accent}`, background: C.accentDim, color: C.accent, fontWeight: 600 },
  editorMenu: {
    position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 1000, minWidth: 205,
    padding: 4, borderRadius: 9, background: C.surface2, border: `1px solid ${C.border2}`,
    boxShadow: '0 12px 28px rgba(0,0,0,0.3)',
  },
  editorMenuItem: {
    width: '100%', border: 'none', borderRadius: 6, padding: '8px 9px', background: 'transparent', color: C.fg2,
    cursor: 'pointer', fontSize: 12, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8,
  },
  editorIcon: {
    width: 18, height: 18, objectFit: 'contain', flexShrink: 0,
    padding: 1.5, borderRadius: 4, background: '#fff', boxSizing: 'border-box',
  },
  editorMenuIcon: {
    width: 16, height: 16, objectFit: 'contain', flexShrink: 0,
    padding: 1, borderRadius: 4, background: '#fff', boxSizing: 'border-box',
  },
  editorOpeningLabel: { color: C.fg2, fontSize: 11, whiteSpace: 'nowrap' },
  editorMenuEmpty: { color: C.fg3, fontSize: 11, lineHeight: 1.4, padding: '8px 9px', maxWidth: 220 },
  messages: { flex: 1, overflowY: 'auto', padding: '22px max(22px, 5%)', background: C.bg },
  // The status row is a direct child of `messages`, not of a message row, so it
  // carries the full inset rather than the remainder.
  typingRow: {
    display: 'flex', alignItems: 'center', gap: 8, color: C.fg3, fontSize: 13,
    marginBottom: 12, paddingLeft: TURN_TEXT_INSET,
  },
  // Horizontal padding is set per role at the render site — the timestamp has to
  // line up with the reply above it, which is inset differently (and from the
  // opposite edge) for user and assistant.
  tsLabel: { color: C.fg3, fontSize: 10, marginTop: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  // modelBadge is still used by team worker messages; tsRight, tsMeta and
  // fallbackBadge moved into TurnHeader with the metadata they styled.
  modelBadge: {
    color: C.fg3, background: C.surface3, border: `1px solid ${C.border2}`,
    borderRadius: 5, padding: '1px 6px', fontSize: 10,
    fontFamily: 'SF Mono, Menlo, monospace',
    maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  inputContainer: { padding: '12px max(16px, 4%) 16px', borderTop: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, background: C.surface },
  composer: {
    background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: 14,
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    position: 'relative' as const,
  },
  // Absolutely positioned over the composer's top edge so it adds no vertical
  // space — the input stays compact and the grip only shows on hover.
  composerResizeHandle: {
    position: 'absolute' as const, top: 0, left: 0, right: 0, height: 8,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'ns-resize', zIndex: 2,
  },
  composerResizeGrip: {
    width: 26, height: 3, borderRadius: 2, background: C.fg3,
    transition: 'opacity 0.12s ease',
  },
  composerInputRow: { display: 'flex', padding: '12px 13px 4px' },
  composerToolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, padding: '4px 7px 7px',
  },
  composerTools: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 },
  voiceIndicatorSlot: {
    minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '0 12px',
  },
  voiceIndicator: {
    minWidth: 0, width: '100%', maxWidth: 240, height: 32,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
    padding: '0 6px', overflow: 'hidden',
  },
  composerActions: { display: 'flex', alignItems: 'center', gap: 4 },
  input: {
    width: '100%', background: 'transparent', border: 'none', borderRadius: 8,
    color: C.fg, fontSize: 13, padding: '4px 2px', outline: 'none', resize: 'none',
    lineHeight: 1.5, maxHeight: 120, overflowY: 'auto',
  },
  sendButton: {
    width: 38, height: 38, borderRadius: 11, border: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, transition: 'background 0.15s',
  },
  voiceButton: {
    width: 36, height: 36, borderRadius: 9, border: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, transition: 'background 0.15s',
  },
  iconButtonPlus: { fontSize: 12, lineHeight: 1, marginLeft: 1, color: C.accent, fontWeight: 700 },
  orphanBanner: { padding: '8px 12px', background: C.warningBg, color: C.warningFg, fontSize: 12, borderTop: `1px solid ${C.border}` },
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
    color: C.dangerFg, fontSize: 11, padding: '0 4px',
  },
  choiceRow: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'stretch' as const,
    gap: 8,
    marginTop: 8,
    marginLeft: 12,
  },
  choiceButton: {
    padding: '6px 12px',
    borderRadius: 6,
    border: `1px solid ${C.border2}`,
    background: C.surface3,
    color: C.fg,
    cursor: 'pointer',
    fontSize: 13,
    textAlign: 'left' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
  },
  choiceButtonPicked: {
    border: `1px solid ${C.accent}`,
    background: C.accentDim,
  },
  choiceSubmit: {
    alignSelf: 'flex-start' as const,
    padding: '6px 16px',
    borderRadius: 6,
    border: 'none',
    background: C.accent,
    color: '#fff',
    fontSize: 13,
    fontWeight: 600 as const,
  },
  choiceLabel: {
    fontWeight: 500 as const,
    display: 'flex',
    alignItems: 'center' as const,
    gap: 6,
  },
  choiceCheck: {
    fontSize: 13,
  },
  choiceDesc: {
    fontSize: 11,
    color: C.fg2,
    lineHeight: '1.3',
  },
  permissionBanner: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    marginTop: 8,
    marginLeft: 12,
    padding: '8px 12px',
    borderRadius: 6,
    border: `1px solid ${C.border2}`,
    background: C.surface3,
  },
  permissionText: {
    fontSize: 12,
    color: C.fg2,
  },
  permissionActions: {
    display: 'flex',
    gap: 8,
  },
  permissionAllow: {
    padding: '4px 12px',
    borderRadius: 4,
    border: 'none',
    background: C.accent,
    color: C.onAccent,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500 as const,
  },
  permissionDeny: {
    padding: '4px 12px',
    borderRadius: 4,
    border: `1px solid ${C.border2}`,
    background: 'transparent',
    color: C.fg2,
    cursor: 'pointer',
    fontSize: 12,
  },
  voiceStatusText: {
    color: C.fg2, fontSize: 11, fontVariantNumeric: 'tabular-nums',
  },
  attachButton: {
    width: 36, height: 36, borderRadius: 9, border: 'none',
    background: 'transparent', display: 'flex', alignItems: 'center',
    justifyContent: 'center', flexShrink: 0, cursor: 'pointer',
    transition: 'background 0.15s',
  },
  linkBtn: {
    marginLeft: 6,
    padding: '4px 8px',
    background: 'transparent',
    border: `1px solid ${C.border}`,
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    color: C.fg,
    height: 32,
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkMenu: {
    position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 1000,
    minWidth: 180, padding: 4,
    background: C.surface2 ?? C.surface,
    border: `1px solid ${C.border2}`,
    borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    display: 'flex', flexDirection: 'column',
  },
  linkMenuItem: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: 12, background: 'transparent', border: 'none',
    padding: '6px 10px', borderRadius: 4, color: C.fg2,
    fontSize: 12, cursor: 'pointer', textAlign: 'left',
  },
  teamSummary: {
    fontSize: 13, fontWeight: 600, color: C.accent,
    padding: '6px 8px', marginBottom: 8,
    borderLeft: `3px solid ${C.accent}`, background: 'rgba(255,255,255,0.03)',
    borderRadius: 4,
  },
  teamStepCard: {
    marginBottom: 10, padding: '8px 10px',
    background: 'rgba(255,255,255,0.025)',
    border: `1px solid ${C.border2}`, borderRadius: 8,
  },
  teamStepCardActive: {
    border: `1px solid ${C.accent}`,
    boxShadow: `0 0 0 1px ${C.accentDim}`,
    background: 'rgba(43,230,155,0.06)',
  },
  teamStepHeader: {
    display: 'flex', alignItems: 'baseline', cursor: 'pointer',
    fontSize: 12, color: C.fg2, padding: '2px 0', userSelect: 'none' as const,
  },
  teamStepRunning: {
    marginLeft: 8, fontSize: 10, color: C.accent,
    fontStyle: 'italic',
  },
  teamStepChevron: {
    display: 'inline-block', fontSize: 11, marginRight: 6,
    transition: 'transform 0.15s ease', color: C.fg3, flexShrink: 0,
  },
  teamStepLabel: { color: C.fg, fontWeight: 500 },
  teamStepPreview: {
    color: C.fg3, fontStyle: 'italic', marginLeft: 4,
    whiteSpace: 'nowrap' as const, overflow: 'hidden' as const, textOverflow: 'ellipsis',
    flex: 1, minWidth: 0,
  },
  teamStepBody: { marginTop: 4, marginLeft: 17 },
  teamGroup: { border: `1px solid ${C.border}`, borderRadius: 12, margin: '8px 0 14px', overflow: 'hidden', background: C.surface2 },
  teamGroupHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', cursor: 'pointer', borderBottom: `1px solid ${C.border}` },
  teamGroupIdentity: { display: 'flex', alignItems: 'center', gap: 7, flex: 1, minWidth: 0 },
  teamGroupTitle: { fontSize: 13, fontWeight: 700, color: C.fg, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  teamModeBadge: {
    fontSize: 10, fontWeight: 500, color: C.fg3, whiteSpace: 'nowrap' as const,
  },
  teamGroupProgress: { fontSize: 10, color: C.fg3, whiteSpace: 'nowrap' as const },
  teamGroupHeaderActions: { display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 },
  teamWhiteboardButton: {
    flexShrink: 0, padding: '4px 8px', borderRadius: 6,
    border: `1px solid ${C.border2}`, background: C.surface3,
    color: C.fg2, fontSize: 10, fontWeight: 600, cursor: 'pointer',
  },
  teamWhiteboardButtonActive: {
    color: C.accent, border: `1px solid ${C.accent}66`, background: C.accentDim,
  },
  teamSummaryPanel: {
    padding: '4px 12px 12px',
    background: C.surface2,
  },
  teamSummaryCollapse: { borderTop: `1px solid ${C.border2}`, background: C.surface2 },
  teamSummaryToggle: {
    display: 'flex', alignItems: 'center', width: '100%', padding: '9px 12px',
    border: 'none', background: 'transparent', color: C.fg2,
    fontSize: 11, fontWeight: 600, textAlign: 'left' as const, cursor: 'pointer',
  },
  teamSummaryToggleOpen: { color: C.accent },
  teamSummarySection: {
    marginTop: 7, padding: '9px 10px', borderRadius: 8,
    border: `1px solid ${C.border2}`, background: C.surface,
  },
  teamSummarySectionTitle: {
    marginBottom: 6, color: C.fg3, fontSize: 9, fontWeight: 700,
    textTransform: 'uppercase' as const, letterSpacing: '0.05em',
  },
  teamSummaryList: { margin: 0, paddingLeft: 17 },
  teamSummaryListItem: { marginTop: 4, color: C.fg2, fontSize: 11, lineHeight: 1.45 },
  teamSummaryMuted: { color: C.fg3, fontSize: 11, lineHeight: 1.45 },
  teamWhiteboardPanel: {
    padding: '12px 14px 14px',
    background: C.surface2,
  },
  teamWhiteboardPanelHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 7,
  },
  teamWhiteboardPanelIdentity: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  teamWhiteboardCloseButton: {
    width: 26, height: 26, display: 'grid', placeItems: 'center', flexShrink: 0,
    padding: 0, border: 'none', borderRadius: 7, background: 'transparent',
    color: C.fg3, cursor: 'pointer',
  },
  teamWhiteboardModalBackdrop: {
    position: 'fixed' as const, inset: 0, zIndex: 1200,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    background: 'rgba(0,0,0,0.42)',
  },
  teamWhiteboardModal: {
    width: 'min(520px, calc(100vw - 40px))', maxHeight: 'min(560px, calc(100vh - 80px))',
    overflowY: 'auto' as const, border: `1px solid ${C.border}`, borderRadius: 12,
    background: C.surface2, boxShadow: '0 18px 55px rgba(0,0,0,0.38)',
  },
  teamWhiteboardEntry: {
    display: 'flex', alignItems: 'flex-start', gap: 9, padding: '7px 0',
    borderTop: `1px solid ${C.border2}`,
  },
  teamWhiteboardEntryCopy: { minWidth: 0, flex: 1 },
  teamWhiteboardSource: { marginTop: 3, color: C.fg3, fontSize: 9 },
  teamWhiteboardShared: {
    marginTop: 8, padding: '8px 9px', borderRadius: 8,
    border: `1px solid ${C.border2}`, background: C.surface,
  },
  teamWhiteboardEmpty: { padding: '8px 0 2px', color: C.fg3, fontSize: 10 },
  teamSpatialStage: {
    padding: '10px 12px 12px', borderBottom: `1px solid ${C.border2}`,
    background: C.surface,
  },
  teamSpatialHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 10, marginBottom: 7,
  },
  teamSpatialTitle: {
    color: C.fg3, fontSize: 10, fontWeight: 600,
    textTransform: 'uppercase' as const, letterSpacing: '0.04em',
  },
  teamRoundTableSpace: {
    position: 'relative', height: 280, overflow: 'hidden',
    borderRadius: 12, background: C.surface2,
    border: `1px solid ${C.border2}`,
  },
  teamRoundTableCenter: {
    position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
    width: 148, height: 72, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', borderRadius: '50%',
    border: `1px solid ${C.border}`, background: C.surface3,
    boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
  },
  teamRoundTableCenterTitle: { color: C.fg, fontSize: 12, fontWeight: 600 },
  teamRoundTableCenterSub: { marginTop: 3, color: C.fg3, fontSize: 9 },
  teamRoundTableMember: {
    position: 'absolute', transform: 'translate(-50%, -50%)',
    display: 'flex', alignItems: 'center', gap: 7, width: 150,
    padding: '7px 8px', borderRadius: 10, border: `1px solid ${C.border2}`,
    background: C.surface, boxShadow: '0 5px 14px rgba(0,0,0,0.12)', cursor: 'pointer',
  },
  teamRoundTableMemberActive: {
    border: `1px solid ${C.accent}`, boxShadow: `0 0 0 1px ${C.accentDim}, 0 5px 16px rgba(0,0,0,0.14)`,
  },
  teamSpatialAvatar: {
    position: 'relative', display: 'inline-grid', placeItems: 'center',
    width: 32, height: 32, flexShrink: 0, borderRadius: 10,
    background: C.surface3, fontSize: 19,
  },
  teamSpatialStatus: {
    position: 'absolute', right: -2, bottom: -2, width: 8, height: 8,
    borderRadius: '50%', border: `2px solid ${C.surface}`,
  },
  teamSpatialMemberCopy: { minWidth: 0, flex: 1 },
  teamSpatialMemberName: {
    color: C.fg, fontSize: 10, fontWeight: 600,
    whiteSpace: 'nowrap' as const, overflow: 'hidden' as const, textOverflow: 'ellipsis',
  },
  teamSpatialSpeech: {
    marginTop: 3, color: C.fg3, fontSize: 9, fontStyle: 'italic',
    whiteSpace: 'nowrap' as const, overflow: 'hidden' as const, textOverflow: 'ellipsis',
  },
  teamRoundTableDetail: {
    marginTop: 8, padding: '9px 10px', borderRadius: 10,
    border: `1px solid ${C.border2}`, background: C.surface2,
  },
  teamWorkflow: { display: 'flex', flexDirection: 'column', gap: 0, padding: '2px 0' },
  teamWorkflowStage: {
    position: 'relative', display: 'grid', gridTemplateColumns: '24px 34px minmax(0, 1fr)',
    alignItems: 'start', gap: 9, minHeight: 64, padding: '7px 0', cursor: 'pointer',
  },
  teamWorkflowLine: {
    position: 'absolute', left: 11, top: 31, bottom: -31,
    width: 2, background: C.border2,
  },
  teamWorkflowIndex: {
    position: 'relative', zIndex: 1, display: 'grid', placeItems: 'center',
    width: 24, height: 24, borderRadius: '50%', color: C.fg3,
    marginTop: 5, background: C.surface3, border: `1px solid ${C.border2}`, fontSize: 9,
  },
  teamWorkflowIndexActive: { color: C.accent, border: `1px solid ${C.accent}`, background: C.accentDim },
  teamWorkflowCard: {
    minWidth: 0, padding: '7px 9px', borderRadius: 9,
    border: `1px solid ${C.border2}`, background: C.surface2,
  },
  teamWorkflowCardActive: { border: `1px solid ${C.accent}`, background: C.accentDim },
  teamWorkflowCardHead: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  teamWorkflowColumn: { minWidth: 0 },
  teamWorkflowSpeech: {
    marginTop: 4, color: C.fg3, fontSize: 10, fontStyle: 'italic',
    whiteSpace: 'nowrap' as const, overflow: 'hidden' as const, textOverflow: 'ellipsis',
  },
  teamInlineRunDetail: {
    marginTop: 6, padding: '10px 11px', borderRadius: 9,
    border: `1px solid ${C.border2}`, background: C.surface,
    cursor: 'default',
  },
  teamInlineRunSection: { marginBottom: 10 },
  teamInlineRunLabel: {
    marginBottom: 5, color: C.fg3, fontSize: 9, fontWeight: 700,
    textTransform: 'uppercase' as const, letterSpacing: '0.05em',
  },
  teamInlineRunReason: { color: C.fg2, fontSize: 11, lineHeight: 1.5 },
  teamInlineRunMeta: { color: C.fg3, fontSize: 9, textAlign: 'right' as const },
  teamHistoryHeader: {
    display: 'flex', alignItems: 'center', gap: 7, minHeight: 38,
    padding: '7px 12px', cursor: 'pointer', borderBottom: `1px solid ${C.border2}`,
    background: C.surface2, userSelect: 'none' as const,
  },
  teamHistoryTitle: { color: C.fg2, fontSize: 11, fontWeight: 600 },
  teamHistoryCount: { flex: 1, color: C.fg3, fontSize: 9 },
  teamOverview: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px',
    borderBottom: `1px solid ${C.border2}`, background: C.surface,
  },
  teamMemberRail: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, flex: 1, flexWrap: 'wrap' as const },
  teamMemberPill: {
    display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0,
    padding: '3px 7px', borderRadius: 999, border: `1px solid ${C.border2}`,
    background: C.surface2,
  },
  teamMemberPillAvatar: {
    display: 'inline-grid', placeItems: 'center', width: 18, height: 18,
    flexShrink: 0, borderRadius: 6, background: C.surface3, fontSize: 12,
  },
  teamMemberDot: { width: 6, height: 6, borderRadius: '50%', flexShrink: 0 },
  teamMemberPillName: { maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, fontSize: 10, color: C.fg2 },
  teamMemberRoundCount: {
    minWidth: 16, padding: '1px 4px', borderRadius: 999, textAlign: 'center' as const,
    fontSize: 9, color: C.fg3, background: C.surface3,
  },
  teamOverviewActions: { display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 },
  teamGraphActionButton: {
    padding: '4px 8px', border: `1px solid ${C.border2}`,
    background: C.surface3, cursor: 'pointer', color: C.fg2,
    fontSize: 9, fontWeight: 600, borderRadius: 6,
  },
  teamWorkerBubble: { padding: '8px 12px', borderBottom: `1px solid ${C.border2}`, cursor: 'pointer', background: C.surface2 },
  teamWorkerBubbleActive: { background: C.surface3 },
  teamWorkerHead: { display: 'flex', alignItems: 'center', gap: 6, minHeight: 22, marginBottom: 1, userSelect: 'none' as const },
  teamWorkerAvatar: {
    position: 'relative', display: 'inline-grid', placeItems: 'center',
    width: 28, height: 28, flexShrink: 0, borderRadius: 9,
    background: C.surface3, fontSize: 17,
  },
  teamWorkerAvatarDot: {
    position: 'absolute', right: -2, bottom: -2, width: 8, height: 8,
    borderRadius: '50%', border: `2px solid ${C.surface2}`,
  },
  teamMemberGroup: { borderBottom: `1px solid ${C.border2}`, background: C.surface2 },
  teamMemberGroupHead: {
    display: 'flex', alignItems: 'center', gap: 6, minHeight: 46,
    padding: '7px 12px', cursor: 'pointer', userSelect: 'none' as const,
  },
  teamMemberRoundsLabel: {
    padding: '2px 6px', borderRadius: 999, flexShrink: 0,
    fontSize: 9, color: C.fg3, background: C.surface3,
  },
  teamRoundList: {
    margin: '0 12px 10px 51px', borderLeft: `2px solid ${C.border2}`,
    background: C.surface,
  },
  teamRound: { borderBottom: `1px solid ${C.border2}`, cursor: 'pointer' },
  teamRoundActive: { background: C.surface3 },
  teamRoundHead: {
    display: 'flex', alignItems: 'center', gap: 6, minHeight: 34,
    padding: '5px 9px', userSelect: 'none' as const,
  },
  teamRoundLabel: { color: C.fg2, fontSize: 11, fontWeight: 500, flexShrink: 0 },
  teamRoundReason: { margin: '1px 10px 5px 28px', color: C.fg3, fontSize: 10 },
  teamRoundBody: { margin: '5px 10px 9px 28px' },
  teamStepNumber: { fontSize: 9, color: C.fg3, flexShrink: 0 },
  teamWorkerReason: { fontSize: 11, color: C.fg3, margin: '2px 0 5px 51px' },
  teamWorkerBody: { marginTop: 5, marginLeft: 51 },
  teamWorkerFailed: { fontSize: 10, color: C.red ?? '#e66', textTransform: 'uppercase' as const },
  teamRunFooter: { padding: '10px 12px', borderTop: `1px solid ${C.border2}` },
  teamRunSummary: { marginBottom: 8, color: C.fg2 },
  whiteboard: {
    marginTop: 10, padding: '9px 10px', borderRadius: 8,
    border: `1px solid ${C.border2}`, background: C.surface3,
  },
  whiteboardTitle: {
    marginBottom: 7, fontSize: 11, fontWeight: 700, color: C.fg2,
    textTransform: 'uppercase' as const, letterSpacing: '0.04em',
  },
  whiteboardRow: { display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 6 },
  whiteboardBadge: {
    flexShrink: 0, padding: '2px 6px', borderRadius: 999,
    fontSize: 10, fontWeight: 700, color: C.fg2,
    border: `1px solid ${C.border}`, background: C.surface2,
  },
  whiteboardBadgeDecision: { color: C.green, borderColor: `${C.green}66`, background: `${C.green}12` },
  whiteboardBadgeOpen: { color: C.yellow, borderColor: `${C.yellow}66`, background: `${C.yellow}12` },
  whiteboardBadgeHandoff: { color: C.accent, borderColor: `${C.accent}66`, background: C.accentDim },
  whiteboardText: { minWidth: 0, paddingTop: 1, color: C.fg2, fontSize: 12, lineHeight: 1.45 },
  thinkingToggle: {
    display: 'flex', alignItems: 'center', cursor: 'pointer',
    fontSize: 11, color: C.fg3, padding: '2px 0', userSelect: 'none' as const,
    marginBottom: 6,
  },
  thinkingBody: {
    marginLeft: 17, marginBottom: 8, paddingLeft: 8,
    borderLeft: `2px solid ${C.border2}`, opacity: 0.85,
    color: C.fg2, fontSize: 12, lineHeight: 1.55,
    whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const,
  },
  liveActivity: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 11, color: C.fg3, fontStyle: 'italic',
    padding: '2px 6px', marginBottom: 6,
    background: 'rgba(43,230,155,0.08)',
    borderRadius: 4, border: `1px solid ${C.border2}`,
  },
  liveActivityDot: { color: C.accent, fontSize: 9 },
  liveActivityDetail: {
    marginTop: 4, marginBottom: 6,
    padding: 8, background: 'rgba(0,0,0,0.25)', borderRadius: 4,
    border: `1px solid ${C.border}`,
  },
  slashMenu: {
    position: 'absolute' as const, bottom: '100%', left: 0, right: 0,
    maxHeight: 260, overflowY: 'auto' as const, zIndex: 100,
    background: C.surface2, border: `1px solid ${C.border2}`,
    borderRadius: 10, padding: 4, marginBottom: 4,
    boxShadow: '0 -4px 20px rgba(0,0,0,0.35)',
  },
  slashMenuItem: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
    fontSize: 12,
  },
  slashMenuItemActive: {
    background: 'rgba(43,230,155,0.15)',
  },
  slashCmdName: {
    color: C.accent, fontWeight: 600, flexShrink: 0,
    fontFamily: 'SF Mono, Menlo, monospace', fontSize: 12,
  },
  slashCmdDesc: {
    color: C.fg3, overflow: 'hidden' as const,
    textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  },
}
