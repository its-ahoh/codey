import { bundledSkill } from './bundled-skill'

export const TERMINAL_SKILL_NAME = 'terminal'

/**
 * The Terminal plugin: lets an agent run commands in the Terminal panel the
 * user can see, next to the chat. It ships with the app (there is nothing to
 * download) and is switched on and off like Chrome Companion.
 *
 * The skill is discovery only. The capability gate is the environment:
 * `addCodeyTerminalTools` hands `CODEY_TERMINAL_*` to task-performing turns of
 * a desktop chat, and the CLI refuses to do anything without them.
 */
export const terminalSkill = bundledSkill(TERMINAL_SKILL_NAME, 'Terminal', 'the Terminal plugin built into Codey')

export const terminalSkillStatus = terminalSkill.status
export const isTerminalSkillActive = terminalSkill.isActive
export const setTerminalSkillEnabled = terminalSkill.setEnabled
export const installTerminalSkill = terminalSkill.install
export const uninstallTerminalSkill = terminalSkill.uninstall
export const checkTerminalSkillUpdate = terminalSkill.checkUpdate
