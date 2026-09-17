import { describe, expect, it } from 'vitest'
import type { Chat } from '../types'
import { readSidebarMode, chatInSidebarMode, nextChatForSidebar } from './sidebarMode'

const project: Chat = { id: 'project', title: 'Project', workspaceName: 'main', selection: { type: 'none' }, createdAt: 1, updatedAt: 1, messages: [] }
const bot: Chat = { ...project, id: 'bot', botChat: { kind: 'direct', members: ['alice'], homeDir: '/tmp/alice' } }
const group: Chat = { ...bot, id: 'group', botChat: { kind: 'group', members: ['alice', 'ben'], homeDir: '/tmp/group' } }
const chats = { project, bot, group }

describe('sidebar view switching', () => {
  it('preserves the existing workspace default and restores a valid preference', () => {
    expect(readSidebarMode(null)).toBe('workspaces')
    expect(readSidebarMode('invalid')).toBe('workspaces')
    expect(readSidebarMode('bots')).toBe('bots')
  })
  it('separates global Bot conversations from project chats', () => {
    expect(chatInSidebarMode(project, 'bots')).toBe(false)
    expect(chatInSidebarMode(bot, 'workspaces')).toBe(false)
    expect(chatInSidebarMode(group, 'bots')).toBe(true)
  })
  it('restores each view independently and recovers deleted or wrong-view selections', () => {
    expect(nextChatForSidebar(chats, ['project', 'group', 'bot'], 'bots', 'bot')).toBe('bot')
    expect(nextChatForSidebar(chats, ['project', 'group', 'bot'], 'bots', 'project')).toBe('group')
    expect(nextChatForSidebar(chats, ['project', 'group', 'bot'], 'workspaces', 'deleted')).toBe('project')
    expect(nextChatForSidebar({ project }, ['project'], 'bots', null)).toBeNull()
  })
})
