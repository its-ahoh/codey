import { useCallback, useEffect, useRef } from 'react'
import { apiService } from '../services/api'
import { useChats } from './useChats'
import type { Chat } from '../types'

/** How often the watcher re-checks open PRs. Each check shells out to `gh`,
 *  so this is deliberately slower than the per-chat refresh ChatTab already
 *  does on mount and on window focus. */
export const PR_POLL_INTERVAL_MS = 2 * 60_000

type PullRequest = NonNullable<Chat['pullRequest']>

/** Chats worth polling: those whose PR is still open. Merged/closed chats are
 *  terminal for the watcher — ChatTab still refreshes the active chat, which is
 *  what turns `merged` into `merged-with-changes` once new commits land. */
export function chatsNeedingPrRefresh(chats: Chat[]): Chat[] {
  return chats.filter(chat => chat.pullRequest?.state === 'pr-open' && !!chat.pullRequest.url)
}

/** True when a fetched status differs in a way the ChatList badge cares about.
 *  `lastCheckedAt` alone changes on every poll and is not worth a disk write. */
export function prStatusChanged(prev: PullRequest, next: PullRequest): boolean {
  return prev.state !== next.state
    || prev.url !== next.url
    || prev.number !== next.number
    || prev.mergedAt !== next.mergedAt
    || prev.headCommit !== next.headCommit
}

/** The directory `gh`/`git` should run in for a chat — the same resolution
 *  ChatTab uses, with the workspace root looked up from `workspaceDirs`. */
export function prWorkingDir(chat: Chat, workspaceDirs: Record<string, string>): string | undefined {
  if (chat.executionMode === 'isolated-worktree') return chat.chatWorkspace?.workingDir
  return chat.workingDirOverride || workspaceDirs[chat.workspaceName]
}

/** Periodically re-checks every chat with an open PR and updates the chat when
 *  the PR has been merged or closed, so the ChatList badge stays honest without
 *  the user having to open each chat. Mount once, app-wide. */
export function usePullRequestWatcher(): void {
  const { state, setPullRequest } = useChats()

  // Read chats through a ref so the polling effect doesn't restart (and reset
  // its timer) on every message that lands in any chat.
  const chatsRef = useRef(state.chats)
  chatsRef.current = state.chats
  const workspaceDirs = useRef<Record<string, string>>({})
  const running = useRef(false)

  const resolveWorkingDir = useCallback(async (chat: Chat): Promise<string | undefined> => {
    if (chat.executionMode !== 'isolated-worktree'
      && !chat.workingDirOverride
      && !(chat.workspaceName in workspaceDirs.current)) {
      try {
        const info = await apiService.getWorkspaceInfo(chat.workspaceName)
        workspaceDirs.current[chat.workspaceName] = info.workingDir
      } catch { /* an unreachable workspace just means we skip this chat */ }
    }
    return prWorkingDir(chat, workspaceDirs.current)
  }, [])

  const sweep = useCallback(async () => {
    // Skip while the window is hidden: nobody is looking at the badges, and
    // the focus listener below catches up as soon as they are.
    if (running.current || document.hidden) return
    running.current = true
    try {
      // Sequential on purpose — each check spawns a `gh` process.
      for (const chat of chatsNeedingPrRefresh(Object.values(chatsRef.current))) {
        const workingDir = await resolveWorkingDir(chat)
        if (!workingDir) continue
        try {
          const result = await window.codey.git.prStatus(workingDir, chat.pullRequest!.url)
          const current = chatsRef.current[chat.id]?.pullRequest
          if (result.ok && current && prStatusChanged(current, result.data)) {
            await setPullRequest(chat.id, result.data)
          }
        } catch { /* PR status is best effort */ }
      }
    } finally {
      running.current = false
    }
  }, [resolveWorkingDir, setPullRequest])

  useEffect(() => {
    void sweep()
    const timer = setInterval(() => void sweep(), PR_POLL_INTERVAL_MS)
    const onFocus = () => void sweep()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [sweep])
}
