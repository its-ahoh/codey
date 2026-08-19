import type { BrowserSkillState } from '@codey/core'

/**
 * A plugin is a capability Codey installs as an ordinary skill. Installing is
 * the only thing the Plugins tab does: once installed, the skill belongs to the
 * user, and the Skills tab's own on/off and delete are the controls that act on
 * it. That is why `state` is read from disk rather than from config — two tabs
 * describe one directory, and neither may claim something the other contradicts.
 */
export interface PluginInfo {
  id: 'browser'
  name: string
  description: string
  /** `absent` = not installed, `disabled` = installed but off in Skills. */
  state: BrowserSkillState
  /** The installed copy is older than the one this build ships. */
  updateAvailable: boolean
}

/** Static registry of Codey plugins. */
export const PLUGINS: Array<Omit<PluginInfo, 'state' | 'updateAvailable'>> = [
  {
    id: 'browser',
    name: 'Browser',
    description:
      'Let agents see and control the in-app Codey Browser. Works with every agent '
      + 'Codey runs. Browsing stays view-only by default; actions that change page '
      + 'state still require your approval in the app.',
  },
]

/** True when the id names a registered plugin. Guards IPC writes. */
export function isKnownPlugin(id: string): boolean {
  return PLUGINS.some(plugin => plugin.id === id)
}

export function listPlugins(
  status: (id: PluginInfo['id']) => { state: BrowserSkillState; updateAvailable: boolean },
): PluginInfo[] {
  return PLUGINS.map(plugin => ({ ...plugin, ...status(plugin.id) }))
}
