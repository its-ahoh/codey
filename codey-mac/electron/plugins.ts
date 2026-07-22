export interface PluginInfo {
  id: 'browser'
  name: string
  description: string
  enabled: boolean
}

/** Static registry of Codey plugins. Enablement lives in gateway config. */
export const PLUGINS: Array<Omit<PluginInfo, 'enabled'>> = [
  {
    id: 'browser',
    name: 'Browser',
    description:
      'Let agents see and control the in-app Codey Browser through typed MCP tools. '
      + 'Browsing stays view-only by default; actions that change page state still '
      + 'require your approval in the app.',
  },
]

/** True when the id names a registered plugin. Guards IPC writes. */
export function isKnownPlugin(id: string): boolean {
  return PLUGINS.some(plugin => plugin.id === id)
}

export function listPlugins(config: { plugins?: Record<string, { enabled?: boolean }> } | undefined): PluginInfo[] {
  return PLUGINS.map(plugin => ({
    ...plugin,
    enabled: config?.plugins?.[plugin.id]?.enabled === true,
  }))
}
