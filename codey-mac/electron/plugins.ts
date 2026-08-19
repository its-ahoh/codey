import type { BrowserSkillStatus } from '@codey/core'

/**
 * A plugin is a capability Codey installs as an ordinary skill, pulled from the
 * published skills repository. Installing is the only thing the Plugins tab
 * does: once installed, the skill belongs to the user, and the Skills tab's own
 * on/off and delete are the controls that act on it. That is why the state is
 * read from disk rather than from config — two tabs describe one directory, and
 * neither may claim something the other contradicts.
 */
export interface PluginInfo extends BrowserSkillStatus {
  id: 'browser'
  name: string
  description: string
}

/** Static registry of Codey plugins. */
export const PLUGINS: Array<Pick<PluginInfo, 'id' | 'name' | 'description'>> = [
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

export function listPlugins(status: (id: PluginInfo['id']) => BrowserSkillStatus): PluginInfo[] {
  return PLUGINS.map(plugin => ({ ...plugin, ...status(plugin.id) }))
}
