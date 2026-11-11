import { bundledSkill } from './bundled-skill'

export const COMPUTER_SKILL_NAME = 'computer'

/**
 * The Computer plugin: lets an agent see and operate the Mac apps the user
 * allowed. It ships with the app and is switched on and off like Terminal.
 *
 * The skill is discovery only, and it is also the remembered switch: Codey's
 * desktop app turns computer control on while this file is enabled and its
 * setup (macOS permissions, an app list) is complete. The capability gate is
 * the environment: the app hands `CODEY_COMPUTER_*` to a task turn only then,
 * and the CLI refuses to do anything without them.
 */
export const computerSkill = bundledSkill(COMPUTER_SKILL_NAME, 'Computer', 'the Computer plugin built into Codey')

export const computerSkillStatus = computerSkill.status
export const isComputerSkillActive = computerSkill.isActive
export const setComputerSkillEnabled = computerSkill.setEnabled
