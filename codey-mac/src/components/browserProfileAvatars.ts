import type { BrowserProfileSummary } from '../codey-api'

export const BROWSER_PROFILE_AVATARS = [
  '👤', '💼', '🏠', '🚀', '🧑‍💻', '🎨', '🌟', '🦊',
  '🐱', '🐶', '🐼', '🐸', '🦁', '🐯', '🐵', '🐧',
  '🌈', '🔥', '⚡️', '💎', '🎯', '🧠', '🤖', '👻',
  '☕️', '📚', '🎮', '🎵', '📷', '✈️', '🌍', '🍀',
] as const

export function browserProfileAvatar(profile: Pick<BrowserProfileSummary, 'avatar'> | undefined): string {
  return profile?.avatar || BROWSER_PROFILE_AVATARS[0]
}
