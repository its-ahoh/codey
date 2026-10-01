import type { BrowserSkillStatus } from '@codey/core'

/**
 * A plugin is an agent capability represented by ordinary skills. Browser is
 * pulled from the published skills repository; Chrome Companion ships with the
 * app and uses a reversible enable switch; pstack is a pack of many skills
 * pulled together. State is read from the skill file on
 * disk rather than duplicated in config, so Plugins, Skills and agent execution
 * always agree.
 */
export interface PluginInfo extends BrowserSkillStatus {
  id: 'browser' | 'chrome-companion' | 'pstack'
  name: string
  /** One line that says which browser this is. The two plugins are easy to
   *  confuse, so the card leads with this rather than the full description. */
  tagline: string
  description: string
}

/** Static registry of Codey plugins. */
export const PLUGINS: Array<Pick<PluginInfo, 'id' | 'name' | 'tagline' | 'description'>> = [
  {
    id: 'browser',
    name: 'Codey Browser',
    tagline: 'Codey’s own browser window — its own profiles and logins.',
    description:
      'Let agents see and control the in-app Codey Browser. Works with every agent '
      + 'Codey runs. Browsing stays view-only by default; actions that change page '
      + 'state still require your approval in the app.',
  },
  {
    id: 'chrome-companion',
    name: 'Chrome',
    tagline: 'The real Chrome on your Mac — its open tabs and signed-in session.',
    description:
      'Let agents work through your real Google Chrome tabs and existing signed-in session. '
      + 'The companion extension connects locally and is independent from the in-app Browser plugin.',
  },
  {
    id: 'pstack',
    name: 'pstack',
    tagline: 'poteto’s engineering skills — go deep first, then go fast.',
    description:
      '47 skills by Lauren Tan (poteto) for rigorous agent work: start with /poteto-mode, which '
      + 'picks playbooks for bug fixes, features, refactors, perf and shipping. Written for Cursor, '
      + 'so its multi-model steps name Cursor models; the principle skills work in every agent. MIT licensed.',
  },
]

/** True when the id names a registered plugin. Guards IPC writes. */
export function isKnownPlugin(id: string): boolean {
  return PLUGINS.some(plugin => plugin.id === id)
}

export function listPlugins(status: (id: PluginInfo['id']) => BrowserSkillStatus): PluginInfo[] {
  return PLUGINS.map(plugin => ({ ...plugin, ...status(plugin.id) }))
}
