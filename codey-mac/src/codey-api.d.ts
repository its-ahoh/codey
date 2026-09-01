import type { Chat, ChatSelection } from '../../packages/core/src/types/chat'
import type { ChatStreamEvent, QQStreamEvent } from '../../packages/gateway/src/chat-runner'
import type { TaskBrief } from '../types'
import type { TeamConfigRaw } from '../../packages/core/src/workspace'
import type { ApiKeyEntry } from '../../packages/core/src/types/index'
import type { UpdaterEvent } from './hooks/updaterState'
import type { CoreState } from '../electron/core-state'
import type { ScannedSkill } from '../electron/skills'
import type { SkillUsage, SkillUsageMap } from '../electron/skill-usage'
import type { MemoryEntry } from '../electron/memory'
import type { CodeyMemoryItem, MemoryStoreScope } from '../electron/codey-memory'
import type { Automation, AutomationRun, AutomationEvent } from '../../packages/core/src/types/automation'
import type { AutomationDraft } from '../../packages/core/src/aide-automation'
import type { ChatStep } from '../../packages/gateway/src/automations/chat'

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export type SkillEntry = ScannedSkill
export type { SkillUsage, SkillUsageMap }

export type { MemoryEntry, CodeyMemoryItem, MemoryStoreScope }

export interface CodeyMemorySettings {
  enabled: boolean
  autoExtract: boolean
}

export interface AgentMemoryGroup { agent: string; entries: MemoryEntry[] }

export interface UserMemoryResult {
  agents: AgentMemoryGroup[]
}

export interface SharedMemoryResult {
  /** Whether Codey mirrors the global memory into the agents' own files. */
  enabled: boolean
  /** The agent files the entries are mirrored into. */
  targets: Array<{ agent: string; path: string }>
}

export interface ProjectMemoryResult {
  agents: AgentMemoryGroup[]
  /** Working directory the project files were read from, if any. */
  workingDir: string | null
}

export interface SkillsListResult {
  skills: SkillEntry[]
  projectDir: string | null
}

export interface PluginInfo {
  id: string
  name: string
  /** One line that says which browser this is, shown on the collapsed card. */
  tagline: string
  description: string
  /** Read from disk: a plugin is installed as an ordinary skill, and the
   *  Skills tab can disable ('disabled') or delete ('absent') it from there. */
  state: 'absent' | 'disabled' | 'installed'
  /** Where an installed copy lives. */
  dir: string
  /** Who wrote what is there: 'codey' carries an install's stamp, 'user' is a
   *  hand-written skill of the same name. Undefined when nothing is installed. */
  origin?: 'codey' | 'user'
  /** The repository Install pulls from. */
  sourceUrl: string
  /** The version an install recorded — the skill folder's tree hash, the
   *  version the ecosystem uses for a skill, or 'bundled' for the copy shipped
   *  with the app. Present only on a copy Codey wrote. */
  hash?: string
}

/** Which copy an install wrote: 'bundled' means the repository was unreachable
 *  and `reason` says why. `installed: false` means Codey refused to replace a
 *  skill it did not write; retry with force once the user confirms. */
export type PluginInstallResult =
  | { installed: true; file: string; source: 'repository' | 'bundled'; reason?: string }
  | { installed: false; conflict: 'user-copy'; dir: string }

export interface PluginUninstallResult {
  removed: boolean
  conflict?: 'user-copy'
}

/** Whether the published skill moved after the installed copy was written.
 *  `needsUpdate: null` when the published folder could not be reached. */
export interface PluginUpdateCheck {
  needsUpdate: boolean | null
  /** What the install stamped: a folder hash, or 'bundled' for the copy that
   *  shipped with the app, which has no published version to compare. */
  recorded?: string
  /** The hash the published folder has right now. */
  current?: string
}

export interface ExternalMcpServer {
  name: string
  transport: 'stdio' | 'remote'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  enabled: boolean
}

/** An MCP server discovered inside a coding agent's own config (read-only). */
export interface AgentMcpServer {
  agent: 'claude-code' | 'codex' | 'opencode'
  name: string
  transport: 'stdio' | 'remote'
  command?: string
  args?: string[]
  url?: string
  scope: 'user' | 'project'
  enabled: boolean
  /** Config file it was read from. */
  source: string
}

export interface ModelEntry {
  /** 'all' = dual-protocol provider, usable by every agent. */
  apiType: 'anthropic' | 'openai' | 'all'
  model: string
  apiKeyRef?: string
  provider?: string
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
}

export interface BrowserPageContext {
  url: string
  title: string
  description: string
  text: string
  performance: {
    domContentLoadedMs: number | null
    loadMs: number | null
    transferBytes: number | null
  }
}

export type BrowserControlSurface = 'browser' | 'chrome'
export type BrowserControlLevel = 'write' | 'full'
export type BrowserControlGrant = 'none' | BrowserControlLevel

export interface BrowserControlPermissionState {
  granted: Record<BrowserControlSurface, BrowserControlGrant>
  pending: { command: string; url: string; surface: BrowserControlSurface; level: BrowserControlLevel } | null
}

export type BrowserSitePermission = 'camera' | 'microphone' | 'geolocation' | 'notifications'

export interface BrowserSitePermissionState {
  pending: {
    id: string
    origin: string
    hostname: string
    permissions: BrowserSitePermission[]
  } | null
  savedSiteCount: number
}

export interface BrowserDownload {
  id: string
  name: string
  path: string
  url: string
  status: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
  startedAt: number
  finishedAt?: number
}

export interface BrowserTab {
  id: string
  title: string
  url: string
  active: boolean
}

/** A saved browser session ("profile") as listed by the profiles manager. */
export interface BrowserProfileSummary {
  name: string
  avatar: string | null
  createdAt: number
  updatedAt: number
  cookieCount: number
  originCount: number
  active: boolean
  sourceUrl: string | null
}

export interface BrowserLoginWaitEvent {
  id: string
  chatId: string
  status: 'watching' | 'changed' | 'expired'
  startedAt: number
  expiresAt: number
  url: string
  title: string
  reason?: string
}

export interface BrowserExtensionCandidate {
  path: string
  name: string
  version: string
  description: string
  permissions: string[]
  hostPermissions: string[]
  warnings: string[]
}

export interface BrowserExtensionEntry extends BrowserExtensionCandidate {
  key: string
  enabled: boolean
  runtimeId: string | null
  error: string | null
}

export interface ChromeBrowserExtensionCandidate extends BrowserExtensionCandidate {
  extensionId: string
  profile: string
  compatible: boolean
  incompatibilities: string[]
}

export interface ChromeCompanionStatus {
  endpoint: string | null
  paired: boolean
  connected: boolean
  clientName: string | null
  pairedAt: number | null
  lastSeenAt: number | null
  clientVersion: string | null
  expectedVersion: string | null
  updateAvailable: boolean
}

export interface ChromeTabInfo {
  id: number
  windowId: number
  title: string
  url: string
  favIconUrl?: string
}

/** One site the paired Chrome profile holds cookies for. `openTabs` decides
 *  whether its localStorage can come along - it can only be read from a page
 *  that is actually open. */
/** What one site inside a saved profile holds. Cookie and storage *values* are
 *  deliberately absent - this describes which logins a profile carries, not
 *  what they are. */
export interface BrowserProfileSiteSummary {
  domain: string
  cookieCount: number
  cookieNames: string[]
  storage: Array<{ origin: string; keys: number }>
}

export interface ChromeSessionSite {
  site: string
  cookieCount: number
  openTabs: number
}

export interface ChromePageSnapshot {
  tab: ChromeTabInfo
  text: string
  links: Array<{ text: string; href: string }>
  forms: Array<{ tag: string; type: string; name: string; placeholder: string }>
}

declare global {
  interface Window {
    codey: {
      workers: {
        list: () => Promise<IpcResult<any[]>>
        get: (name: string) => Promise<IpcResult<any>>
        save: (name: string, personality: any, config: any) => Promise<IpcResult<void>>
        delete: (name: string) => Promise<IpcResult<void>>
        generate: (prompt: string) => Promise<IpcResult<any>>
      }
      workspaces: {
        list: () => Promise<IpcResult<string[]>>
        current: () => Promise<IpcResult<string>>
        switch: (name: string) => Promise<IpcResult<void>>
        info: (name: string) => Promise<IpcResult<{ workingDir: string }>>
        create: (dir: string) => Promise<IpcResult<string>>
        delete: (name: string) => Promise<IpcResult<void>>
        rename: (oldName: string, newName: string) => Promise<IpcResult<void>>
        reveal: (name: string) => Promise<IpcResult<void>>
      }
      dialog: {
        pickDirectory: () => Promise<IpcResult<string | null>>
      }
      editors: {
        list: () => Promise<IpcResult<Array<{ id: string; name: string; installed: boolean }>>>
        /** Open a file or directory in the given editor. */
        open: (editorId: string, path: string) => Promise<IpcResult<void>>
      }
      /** Paths mentioned inside a chat message. */
      fileRef: {
        locate: (path: string, cwd: string | null) => Promise<IpcResult<{ absPath: string | null; exists: boolean; isDirectory: boolean }>>
        open: (path: string, cwd: string | null, options?: { editorId?: string; reveal?: boolean }) => Promise<IpcResult<void>>
      }
      globalTeams: {
        get: () => Promise<IpcResult<Record<string, TeamConfigRaw>>>
        set: (teams: Record<string, TeamConfigRaw>) => Promise<IpcResult<void>>
      }
      automations: {
        list: () => Promise<IpcResult<Automation[]>>
        get: (id: string) => Promise<IpcResult<Automation>>
        create: (draft: any) => Promise<IpcResult<Automation>>
        update: (id: string, patch: Partial<Automation>) => Promise<IpcResult<Automation>>
        delete: (id: string) => Promise<IpcResult<void>>
        setEnabled: (id: string, enabled: boolean) => Promise<IpcResult<Automation>>
        runNow: (id: string) => Promise<IpcResult<AutomationRun | null>>
        runChat: (id: string) => Promise<IpcResult<{ chatId: string }>>
        resume: (id: string, runId: string, answer: string) => Promise<IpcResult<AutomationRun>>
        history: (id: string, limit?: number) => Promise<IpcResult<AutomationRun[]>>
        runLog: (id: string, runId: string) => Promise<IpcResult<string | null>>
        markSeen: (id: string, runId: string) => Promise<IpcResult<void>>
        chatStart: (mode: 'create' | 'edit', automationId?: string) => Promise<IpcResult<ChatStep>>
        chatSend: (sessionId: string, text: string) => Promise<IpcResult<ChatStep>>
        chatPatch: (sessionId: string, patch: Partial<AutomationDraft>) => Promise<IpcResult<ChatStep>>
        chatSave: (sessionId: string) => Promise<IpcResult<Automation>>
        recheck: (id: string) => Promise<IpcResult<void>>
        dismissCheck: (id: string) => Promise<IpcResult<void>>
        chatCancel: (sessionId: string) => Promise<IpcResult<void>>
        onEvent: (handler: (ev: AutomationEvent) => void) => () => void
        onUnseen: (handler: (msg: { automationId: string; runIds: string[] }) => void) => () => void
      }
      conversations: {
        list: () => Promise<IpcResult<string[]>>
      }
      chat: {
        send: (payload: { conversationId: string; text: string; sender?: string }) => Promise<IpcResult<{ response: string; conversationId: string; tokens?: number; durationSec?: number }>>
        onToken: (handler: (msg: { conversationId: string; token: string }) => void) => () => void
        onDone: (handler: (msg: { conversationId: string; response: string; tokens?: number; durationSec?: number }) => void) => () => void
        onStatus: (handler: (msg: { conversationId: string; update: string }) => void) => () => void
      }
      config: {
        get: () => Promise<IpcResult<any>>
        set: (updates: any) => Promise<IpcResult<void>>
      }
      models: {
        list: () => Promise<IpcResult<ModelEntry[]>>
        save: (entry: ModelEntry) => Promise<IpcResult<void>>
        delete: (name: string) => Promise<IpcResult<void>>
        rename: (oldName: string, newName: string) => Promise<IpcResult<void>>
      }
      apiKeys: {
        list: () => Promise<IpcResult<ApiKeyEntry[]>>
        save: (entry: ApiKeyEntry) => Promise<IpcResult<void>>
        delete: (name: string) => Promise<IpcResult<void>>
        rename: (oldName: string, newName: string) => Promise<IpcResult<void>>
      }
      fallback: {
        get: () => Promise<IpcResult<{ enabled: boolean; order: Array<{ agent: string; model?: string }> }>>
        set: (fb: { enabled: boolean; order: Array<{ agent: string; model?: string }> }) => Promise<IpcResult<void>>
      }
      dispatcher: {
        get: () => Promise<IpcResult<{ agent?: string; model?: string }>>
        set: (updates: { agent?: string; model?: string }) => Promise<IpcResult<void>>
      }
      aide: {
        get: () => Promise<IpcResult<{ agent?: string; model?: string }>>
        set: (updates: { agent?: string; model?: string }) => Promise<IpcResult<void>>
      }
      plugins: {
        list: () => Promise<IpcResult<PluginInfo[]>>
        install: (id: string, force?: boolean) => Promise<IpcResult<PluginInstallResult>>
        uninstall: (id: string, force?: boolean) => Promise<IpcResult<PluginUninstallResult>>
        setEnabled: (id: string, enabled: boolean) => Promise<IpcResult<PluginInfo>>
        check: (id: string) => Promise<IpcResult<PluginUpdateCheck>>
      }
      mcp: {
        list: () => Promise<IpcResult<ExternalMcpServer[]>>
        /** Servers already configured in the coding agents; not managed by Codey. */
        listAgent: () => Promise<IpcResult<AgentMcpServer[]>>
        save: (draft: Omit<ExternalMcpServer, 'enabled'> & { enabled?: boolean }) => Promise<IpcResult<void>>
        remove: (name: string) => Promise<IpcResult<void>>
        setEnabled: (name: string, enabled: boolean) => Promise<IpcResult<void>>
      }
      skills: {
        /** `workspace` selects which project's skills are included; defaults to the active one. */
        list: (agent?: string, workspace?: string) => Promise<IpcResult<SkillsListResult>>
        usage: (agent?: string) => Promise<IpcResult<SkillUsageMap>>
        install: (payload: { agent?: string; scope: 'user' | 'project'; workspace?: string; localDir?: string; gitUrl?: string }) => Promise<IpcResult<{ name: string; dir: string }>>
        remove: (dir: string) => Promise<IpcResult<void>>
        setEnabled: (dir: string, enabled: boolean) => Promise<IpcResult<void>>
        reveal: (dir: string) => Promise<IpcResult<void>>
      }
      memory: {
        /** Read-only: what each agent knows about the user, in every project. */
        user: () => Promise<IpcResult<UserMemoryResult>>
        /** Read-only: what each agent knows about one workspace's project. */
        project: (workspace?: string) => Promise<IpcResult<ProjectMemoryResult>>
        /** Sharing the global memory entries with every agent. */
        shared: {
          get: () => Promise<IpcResult<SharedMemoryResult>>
          setEnabled: (enabled: boolean) => Promise<IpcResult<{ synced: string[] }>>
        }
        /** Codey's own remembered entries — what it injects into prompts. */
        codey: {
          list: (scope: MemoryStoreScope, workspace?: string) => Promise<IpcResult<{ entries: CodeyMemoryItem[] }>>
          add: (scope: MemoryStoreScope, workspace: string | undefined, content: string, type?: string) => Promise<IpcResult<CodeyMemoryItem>>
          update: (scope: MemoryStoreScope, workspace: string | undefined, id: string, content: string, type?: string) => Promise<IpcResult<{ updated: boolean }>>
          remove: (scope: MemoryStoreScope, workspace: string | undefined, id: string) => Promise<IpcResult<{ removed: boolean }>>
          settings: () => Promise<IpcResult<CodeyMemorySettings>>
          setSettings: (patch: Partial<CodeyMemorySettings>) => Promise<IpcResult<CodeyMemorySettings>>
        }
      }
      playbooks: {
        /** Aggregated across ALL workspaces — entries are keyed by (workspace, name). */
        list: () => Promise<IpcResult<Array<{
          workspace: string;
          name: string; description: string; version: number; useCount: number;
          lastUsedAt: number; archived: boolean; promotedToSkill: boolean;
          successSignals: { cleanRuns: number; corrections: number };
          canRollback: boolean;
        }>>>
        detail: (workspace: string, name: string) => Promise<IpcResult<{
          name: string;
          description: string;
          whenToUse: string;
          steps: string;
          version: number;
        }>>
        history: (workspace: string, name: string) => Promise<IpcResult<Array<{
          at: number;
          kind: 'created' | 'evolved' | 'rolled-back';
          fromVersion?: number;
          toVersion: number;
          trigger?: { runId: string; promptSummary: string };
          steps: string;
        }>>>
        archive: (workspace: string, name: string) => Promise<IpcResult<void>>
        restore: (workspace: string, name: string) => Promise<IpcResult<void>>
        delete: (workspace: string, name: string) => Promise<IpcResult<void>>
        rollback: (workspace: string, name: string) => Promise<IpcResult<number>>
        /** Writes one durable SKILL.md under the project's `.codey/skills`.
         *  Codey exposes it to agents through compatibility links. */
        promote: (workspace: string, name: string) => Promise<IpcResult<{ name: string; dirs: string[] }>>
      }
      agents: {
        get: () => Promise<IpcResult<Record<string, { enabled?: boolean; defaultModel?: string; defaultEffort?: string; env?: Record<string, string> }>>>
        set: (updates: Record<string, { enabled?: boolean; defaultModel?: string; defaultEffort?: string; env?: Record<string, string> }>) => Promise<IpcResult<void>>
        checkInstalled: (force?: boolean) => Promise<IpcResult<{ status: Record<string, { installed: boolean; path?: string; version?: string }>; conclusive: boolean }>>
        /** Installed versions plus what each agent publishes, so the panel can
         *  offer an update only when there is one. `unknown` means the lookup
         *  failed — offline, say — not that the CLI is current. */
        updateStatus: (force?: boolean) => Promise<IpcResult<{
          status: Record<string, { installed: boolean; path?: string; version?: string }>
          conclusive: boolean
          updates: Record<string, { current?: string; latest?: string; updateAvailable: boolean; unknown: boolean }>
        }>>
        /** Runs the agent CLI's own updater (or `brew upgrade` for a Homebrew
         *  install) and re-probes, so `status` is the state after the attempt. */
        update: (agent: string) => Promise<IpcResult<{
          command: string
          via: 'self' | 'homebrew'
          ok: boolean
          output: string
          status: Record<string, { installed: boolean; path?: string; version?: string }>
          updates: Record<string, { current?: string; latest?: string; updateAvailable: boolean; unknown: boolean }>
        }>>
        slashCommands: (agent: string) => Promise<IpcResult<Array<{ name: string; description: string; source: 'agent' | 'gateway' | 'skill' }>>>
      }
      chats: {
        upload: (chatId: string, fileName: string, mimeType: string, data: ArrayBuffer) =>
          Promise<IpcResult<{ id: string; name: string; path: string; mimeType: string; size: number }>>
        list: (workspaceName?: string) => Promise<IpcResult<Chat[]>>
        get: (id: string) => Promise<IpcResult<Chat>>
        create: (input: { workspaceName: string; selection?: ChatSelection; title?: string }) => Promise<IpcResult<Chat>>
        rename: (id: string, title: string) => Promise<IpcResult<Chat>>
        taskBrief: (id: string) => Promise<IpcResult<TaskBrief | null>>
        delete: (id: string) => Promise<IpcResult<null>>
        updateSelection: (id: string, selection: ChatSelection) => Promise<IpcResult<Chat>>
        updateAgentModel: (id: string, agent: string | null, model: string | null) => Promise<IpcResult<Chat>>
        updateEffort: (id: string, effort: string | null) => Promise<IpcResult<Chat>>
        send: (payload: { chatId: string; text: string; attachments?: Array<{ id: string; name: string; path: string; mimeType: string; size: number }> }) => Promise<IpcResult<{ response: string; chatId: string; tokens?: number; durationSec?: number }>>
        stop: (chatId: string) => Promise<IpcResult<boolean>>
        onEvent: (handler: (ev: ChatStreamEvent) => void) => () => void
        link: (chatId: string, channel: 'telegram' | 'discord' | 'imessage', channelUserId: string) => Promise<IpcResult<Chat>>
        unlink: (chatId: string, channel: 'telegram' | 'discord' | 'imessage', channelUserId: string) => Promise<IpcResult<Chat>>
        updateContextPanelOpen: (id: string, open: boolean | null) => Promise<IpcResult<Chat>>
        setSoloAdvisor: (id: string, enabled: boolean) => Promise<IpcResult<Chat>>
        setWorkingDir: (id: string, dir: string | null) => Promise<IpcResult<Chat>>
        setExecutionMode: (id: string, mode: 'shared-checkout' | 'isolated-worktree') => Promise<IpcResult<Chat>>
        bindWorktree: (id: string, worktreePath: string, expectedBranch?: string) => Promise<IpcResult<Chat>>
        createWorktree: (id: string, name: string) => Promise<IpcResult<Chat>>
        setPullRequest: (id: string, pullRequest: NonNullable<Chat['pullRequest']>) => Promise<IpcResult<Chat>>
      }
      qq: {
        ask: (payload: { chatId: string; question: string; history: Array<{ role: 'user' | 'assistant'; content: string }>; attachments?: Array<{ id: string; name: string; path: string; mimeType: string; size: number }> }) => Promise<IpcResult<{ response: string; tokens?: number; durationSec?: number }>>
        stop: (chatId: string) => Promise<IpcResult<boolean>>
        onEvent: (handler: (ev: QQStreamEvent) => void) => () => void
      }
      permissions: {
        addAllowed: (toolNames: string[], chatId?: string) => Promise<IpcResult<{ added: number }>>
      }
      workspaceFiles: {
        list: (workingDir: string) => Promise<IpcResult<Array<{ path: string; name: string; isDir: boolean }>>>
      }
      pairing: {
        start: (channel: 'telegram' | 'discord' | 'imessage') => Promise<IpcResult<{ code: string; deepLink?: string }>>
        list: () => Promise<IpcResult<Array<{
          channel: 'telegram' | 'discord' | 'imessage'
          channelUserId: string
          prefs?: { workspace?: string; agent?: string; model?: string }
          currentChatId?: string
          createdAt: number
        }>>>
        onEvent: (handler: (ev: { type: 'completed'; channel: 'telegram' | 'discord' | 'imessage'; channelUserId: string }) => void) => () => void
      }
      git: {
        status: (workingDir: string) => Promise<IpcResult<{ branch: string; dirty: number } | null>>
        branches: (workingDir: string) => Promise<IpcResult<{ current: string; local: string[]; remote: string[] }>>
        checkout: (workingDir: string, name: string, opts?: { create?: boolean; track?: boolean }) => Promise<IpcResult<{ ok: boolean; error?: string; reason?: 'dirty' }>>
        stash: (workingDir: string, message?: string) => Promise<IpcResult<{ ok: boolean; error?: string }>>
        fetch: (workingDir: string) => Promise<IpcResult<{ ok: boolean; error?: string }>>
        pull: (workingDir: string) => Promise<IpcResult<{ ok: boolean; updated?: number; upstream?: string; error?: string; reason?: 'dirty' | 'diverged' | 'no-upstream' }>>
        worktrees: (workingDir: string) => Promise<IpcResult<{ list: { branch: string; path: string; isMain: boolean }[] }>>
        worktreeAdd: (workingDir: string, args: { name: string; path: string }) => Promise<IpcResult<{ ok: boolean; path?: string; error?: string }>>
        createPr: (workingDir: string, input: { title: string; body?: string }) => Promise<IpcResult<{ ok: boolean; url?: string; error?: string }>>
        prStatus: (workingDir: string, url?: string, ownsCheckout?: boolean) => Promise<IpcResult<NonNullable<Chat['pullRequest']>>>
        watch: (workingDir: string) => Promise<IpcResult<{ ok: boolean }>>
        unwatch: (workingDir: string) => Promise<IpcResult<{ ok: boolean }>>
        onChanged: (handler: (ev: { workingDir: string }) => void) => () => void
      }
      gateway: {
        status: () => Promise<IpcResult<{
          status: 'healthy' | 'degraded'
          uptime: number
          channels: { telegram: boolean; discord: boolean; imessage: boolean }
          stats: { messagesProcessed: number; activeConversations: number; errors: number }
        } | null>>
        recentLogs: () => Promise<IpcResult<string[]>>
      }
      core: {
        state: () => Promise<IpcResult<CoreState>>
        relaunch: () => Promise<IpcResult<void>>
        onState: (handler: (state: CoreState) => void) => () => void
      }
      notify: {
        onOpenChat: (handler: (msg: { chatId: string }) => void) => () => void
        onOpenSettings: (handler: () => void) => () => void
      }
      capture: {
        submit: (payload: { workspaceName?: string; text: string; filePaths?: string[] }) => Promise<IpcResult<{ chatId: string }>>
        pickFiles: () => Promise<IpcResult<{ files: Array<{ path: string; name: string; size: number }> }>>
        thumbnail: (path: string) => Promise<IpcResult<{ dataUrl: string }>>
        hide: () => Promise<IpcResult<void>>
        setHeight: (height: number) => Promise<IpcResult<void>>
        onShown: (handler: (payload?: { files?: Array<{ path: string; name: string; size: number }> }) => void) => () => void
      }
      voice: {
        onHotkey: (handler: () => void) => () => void
        onConverseHotkey: (handler: () => void) => () => void
        onCancelConverse: (handler: () => void) => () => void
        notifyTranscribed: (text: string) => Promise<IpcResult<void>>
        transcribe: (audio: ArrayBuffer, mime: string) => Promise<IpcResult<{ text: string }>>
        toggleNativeConversation: (fromHotkey?: boolean) => Promise<IpcResult<{ native: boolean }>>
        cancelNativeConversation: () => Promise<IpcResult<void>>
        toggleNativeDictation: () => Promise<IpcResult<{ native: boolean }>>
        cancelNativeDictation: () => Promise<IpcResult<void>>
        onNativeConverseState: (handler: (state: string, fromHotkey: boolean) => void) => () => void
        onNativeConverseLevel: (handler: (level: number) => void) => () => void
        onNativeConverseTranscript: (handler: (text: string) => void) => () => void
        onNativeConverseError: (handler: (message: string) => void) => () => void
        onNativeDictationState: (handler: (state: string) => void) => () => void
        onNativeDictationLevel: (handler: (level: number) => void) => () => void
        onNativeDictationTranscript: (handler: (text: string) => void) => () => void
        onNativeDictationError: (handler: (message: string) => void) => () => void
        getWarmState: () => Promise<IpcResult<{ model: string; startedAt: number } | null>>
        forgetVocabulary: (term: string, alias: string) => Promise<IpcResult<{ ok: boolean }>>
        learnVocabulary: (spoken: string, edited: string) => Promise<IpcResult<{ learned: Array<{ term: string; alias: string }> }>>
        onVocabularyLearned: (handler: (terms: string[]) => void) => () => void
        /** Speak text through the gateway's digest + TTS pipeline. */
        speak: (text: string, conversationId?: string, verbatim?: boolean) => Promise<IpcResult<void>>
        ack: (transcript: string) => Promise<IpcResult<{ text: string }>>
        stopSpeaking: () => Promise<IpcResult<void>>
        setHotkeyCaptureActive: (active: boolean) => Promise<IpcResult<void>>
        setHudState: (state: string) => Promise<IpcResult<void>>
        setHudLevel: (level: number) => void
        onSpeakEvent: (handler: (event: any) => void) => () => void
        showError: (message: string) => Promise<IpcResult<void>>
        downloadModel: (model: string) => Promise<IpcResult<{ model: string }>>
        deleteModel: (model: string) => Promise<IpcResult<{ removed: string[] }>>
        listDownloadedModels: () => Promise<IpcResult<string[]>>
        onDownloadProgress: (handler: (msg: { model: string; fraction: number }) => void) => () => void
        warmModel: (model: string) => Promise<IpcResult<{ model: string; loadSeconds: number }>>
        listWarmedModels: () => Promise<IpcResult<string[]>>
        onWarmStart: (handler: (msg: { model: string }) => void) => () => void
        onWarmDone: (handler: (msg: { model: string; loadSeconds: number }) => void) => () => void
        onWarmError: (handler: (msg: { model: string; error: string }) => void) => () => void
        onPrepareChange: (handler: (msg: { model: string; startedAt: number } | null) => void) => () => void
      }
      app: {
        version: () => Promise<string>
        onZoom: (handler: (factor: number) => void) => () => void
      }
      terminal: {
        list: (chatId: string) => Promise<IpcResult<Array<{ sessionId: string; chatId: string; cwd: string; pid: number; alive: boolean }>>>
        open: (input: { sessionId?: string; chatId: string; cwd: string; cols: number; rows: number }) => Promise<IpcResult<{ sessionId: string; chatId: string; cwd: string; pid: number; output: string; alive: boolean }>>
        write: (sessionId: string, data: string) => Promise<IpcResult<void>>
        resize: (sessionId: string, cols: number, rows: number) => Promise<IpcResult<void>>
        status: (sessionId: string) => Promise<IpcResult<{ sessionId: string; title: string; pid: number; alive: boolean }>>
        restart: (input: { sessionId: string; chatId: string; cwd: string; cols: number; rows: number }) => Promise<IpcResult<{ sessionId: string; chatId: string; cwd: string; pid: number; output: string; alive: boolean }>>
        close: (sessionId: string) => Promise<IpcResult<void>>
        onData: (handler: (event: { sessionId: string; chatId: string; data: string }) => void) => () => void
        onExit: (handler: (event: { sessionId: string; chatId: string; exitCode: number; signal?: number }) => void) => () => void
      }
      chromeCompanion: {
        status: () => Promise<IpcResult<ChromeCompanionStatus>>
        disconnect: () => Promise<IpcResult<ChromeCompanionStatus>>
        activeTab: () => Promise<IpcResult<ChromeTabInfo>>
        snapshot: () => Promise<IpcResult<ChromePageSnapshot>>
        exportSession: (name: string) => Promise<IpcResult<{ profile: BrowserProfileSummary; tab: ChromeTabInfo }>>
        listSessionSites: () => Promise<IpcResult<{ sites: ChromeSessionSite[] }>>
        importSites: (name: string, sites: string[], openMissing?: boolean) => Promise<IpcResult<{
          imported: boolean
          profile: BrowserProfileSummary | null
          cookieCount: number
          sites: string[]
        }>>
        navigate: (url: string) => Promise<IpcResult<ChromeTabInfo>>
        setAccent: (hex: string) => Promise<IpcResult<{ ok: true }>>
        showExtensionFolder: () => Promise<IpcResult<string>>
        openExtensionsPage: () => Promise<IpcResult<{ ok: true }>>
        installExtensionTo: () => Promise<IpcResult<{ installed: false } | { installed: true; dir: string }>>
        onStatus: (handler: (state: ChromeCompanionStatus) => void) => () => void
      }
      browser: {
        getState: () => Promise<IpcResult<BrowserState>>
        show: (bounds: BrowserBounds) => Promise<IpcResult<BrowserState>>
        hide: () => Promise<IpcResult<void>>
        setBounds: (bounds: BrowserBounds) => Promise<IpcResult<void>>
        navigate: (url: string) => Promise<IpcResult<BrowserState>>
        back: () => Promise<IpcResult<BrowserState>>
        forward: () => Promise<IpcResult<BrowserState>>
        reload: () => Promise<IpcResult<BrowserState>>
        stop: () => Promise<IpcResult<BrowserState>>
        getPageContext: () => Promise<IpcResult<BrowserPageContext>>
        downloads: () => Promise<IpcResult<BrowserDownload[]>>
        tabs: () => Promise<IpcResult<BrowserTab[]>>
        newTab: (url?: string) => Promise<IpcResult<BrowserState>>
        switchTab: (id: string) => Promise<IpcResult<BrowserState>>
        closeTab: (id: string) => Promise<IpcResult<BrowserState>>
        resetSession: () => Promise<IpcResult<BrowserState>>
        profiles: {
          list: () => Promise<IpcResult<{ active: string | null; activeNames: string[]; profiles: BrowserProfileSummary[] }>>
          save: (name: string) => Promise<IpcResult<BrowserProfileSummary>>
          activate: (name: string) => Promise<IpcResult<BrowserProfileSummary>>
          enable: (name: string) => Promise<IpcResult<BrowserProfileSummary>>
          disable: (name: string) => Promise<IpcResult<BrowserProfileSummary>>
          setAvatar: (name: string, avatar: string) => Promise<IpcResult<BrowserProfileSummary>>
          delete: (name: string) => Promise<IpcResult<{ deleted: boolean }>>
          import: () => Promise<IpcResult<{ imported: boolean; profile: BrowserProfileSummary | null }>>
          export: (name: string) => Promise<IpcResult<{ exported: boolean; path: string | null }>>
          syncFromChrome: (url: string) => Promise<IpcResult<{ profileName: string; origin: string; cookieCount: number }>>
          syncProfile: (name: string) => Promise<IpcResult<{
            profile: BrowserProfileSummary
            siteCount: number
            cookieCount: number
          }>>
          contents: (name: string) => Promise<IpcResult<{
            name: string
            updatedAt: number
            sourceUrl: string | null
            sites: BrowserProfileSiteSummary[]
          }>>
        }
        extensions: {
          list: () => Promise<IpcResult<BrowserExtensionEntry[]>>
          discoverChrome: () => Promise<IpcResult<ChromeBrowserExtensionCandidate[]>>
          pick: () => Promise<IpcResult<BrowserExtensionCandidate | null>>
          install: (path: string) => Promise<IpcResult<BrowserExtensionEntry[]>>
          importFromChrome: (path: string) => Promise<IpcResult<BrowserExtensionEntry[]>>
          setEnabled: (key: string, enabled: boolean) => Promise<IpcResult<BrowserExtensionEntry[]>>
          reload: (key: string) => Promise<IpcResult<BrowserExtensionEntry[]>>
          remove: (key: string) => Promise<IpcResult<BrowserExtensionEntry[]>>
        }
        controlPermission: {
          get: () => Promise<IpcResult<BrowserControlPermissionState>>
          approve: (level?: BrowserControlLevel) => Promise<IpcResult<BrowserControlPermissionState>>
          deny: () => Promise<IpcResult<BrowserControlPermissionState>>
          revoke: (surface?: BrowserControlSurface) => Promise<IpcResult<BrowserControlPermissionState>>
        }
        sitePermission: {
          get: () => Promise<IpcResult<BrowserSitePermissionState>>
          allowForSession: (id: string) => Promise<IpcResult<BrowserSitePermissionState>>
          alwaysAllow: (id: string) => Promise<IpcResult<BrowserSitePermissionState>>
          block: (id: string) => Promise<IpcResult<BrowserSitePermissionState>>
        }
        onState: (handler: (state: BrowserState) => void) => () => void
        onAgentOpen: (handler: (message: { url: string }) => void) => () => void
        onControlPermission: (handler: (state: BrowserControlPermissionState) => void) => () => void
        onSitePermission: (handler: (state: BrowserSitePermissionState) => void) => () => void
        onLoginWait: (handler: (event: BrowserLoginWaitEvent) => void) => () => void
        onDownload: (handler: (download: BrowserDownload) => void) => () => void
      }
      updater: {
        check: () => Promise<IpcResult<void>>
        download: () => Promise<IpcResult<void>>
        install: () => Promise<IpcResult<void>>
        lastState: () => Promise<IpcResult<UpdaterEvent | null>>
        onState: (handler: (state: UpdaterEvent) => void) => () => void
      }
      openExternal: (url: string) => Promise<void>
      openPath: (path: string) => Promise<string>
      revealInFolder: (path: string) => Promise<boolean>
      readTextFile: (path: string) => Promise<string | null>
      onLog: (handler: (msg: string) => void) => () => void
    }
  }
}

export {}
