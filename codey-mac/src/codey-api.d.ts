import type { Chat, ChatSelection } from '../../packages/core/src/types/chat'
import type { ChatStreamEvent, QQStreamEvent } from '../../packages/gateway/src/chat-runner'
import type { TaskBrief } from '../types'
import type { TeamConfigRaw } from '../../packages/core/src/workspace'
import type { ApiKeyEntry } from '../../packages/core/src/types/index'
import type { UpdaterEvent } from './hooks/updaterState'
import type { CoreState } from '../electron/core-state'
import type { Automation, AutomationRun, AutomationEvent } from '../../packages/core/src/types/automation'
import type { InterviewStep } from '../../packages/gateway/src/automations/interview'
import type { ChatStep } from '../../packages/gateway/src/automations/chat'

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface SkillEntry {
  name: string
  description: string
  scope: 'user' | 'project'
  dir: string
}

export interface SkillsListResult {
  skills: SkillEntry[]
  projectDir: string | null
}

export interface ModelEntry {
  apiType: 'anthropic' | 'openai'
  model: string
  apiKeyRef?: string
  provider?: string
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
        getMemory: (name: string) => Promise<IpcResult<string>>
        setMemory: (name: string, content: string) => Promise<IpcResult<void>>
        create: (dir: string) => Promise<IpcResult<string>>
        delete: (name: string) => Promise<IpcResult<void>>
        rename: (oldName: string, newName: string) => Promise<IpcResult<void>>
        reveal: (name: string) => Promise<IpcResult<void>>
      }
      dialog: {
        pickDirectory: () => Promise<IpcResult<string | null>>
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
        resume: (id: string, runId: string, answer: string) => Promise<IpcResult<AutomationRun>>
        history: (id: string, limit?: number) => Promise<IpcResult<AutomationRun[]>>
        markSeen: (id: string, runId: string) => Promise<IpcResult<void>>
        chatStart: (mode: 'create' | 'edit', automationId?: string) => Promise<IpcResult<ChatStep>>
        chatSend: (sessionId: string, text: string) => Promise<IpcResult<ChatStep>>
        chatCancel: (sessionId: string) => Promise<IpcResult<void>>
        interviewStart: (goal: string, targetContext: string) => Promise<IpcResult<InterviewStep>>
        interviewAnswer: (sessionId: string, text: string) => Promise<IpcResult<InterviewStep>>
        interviewCancel: (sessionId: string) => Promise<IpcResult<void>>
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
      skills: {
        list: (agent?: string) => Promise<IpcResult<SkillsListResult>>
        install: (payload: { agent?: string; scope: 'user' | 'project'; localDir?: string; gitUrl?: string }) => Promise<IpcResult<{ name: string; dir: string }>>
        remove: (dir: string) => Promise<IpcResult<void>>
        reveal: (dir: string) => Promise<IpcResult<void>>
      }
      learnedSkills: {
        list: () => Promise<IpcResult<Array<{
          name: string; description: string; version: number; useCount: number;
          lastUsedAt: number; archived: boolean;
          successSignals: { cleanRuns: number; corrections: number };
          canRollback: boolean;
        }>>>
        history: (name: string) => Promise<IpcResult<Array<{
          at: number;
          kind: 'created' | 'evolved' | 'rolled-back';
          fromVersion?: number;
          toVersion: number;
          trigger?: { runId: string; promptSummary: string };
          steps: string;
        }>>>
        forget: (name: string) => Promise<IpcResult<void>>
        restore: (name: string) => Promise<IpcResult<void>>
        rollback: (name: string) => Promise<IpcResult<number>>
      }
      agents: {
        get: () => Promise<IpcResult<Record<string, { enabled?: boolean; defaultModel?: string; env?: Record<string, string> }>>>
        set: (updates: Record<string, { enabled?: boolean; defaultModel?: string; env?: Record<string, string> }>) => Promise<IpcResult<void>>
        checkInstalled: () => Promise<IpcResult<Record<string, { installed: boolean; path?: string }>>>
        slashCommands: (agent: string) => Promise<IpcResult<Array<{ name: string; description: string; source: 'agent' | 'gateway' }>>>
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
        send: (payload: { chatId: string; text: string; attachments?: Array<{ id: string; name: string; path: string; mimeType: string; size: number }> }) => Promise<IpcResult<{ response: string; chatId: string; tokens?: number; durationSec?: number }>>
        stop: (chatId: string) => Promise<IpcResult<boolean>>
        onEvent: (handler: (ev: ChatStreamEvent) => void) => () => void
        link: (chatId: string, channel: 'telegram' | 'discord' | 'imessage', channelUserId: string) => Promise<IpcResult<Chat>>
        unlink: (chatId: string, channel: 'telegram' | 'discord' | 'imessage', channelUserId: string) => Promise<IpcResult<Chat>>
        updateContextPanelOpen: (id: string, open: boolean | null) => Promise<IpcResult<Chat>>
        setSoloAdvisor: (id: string, enabled: boolean) => Promise<IpcResult<Chat>>
        setWorkingDir: (id: string, dir: string | null) => Promise<IpcResult<Chat>>
      }
      qq: {
        ask: (payload: { chatId: string; question: string; history: Array<{ role: 'user' | 'assistant'; content: string }>; attachments?: Array<{ id: string; name: string; path: string; mimeType: string; size: number }> }) => Promise<IpcResult<{ response: string; tokens?: number; durationSec?: number }>>
        stop: (chatId: string) => Promise<IpcResult<boolean>>
        onEvent: (handler: (ev: QQStreamEvent) => void) => () => void
      }
      permissions: {
        addAllowed: (toolNames: string[], chatId?: string) => Promise<IpcResult<{ added: number }>>
      }
      pairing: {
        start: (channel: 'telegram' | 'discord' | 'imessage') => Promise<IpcResult<string>>
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
        worktrees: (workingDir: string) => Promise<IpcResult<{ list: { branch: string; path: string; isMain: boolean }[] }>>
        worktreeAdd: (workingDir: string, args: { name: string; path: string }) => Promise<IpcResult<{ ok: boolean; path?: string; error?: string }>>
        createPr: (workingDir: string, input: { title: string; body?: string }) => Promise<IpcResult<{ ok: boolean; url?: string; error?: string }>>
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
        notifyTranscribed: (text: string) => Promise<IpcResult<void>>
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
      }
      app: {
        version: () => Promise<string>
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
