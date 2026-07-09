import React, { useEffect, useRef, useState } from 'react'
import type { ChatSelection, FileAttachment } from '../types'
import { apiService, WorkerDto } from '../services/api'
import { useChats } from '../hooks/useChats'
import { C } from '../theme'
import { Markdown } from './Markdown'
import { RouteIcons } from './RouteIcons'
import { PairingModal } from './PairingModal'
import { consumePendingPairing } from './pendingPairing'
import { ChatContextPanel } from './ChatContextPanel'
import type { ContextPanelTab } from './ChatContextPanel'
import { useQuickQuestion } from '../hooks/useQuickQuestion'
import { parseTeamMessage } from './teamMessageFormat'
import { groupMessages } from './teamGroup'
import type { RenderItem } from './teamGroup'
import { StatusSidecar } from './StatusSidecar'
import { isTaskBriefStale, extractSidecarBrief } from './taskHudView'
import { onTeamsChanged } from './teamsChanged'
import { formatHeadline, normalizeTool, ToolDetail, hasDetail } from './toolFormat'
import { defaultThinkingExpanded } from './thinkingState'
import { composerPlaceholder } from './coreOfflineView'
import { getDraft, setDraft } from './chatDrafts'
import { useGitStatus } from '../hooks/useGitStatus'
import { BranchPicker } from './BranchPicker'
import { CreatePrModal } from './CreatePrModal'

interface Props {
  chatId: string
  isGatewayRunning: boolean
  coreFailed?: boolean
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
        <div style={styles.thinkingBody}>
          <Markdown variant="assistant">{thinking}</Markdown>
        </div>
      )}
    </div>
  )
}

const stepDomId = (messageId: string, stepNum: number) => `step-${messageId}-${stepNum}`

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
  selectedTurnId: string | null
  panelOpen: boolean
  onSelectTurn: (id: string) => void
}> = ({ item, isStreaming, selectedTurnId, panelOpen, onSelectTurn }) => {
  const [collapsed, setCollapsed] = React.useState(false)
  const lastId = item.messages[item.messages.length - 1]?.id
  return (
    <div style={styles.teamGroup}>
      <div style={styles.teamGroupHeader} onClick={() => setCollapsed(c => !c)}>
        <span style={{ ...styles.teamStepChevron, transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}>▶</span>
        <span style={styles.teamGroupTitle}>Team: {item.teamName ?? '—'} · {item.teamMode}</span>
        <span style={styles.teamGroupCount}>{item.messages.length} workers</span>
      </div>
      {!collapsed && item.messages.map(m => {
        const running = isStreaming && m.id === lastId && m.workerStatus === 'running'
        const selected = m.id === selectedTurnId && panelOpen
        return (
          <div key={m.id}
            style={{ ...styles.teamWorkerBubble, ...(selected ? styles.teamWorkerBubbleActive : undefined) }}
            onClick={() => onSelectTurn(m.id)}>
            <div style={styles.teamWorkerHead}>
              <span style={styles.teamStepLabel}>Step {m.step}: {m.worker}</span>
              {m.workerStatus === 'failed' && <span style={styles.teamWorkerFailed}>failed</span>}
              {running && <span style={styles.teamStepRunning}>● running</span>}
            </div>
            {m.advisorReason && <div style={styles.teamWorkerReason}>{m.advisorReason}</div>}
            <div style={styles.teamStepBody}><Markdown variant="assistant">{m.content || '…'}</Markdown></div>
          </div>
        )
      })}
    </div>
  )
}

export const ChatTab: React.FC<Props> = ({ chatId, isGatewayRunning, coreFailed }) => {
  const { state, sendMessage, stopChat, clearRestore, setSelection, setAgentModel, setWorkingDir: setChatWorkingDir, setContextPanelOpen, setSoloAdvisor, linkChannel, unlinkChannel, resolvePermission, generateTaskBrief } = useChats()
  const chat = state.chats[chatId]
  const flight = state.inFlight[chatId]

  // Seed from the per-chat draft store so unsent text/attachments survive the
  // remount that happens when switching chats (App.tsx keys ChatTab by chat id).
  const [input, setInput] = useState(() => getDraft(chatId).text)
  const [workers, setWorkers] = useState<WorkerDto[]>([])
  const [teamNames, setTeamNames] = useState<string[]>([])
  const [models, setModels] = useState<ModelEntry[]>([])
  const [enabledAgents, setEnabledAgents] = useState<string[]>([...AGENT_NAMES])
  const [defaultAgent, setDefaultAgent] = useState<string | null>(null)
  const [agentDefaultModels, setAgentDefaultModels] = useState<Record<string, string | undefined>>({})
  const [pendingAttachments, setPendingAttachments] = useState<FileAttachment[]>(() => getDraft(chatId).attachments)
  const [isDragging, setIsDragging] = useState(false)
  const [slashCommands, setSlashCommands] = useState<Array<{ name: string; description: string; source: 'agent' | 'gateway' }>>([])
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
  const [followLatest, setFollowLatest] = useState(true)
  // Selected option labels for the active multi-select AskUserQuestion. Reset
  // whenever a new message arrives (the prompt is always the last message).
  const [multiChoice, setMultiChoice] = useState<string[]>([])
  const [selectedTurnIdState, setSelectedTurnIdState] = useState<string | null>(null)
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  const [taskBriefLoading, setTaskBriefLoading] = useState(false)
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const v = localStorage.getItem('codey.contextPanelWidth')
    const n = v ? parseInt(v, 10) : NaN
    return Number.isFinite(n) ? Math.max(260, Math.min(900, n)) : 340
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
    setTaskBriefLoading(true)
    generateTaskBrief(chat.id).finally(() => setTaskBriefLoading(false))
  }, [turnActive, panelTab, chatId])
  // Keep the per-chat draft store in sync so the current text/attachments are
  // preserved when ChatTab remounts on a chat switch. setDraft drops the entry
  // once both are empty (e.g. after send), so this also clears sent drafts.
  useEffect(() => {
    setDraft(chatId, { text: input, attachments: pendingAttachments })
  }, [chatId, input, pendingAttachments])
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
  useEffect(() => { localStorage.setItem('codey.contextPanelWidth', String(panelWidth)) }, [panelWidth])
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
      // Cmd/Ctrl+Backslash mirrors VS Code's toggle-sidebar binding and avoids
      // colliding with Electron's built-in Cmd+Shift+I devtools accelerator.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === '\\') {
        e.preventDefault()
        if (chat) setContextPanelOpen(chat.id, !(chat.contextPanelOpen ?? false))
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [chat?.id, chat?.contextPanelOpen])

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
  const panelOpen: boolean = chat?.contextPanelOpen ?? false

  // The Status sidecar floats over the chat's top-right when the panel is
  // closed (it's absolutely positioned, so it takes no layout space). Hidden on
  // narrow windows where it would cover most of the conversation, and only when
  // there's at least one assistant turn to summarize.
  const SIDECAR_W = 264
  const sidecarFits = windowWidth >= 720
  const hasAssistantMsg = (chat?.messages ?? []).some(m => m.role === 'assistant')
  const sidecarVisible = !panelOpen && sidecarFits && !!chat && hasAssistantMsg

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
    setContextPanelOpen(chat.id, true)
    setPanelTab('qq')
    if (initial && initial.trim()) {
      void askQuickQuestion(chat.id, initial.trim())
    } else {
      // Focus the QQ composer on the next paint, once the panel has mounted.
      setTimeout(() => qqInputRef.current?.focus(), 50)
    }
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

  const isSending = !!flight
  const orphaned = state.workspaces.length > 0 && !state.workspaces.includes(chat.workspaceName)
  const canSend = isGatewayRunning && !coreFailed && !isSending && (!!input.trim() || pendingAttachments.length > 0) && !orphaned
  const statusLabel = flight?.queuedPosition
    ? `Queued (#${flight.queuedPosition})`
    : flight?.agentStatus === 'thinking' ? 'Thinking…'
    : flight?.agentStatus === 'working'  ? 'Working…'
    : flight?.agentStatus === 'writing'  ? 'Writing…'
    : ''

  const panelWorkerName = chat.selection.type === 'worker' ? chat.selection.name : undefined
  const panelTeamName = chat.selection.type === 'team' ? chat.selection.name : undefined
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
        <span style={styles.workspaceTag}>{chat.workspaceName}</span>
        <BranchPicker
          workingDir={workingDir}
          repoRoot={workspaceDir}
          boundWorktreePath={chat?.workingDirOverride}
          onBindWorktree={async (path) => {
            if (!chat) return
            await setChatWorkingDir(chat.id, path)
          }}
        />
        <select value={selectionValue} onChange={e => onSelectionChange(e.target.value)} style={{ ...styles.workerSelect, marginLeft: 'auto' }}>
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
        {chat.selection.type !== 'team' && (
          <>
            <select
              value={chat.agent ?? ''}
              onChange={e => onAgentChange(e.target.value)}
              style={styles.workerSelect}
              title={`Agent: ${effectiveAgent}${chat.agent ? ' (override)' : workerAgent ? ` (worker: ${selectedWorker!.name})` : ' (default)'}`}
            >
              <option value="">{`Agent: ${effectiveAgent}`}</option>
              {AGENT_NAMES.filter(n => enabledAgents.includes(n) || n === chat.agent).map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <select
              value={chat.model ?? ''}
              onChange={e => onModelChange(e.target.value)}
              style={styles.workerSelect}
              title={`Model: ${effectiveModel ?? 'unset'}${chat.model ? ' (override)' : workerModel ? ` (worker: ${selectedWorker!.name})` : ' (default)'}`}
              disabled={modelsForAgent.length === 0}
            >
              <option value="">{`Model: ${effectiveModel ?? '(default)'}`}</option>
              {modelsForAgent.map(m => (
                <option key={m.model} value={m.model}>{m.model}</option>
              ))}
            </select>
            <button
              onClick={() => setSoloAdvisor(chat.id, !(chat.soloAdvisor ?? false))}
              style={{
                ...styles.workerSelect,
                cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 5,
                color: chat.soloAdvisor ? C.accent : C.fg3,
                border: `1px solid ${chat.soloAdvisor ? C.accent : C.border2}`,
                background: chat.soloAdvisor ? C.accentDim : C.surface3,
                fontWeight: chat.soloAdvisor ? 600 : 400,
              }}
              title={chat.soloAdvisor
                ? 'Advisor: ON — when the model gets stuck, a stronger advisor model gives it hints to continue'
                : 'Advisor: OFF — click to let a stronger advisor model help when the model gets stuck'}
              role="switch"
              aria-checked={chat.soloAdvisor ?? false}
              aria-label="Advisor"
            >
              💡 Advisor
            </button>
          </>
        )}
        <RouteIcons routes={chat.routes} />
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setLinkMenuOpen(o => !o)}
            style={styles.linkBtn}
            title={chat.routes?.length ? 'Manage channel links' : 'Link to a channel'}
          >
            {chat.routes?.length ? '🔗' : '🔗+'}
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
          onClick={() => setContextPanelOpen(chat.id, !panelOpen)}
          style={{ ...styles.linkBtn, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '4px 6px' }}
          title={panelOpen ? 'Hide context panel (⌘\\)' : 'Show context panel (⌘\\)'}
          aria-label={panelOpen ? 'Hide context panel' : 'Show context panel'}
        >
          <PanelRightIcon color={C.fg} filled={panelOpen} />
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
                selectedTurnId={selectedTurnId}
                panelOpen={panelOpen}
                onSelectTurn={(id: string) => {
                  setSelectedTurnIdState(id)
                  setFollowLatest(false)
                  if (!panelOpen) {
                    setContextPanelOpen(chat.id, true)
                    setPanelTab('current')
                  }
                }}
              />
            )
          }
          const msg = item.message
          const isUser = msg.role === 'user'
          const isSelected = !isUser && msg.id === selectedTurnId && panelOpen
          return (
            <div key={msg.id}
              onDoubleClick={isUser ? undefined : () => {
                setSelectedTurnIdState(msg.id)
                setFollowLatest(false)
                // Only a double-click reveals the right panel; open it on the
                // turn-detail tab so it shows that turn's own detail.
                if (!panelOpen) {
                  setContextPanelOpen(chat.id, true)
                  setPanelTab('current')
                }
              }}
              style={{
                display: 'flex', flexDirection: 'column',
                alignItems: isUser ? 'flex-end' : 'flex-start',
                marginBottom: 12,
                cursor: isUser ? 'default' : 'pointer',
                paddingLeft: !isUser ? 6 : 0,
                transform: isSelected ? 'translateY(-3px)' : 'translateY(0)',
                transition: 'transform 0.18s ease',
              }}
            >
              <div style={{
                maxWidth: '72%', padding: '10px 14px',
                borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                background: isUser ? C.userBg : C.aiBg,
                color: isUser ? C.onAccent : C.fg, fontSize: 13, lineHeight: 1.55, wordBreak: 'break-word',
                boxShadow: isUser
                  ? 'none'
                  : (isSelected
                      ? `0 10px 24px ${C.accentDim}, 0 6px 14px ${C.accentDim}`
                      : '0 1px 3px rgba(0,0,0,0.18)'),
                border: isUser ? 'none' : `1px solid ${isSelected ? C.accent : C.border2}`,
                transition: 'box-shadow 0.18s ease, border-color 0.18s ease, background 0.18s ease',
              }}>
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
                      {msg.thinking && (
                        <ThinkingBlock
                          thinking={msg.thinking}
                          hasAnswer={!!text.trim()}
                          isComplete={msg.isComplete ?? false}
                        />
                      )}
                      <Markdown variant="assistant">{text}</Markdown>
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
                      <button style={styles.permissionAllow} onClick={() => resolvePermission(chatId, true)}>Allow</button>
                      <button style={styles.permissionDeny} onClick={() => resolvePermission(chatId, false)}>Deny</button>
                    </div>
                  </div>
                )
              }
              <div style={styles.tsLabel}>
                <span>{fmtTime(msg.timestamp)}</span>
                <span style={styles.tsRight}>
                  {msg.fallback && (
                    <span
                      style={styles.fallbackBadge}
                      title={`Primary ${msg.fallback.from} failed — answered by fallback ${msg.fallback.to}`}
                    >
                      ⤷ {msg.fallback.to}
                    </span>
                  )}
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
                </span>
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
              disabled={!isGatewayRunning || !!coreFailed || isSending}
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
      </div>
      {/* The context panel only renders when there's room for both the chat
          list (~180-240px) AND a usable conversation column (>= MIN_MIDDLE).
          On very narrow windows we hide it entirely so the conversation
          doesn't get squeezed to a single character per line. */}
      {(() => {
        const CHAT_LIST_W = windowWidth < 600 ? 180 : 240
        const MIN_MIDDLE = 360

        if (panelOpen) {
          const MIN_PANEL = 260
          const available = windowWidth - CHAT_LIST_W - MIN_MIDDLE
          if (available < MIN_PANEL) return null
          const effectiveWidth = Math.min(panelWidth, available)
          return (
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
              onFollowLatest={() => setFollowLatest(true)}
              onClose={() => setContextPanelOpen(chat.id, false)}
              onResize={setPanelWidth}
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
        }

        // Panel closed → light Status sidecar. Hidden until there's a brief to
        // show (self-population kicks it off via the effect above).
        if (!sidecarVisible || !chat?.taskBrief) return null
        return (
          <StatusSidecar
            view={extractSidecarBrief(chat.taskBrief)}
            loading={taskBriefLoading}
            width={SIDECAR_W}
            branchAhead={branchAhead}
            onCreatePr={() => setShowPrModal(true)}
            onOpen={() => { setContextPanelOpen(chat.id, true); setPanelTab('task') }}
          />
        )
      })()}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  outer: { display: 'flex', flexDirection: 'row', height: '100%', minHeight: 0, position: 'relative' },
  container: { display: 'flex', flexDirection: 'column', height: '100%', flex: 1, minWidth: 0, position: 'relative' },
  header: {
    padding: '10px 16px', borderBottom: `1px solid ${C.border}`,
    display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
    flexWrap: 'wrap', rowGap: 6,
  },
  workspaceTag: { color: C.fg3, fontSize: 11, flexShrink: 0 },
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
    flexShrink: 0, maxWidth: 200,
  },
  messages: { flex: 1, overflowY: 'auto', padding: 16 },
  typingRow: { display: 'flex', alignItems: 'center', gap: 8, color: C.fg3, fontSize: 13, marginBottom: 12 },
  tsLabel: { color: C.fg3, fontSize: 10, marginTop: 4, paddingLeft: 4, paddingRight: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  tsMeta: { color: C.fg3, opacity: 0.55, fontVariantNumeric: 'tabular-nums' },
  tsRight: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  fallbackBadge: {
    color: C.warningFg, background: C.warningBg,
    borderRadius: 6, padding: '1px 6px', fontSize: 10,
    maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  inputContainer: { padding: '10px 14px 12px', borderTop: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 },
  composer: {
    background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 12,
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
  composerRow: { display: 'flex', gap: 6, alignItems: 'flex-end', padding: 6 },
  input: {
    flex: 1, background: 'transparent', border: 'none', borderRadius: 8,
    color: C.fg, fontSize: 13, padding: '10px 6px 8px', outline: 'none', resize: 'none',
    lineHeight: 1.5, maxHeight: 120, overflowY: 'auto',
  },
  sendButton: {
    width: 36, height: 36, borderRadius: 9, border: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, transition: 'background 0.15s',
  },
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
  teamGroup: { border: `1px solid ${C.border}`, borderRadius: 10, margin: '6px 0', overflow: 'hidden', background: C.surface2 },
  teamGroupHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', borderBottom: `1px solid ${C.border}` },
  teamGroupTitle: { flex: 1, fontSize: 12, fontWeight: 600, color: C.fg },
  teamGroupCount: { fontSize: 11, color: C.fg3 },
  teamWorkerBubble: { padding: '8px 12px', borderBottom: `1px solid ${C.border2}`, cursor: 'pointer' },
  teamWorkerBubbleActive: { background: C.surface3 },
  teamWorkerHead: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 },
  teamWorkerReason: { fontSize: 11, color: C.fg3, marginBottom: 4 },
  teamWorkerFailed: { fontSize: 10, color: C.red ?? '#e66', textTransform: 'uppercase' as const },
  thinkingToggle: {
    display: 'flex', alignItems: 'center', cursor: 'pointer',
    fontSize: 11, color: C.fg3, padding: '2px 0', userSelect: 'none' as const,
    marginBottom: 6,
  },
  thinkingBody: {
    marginLeft: 17, marginBottom: 8, paddingLeft: 8,
    borderLeft: `2px solid ${C.border2}`, opacity: 0.85,
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
