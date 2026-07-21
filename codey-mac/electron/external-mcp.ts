export interface ExternalMcpDraft {
  name: string
  transport: 'stdio' | 'remote'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  enabled?: boolean
}

export type ExternalMcpValidation =
  | { ok: true; name: string; config: { transport: 'stdio' | 'remote'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled: boolean } }
  | { ok: false; error: string }

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i
/** Names Codey's own plugins claim; user servers may not shadow them. */
const RESERVED_NAMES = new Set(['codey-browser'])

/** Validate a renderer-submitted external MCP server before it reaches config. */
export function validateExternalMcp(draft: ExternalMcpDraft): ExternalMcpValidation {
  const name = (draft.name ?? '').trim()
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, error: 'Name must start with a letter or digit and use only letters, digits, - and _' }
  }
  if (RESERVED_NAMES.has(name)) {
    return { ok: false, error: `"${name}" is reserved for Codey's built-in plugins` }
  }
  if (draft.transport === 'stdio') {
    const command = (draft.command ?? '').trim()
    if (!command) return { ok: false, error: 'A command is required for stdio servers' }
    return {
      ok: true,
      name,
      config: {
        transport: 'stdio',
        command,
        args: (draft.args ?? []).map(String),
        env: draft.env ?? {},
        enabled: draft.enabled === true,
      },
    }
  }
  if (draft.transport === 'remote') {
    const url = (draft.url ?? '').trim()
    if (!/^https?:\/\/.+/i.test(url)) {
      return { ok: false, error: 'Remote servers need an http(s) URL' }
    }
    return { ok: true, name, config: { transport: 'remote', url, enabled: draft.enabled === true } }
  }
  return { ok: false, error: 'Transport must be stdio or remote' }
}
