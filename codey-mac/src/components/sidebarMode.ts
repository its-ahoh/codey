import type { Chat } from '../types'

export type SidebarMode = 'bots' | 'workspaces'
export const SIDEBAR_MODE_KEY = 'codey.sidebarMode'
export function readSidebarMode(value: string | null): SidebarMode {
  return value === 'bots' ? 'bots' : 'workspaces'
}
export function chatInSidebarMode(chat: Chat, mode: SidebarMode): boolean {
  return mode === 'bots' ? !!chat.botChat : !chat.botChat
}
export function nextChatForSidebar(chats: Record<string, Chat>, order: string[], mode: SidebarMode, remembered: string | null): string | null {
  if (remembered && chats[remembered] && chatInSidebarMode(chats[remembered], mode)) return remembered
  return order.find(id => chats[id] && chatInSidebarMode(chats[id], mode)) ?? null
}
