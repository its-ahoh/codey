import type { SkillPackInfo } from '../codey-api'

/** What the user can paste into "Install a skill". One field takes a single
 *  skill or a whole pack; the gateway looks inside to tell which. */
export const SKILL_PACK_PLACEHOLDER = 'https://github.com/user/my-skill or ~/path/to/skills'

/** The source without its scheme, short enough for one line. */
export function skillPackSourceLabel(source: string): string {
  return source.replace(/^https?:\/\//, '').replace(/^file:\/\//, '').replace(/\.git$/, '')
}

/** One status line for a pack row: size, origin, and what an update check found. */
export function describeSkillPack(pack: Pick<SkillPackInfo, 'skills' | 'source' | 'state'>, needsUpdate?: boolean | null): string {
  const parts = [`${pack.skills.length} skill${pack.skills.length === 1 ? '' : 's'}`, skillPackSourceLabel(pack.source)]
  if (pack.state === 'disabled') parts.push('turned off')
  if (needsUpdate === true) parts.push('update available')
  return parts.join(' · ')
}

/** The confirm() text before replacing skills the pack does not own. */
export function skillPackConflictPrompt(id: string, names: string[]): string {
  // A single skill reports itself as a pack of one named after itself.
  if (names.length === 1 && names[0] === id) return `You already have a skill named "${id}".\n\nReplace it?`
  const shown = names.slice(0, 5).join(', ')
  const more = names.length > 5 ? ` and ${names.length - 5} more` : ''
  return `"${id}" has skills with the same names as ones you already have: ${shown}${more}.\n\nReplace them with the pack's copies?`
}
