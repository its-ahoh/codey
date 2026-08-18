/**
 * Read-only discovery of MCP servers that are already configured inside the
 * coding agents themselves (Claude Code, Codex, OpenCode).
 *
 * Codey's own `mcpServers` config only knows about servers added through the
 * MCP tab; anything a user set up with `claude mcp add`, `~/.codex/config.toml`
 * or an opencode config stays invisible. This module scans those native config
 * files so the tab can show the full picture, tagged with the owning agent.
 *
 * Everything here is read-only and best-effort: an unreadable or malformed
 * config yields no entries rather than an error, because one broken agent
 * config must not blank out the whole list.
 *
 * pi is deliberately absent — it has no MCP surface (see agents/pi.ts).
 */

export type McpAgentKey = 'claude-code' | 'codex' | 'opencode'

export interface AgentMcpServer {
  /** Which coding agent's own config this server came from. */
  agent: McpAgentKey
  name: string
  transport: 'stdio' | 'remote'
  command?: string
  args?: string[]
  url?: string
  /** 'user' = the agent's global config, 'project' = the workspace's repo. */
  scope: 'user' | 'project'
  /** false when the agent's own config marks the server disabled. */
  enabled: boolean
  /** Absolute path of the config file it was read from, for the tooltip. */
  source: string
}

/** Minimal fs surface, injected so the scan is testable without a real disk. */
export interface ScanFs {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf-8'): string
}

export interface ScanPath {
  join(...parts: string[]): string
  isAbsolute(p: string): boolean
}

export interface ScanOptions {
  fs: ScanFs
  path: ScanPath
  home: string
  /** Working directory of the active workspace; enables project-scope entries. */
  workingDir?: string | null
  /** Per-agent env overrides from Codey's config (CLAUDE_CONFIG_DIR, …). */
  agentEnv?: Partial<Record<McpAgentKey, Record<string, string> | undefined>>
}

function readJson(fs: ScanFs, file: string): any {
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf-8')))
  } catch {
    return null
  }
}

/**
 * OpenCode accepts .jsonc, and hand-edited .json files often carry comments
 * too. Strips line and block comments outside of strings; leaves
 * everything else intact.
 */
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch }
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i++ }
      continue
    }
    if (inString) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i++ }
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '/' && next === '/') { inLine = true; i++; continue }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue }
    out += ch
  }
  return out
}

/** `~/x` and relative paths in agent env vars resolve against home. */
function resolveDir(path: ScanPath, value: string, home: string): string {
  if (value.startsWith('~/')) return path.join(home, value.slice(2))
  if (path.isAbsolute(value)) return value
  return path.join(home, value)
}

/** Claude Code's `mcpServers` map: `{ type?, url?, command?, args?, env? }`. */
function claudeEntries(
  raw: any,
  scope: 'user' | 'project',
  source: string,
  disabled: Set<string>,
): AgentMcpServer[] {
  if (!raw || typeof raw !== 'object') return []
  const out: AgentMcpServer[] = []
  for (const [name, cfg] of Object.entries<any>(raw)) {
    if (!cfg || typeof cfg !== 'object') continue
    const url = typeof cfg.url === 'string' ? cfg.url : undefined
    out.push({
      agent: 'claude-code',
      name,
      transport: url ? 'remote' : 'stdio',
      command: typeof cfg.command === 'string' ? cfg.command : undefined,
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
      url,
      scope,
      enabled: !disabled.has(name),
      source,
    })
  }
  return out
}

function scanClaudeCode(opts: ScanOptions): AgentMcpServer[] {
  const { fs, path, home, workingDir } = opts
  const configDir = opts.agentEnv?.['claude-code']?.CLAUDE_CONFIG_DIR
  const configFile = configDir
    ? path.join(resolveDir(path, configDir, home), '.claude.json')
    : path.join(home, '.claude.json')

  const config = readJson(fs, configFile)
  const out: AgentMcpServer[] = []
  out.push(...claudeEntries(config?.mcpServers, 'user', configFile, new Set()))

  if (!workingDir) return out
  const project = config?.projects?.[workingDir]
  // A project-scoped .mcp.json is opt-in per server; the toggles live in the
  // user config, so both files have to be read together.
  const disabled = new Set<string>(
    Array.isArray(project?.disabledMcpjsonServers) ? project.disabledMcpjsonServers.map(String) : [],
  )
  out.push(...claudeEntries(project?.mcpServers, 'project', configFile, new Set()))

  const mcpJsonFile = path.join(workingDir, '.mcp.json')
  out.push(...claudeEntries(readJson(fs, mcpJsonFile)?.mcpServers, 'project', mcpJsonFile, disabled))
  return out
}

/**
 * Just enough TOML to read `[mcp_servers.<name>]` tables out of a Codex
 * config: table headers (including the `.env` sub-table, which is skipped),
 * quoted/bare keys, string, bool and flat string-array values. Anything more
 * exotic is ignored rather than guessed at.
 */
export function parseCodexMcpServers(toml: string): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {}
  let current: Record<string, unknown> | null = null
  for (const rawLine of toml.split('\n')) {
    const line = rawLine.replace(/^\s+|\s+$/g, '')
    if (!line || line.startsWith('#')) continue
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) {
      const parts = splitTomlKey(header[1])
      if (parts.length === 2 && parts[0] === 'mcp_servers') {
        const name = parts[1]
        current = servers[name] ?? (servers[name] = {})
      } else {
        // `[mcp_servers.x.env]` and every unrelated table: stop collecting.
        current = null
      }
      continue
    }
    if (!current) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = unquote(line.slice(0, eq).trim())
    const value = parseTomlValue(line.slice(eq + 1).trim())
    if (value !== undefined) current[key] = value
  }
  return servers
}

/** Split a dotted TOML key, honouring quoted segments like `"my-server"`. */
function splitTomlKey(key: string): string[] {
  const parts: string[] = []
  let buf = ''
  let inString = false
  for (let i = 0; i < key.length; i++) {
    const ch = key[i]
    if (ch === '"') { inString = !inString; continue }
    if (ch === '.' && !inString) { parts.push(buf.trim()); buf = ''; continue }
    buf += ch
  }
  parts.push(buf.trim())
  return parts.filter(p => p.length > 0)
}

function unquote(value: string): string {
  const m = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value)
  return m ? m[1] : value
}

function parseTomlValue(raw: string): unknown {
  const value = raw.replace(/\s+#.*$/, '').trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (value.startsWith('[')) {
    const inner = value.replace(/^\[/, '').replace(/\]$/, '')
    if (!inner.trim()) return []
    return inner
      .split(',')
      .map(part => unquote(part.trim()))
      .filter(part => part.length > 0)
  }
  if (value.startsWith('"') || value.startsWith("'")) return unquote(value)
  return undefined
}

function scanCodex(opts: ScanOptions): AgentMcpServer[] {
  const { fs, path, home } = opts
  const codexHome = opts.agentEnv?.codex?.CODEX_HOME
  const file = path.join(codexHome ? resolveDir(path, codexHome, home) : path.join(home, '.codex'), 'config.toml')
  if (!fs.existsSync(file)) return []
  let servers: Record<string, Record<string, unknown>>
  try {
    servers = parseCodexMcpServers(fs.readFileSync(file, 'utf-8'))
  } catch {
    return []
  }
  return Object.entries(servers).map(([name, cfg]) => {
    const url = typeof cfg.url === 'string' ? cfg.url : undefined
    return {
      agent: 'codex' as const,
      name,
      transport: url ? ('remote' as const) : ('stdio' as const),
      command: typeof cfg.command === 'string' ? cfg.command : undefined,
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
      url,
      scope: 'user' as const,
      enabled: cfg.enabled !== false,
      source: file,
    }
  })
}

/** OpenCode's `mcp` map: `{ type: 'local' | 'remote', command: [], url, enabled }`. */
function opencodeEntries(raw: any, scope: 'user' | 'project', source: string): AgentMcpServer[] {
  if (!raw || typeof raw !== 'object') return []
  const out: AgentMcpServer[] = []
  for (const [name, cfg] of Object.entries<any>(raw)) {
    if (!cfg || typeof cfg !== 'object') continue
    const url = typeof cfg.url === 'string' ? cfg.url : undefined
    const command = Array.isArray(cfg.command) ? cfg.command.map(String) : []
    out.push({
      agent: 'opencode',
      name,
      transport: cfg.type === 'remote' || url ? 'remote' : 'stdio',
      command: command[0],
      args: command.slice(1),
      url,
      scope,
      enabled: cfg.enabled !== false,
      source,
    })
  }
  return out
}

function scanOpenCode(opts: ScanOptions): AgentMcpServer[] {
  const { fs, path, home, workingDir } = opts
  const xdg = opts.agentEnv?.opencode?.XDG_CONFIG_HOME
  const configRoot = xdg ? resolveDir(path, xdg, home) : path.join(home, '.config')
  const out: AgentMcpServer[] = []
  for (const file of candidates(path, path.join(configRoot, 'opencode'))) {
    const found = opencodeEntries(readJson(fs, file)?.mcp, 'user', file)
    if (found.length > 0) { out.push(...found); break }
  }
  if (workingDir) {
    for (const file of candidates(path, workingDir)) {
      const found = opencodeEntries(readJson(fs, file)?.mcp, 'project', file)
      if (found.length > 0) { out.push(...found); break }
    }
  }
  return out
}

function candidates(path: ScanPath, dir: string): string[] {
  return [path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc')]
}

/**
 * Every MCP server already configured inside the coding agents, sorted by
 * agent then name. The same server name may legitimately appear more than
 * once (different agents, or user vs project scope) — each entry is kept so
 * the user can see where it comes from.
 */
export function scanAgentMcpServers(opts: ScanOptions): AgentMcpServer[] {
  const scans: Array<(o: ScanOptions) => AgentMcpServer[]> = [scanClaudeCode, scanCodex, scanOpenCode]
  const all: AgentMcpServer[] = []
  for (const scan of scans) {
    try { all.push(...scan(opts)) } catch { /* one broken config must not blank the list */ }
  }
  const order: Record<McpAgentKey, number> = { 'claude-code': 0, codex: 1, opencode: 2 }
  return all.sort((a, b) =>
    order[a.agent] - order[b.agent] || a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope))
}
