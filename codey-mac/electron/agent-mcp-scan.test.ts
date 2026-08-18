import { describe, expect, it } from 'vitest'
import * as nodePath from 'path'
import { parseCodexMcpServers, scanAgentMcpServers, stripJsonComments, type ScanFs } from './agent-mcp-scan'

const HOME = '/home/u'

/** In-memory disk: keys are absolute paths, values are file contents. */
const fakeFs = (files: Record<string, string>): ScanFs => ({
  existsSync: (p: string) => Object.prototype.hasOwnProperty.call(files, p),
  readFileSync: (p: string) => {
    const content = files[p]
    if (content === undefined) throw new Error(`ENOENT: ${p}`)
    return content
  },
})

const scan = (files: Record<string, string>, extra: Partial<Parameters<typeof scanAgentMcpServers>[0]> = {}) =>
  scanAgentMcpServers({ fs: fakeFs(files), path: nodePath, home: HOME, ...extra })

describe('scanAgentMcpServers — Claude Code', () => {
  it('reads user, project and .mcp.json servers with their transports', () => {
    const servers = scan({
      [`${HOME}/.claude.json`]: JSON.stringify({
        mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' } },
        projects: {
          '/repo': {
            mcpServers: { playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] } },
            disabledMcpjsonServers: ['linear'],
          },
        },
      }),
      '/repo/.mcp.json': JSON.stringify({ mcpServers: { linear: { url: 'https://mcp.linear.app/sse' } } }),
    }, { workingDir: '/repo' })

    expect(servers.map(s => [s.agent, s.name, s.transport, s.scope, s.enabled])).toEqual([
      ['claude-code', 'figma', 'remote', 'user', true],
      ['claude-code', 'linear', 'remote', 'project', false],
      ['claude-code', 'playwright', 'stdio', 'project', true],
    ])
    expect(servers[2].args).toEqual(['@playwright/mcp@latest'])
    expect(servers[1].source).toBe('/repo/.mcp.json')
  })

  it('honours CLAUDE_CONFIG_DIR and skips project scope without a working dir', () => {
    const files = {
      '/home/u/alt/.claude.json': JSON.stringify({ mcpServers: { a: { command: 'a' } } }),
      [`${HOME}/.claude.json`]: JSON.stringify({ mcpServers: { ignored: { command: 'x' } } }),
    }
    const servers = scan(files, { agentEnv: { 'claude-code': { CLAUDE_CONFIG_DIR: '~/alt' } } })
    expect(servers.map(s => s.name)).toEqual(['a'])
  })

  it('yields nothing for a malformed config instead of throwing', () => {
    expect(scan({ [`${HOME}/.claude.json`]: '{ not json' })).toEqual([])
  })
})

describe('scanAgentMcpServers — Codex', () => {
  it('parses mcp_servers tables and skips their env sub-tables', () => {
    const servers = scan({
      [`${HOME}/.codex/config.toml`]: [
        'model = "gpt-5"',
        '',
        '[mcp_servers.node_repl]',
        'command = "/bin/node_repl"',
        'args = []',
        'startup_timeout_sec = 120',
        '',
        '[mcp_servers.node_repl.env]',
        'command = "not-a-server-field"',
        '',
        '[mcp_servers."computer-use"]',
        'command = "./client"  # inline comment',
        'args = ["mcp", "--flag"]',
        'enabled = false',
        '',
        '[desktop]',
        'command = "unrelated"',
      ].join('\n'),
    })

    expect(servers.map(s => [s.agent, s.name, s.command, s.enabled])).toEqual([
      ['codex', 'computer-use', './client', false],
      ['codex', 'node_repl', '/bin/node_repl', true],
    ])
    expect(servers[0].args).toEqual(['mcp', '--flag'])
    expect(servers[1].args).toEqual([])
  })

  it('treats a url entry as a remote server and honours CODEX_HOME', () => {
    const servers = scan(
      { '/home/u/cx/config.toml': '[mcp_servers.linear]\nurl = "https://mcp.linear.app/sse"\n' },
      { agentEnv: { codex: { CODEX_HOME: '/home/u/cx' } } },
    )
    expect(servers).toHaveLength(1)
    expect(servers[0]).toMatchObject({ agent: 'codex', transport: 'remote', url: 'https://mcp.linear.app/sse' })
  })
})

describe('parseCodexMcpServers', () => {
  it('ignores comments, blank lines and unparseable values', () => {
    const parsed = parseCodexMcpServers([
      '# leading comment',
      '[mcp_servers.a]',
      'command = "x"',
      'timeout = 30',
      'nested = { k = 1 }',
      'no-equals-here',
    ].join('\n'))
    expect(parsed).toEqual({ a: { command: 'x' } })
  })
})

describe('scanAgentMcpServers — OpenCode', () => {
  it('splits command arrays and prefers .json over .jsonc', () => {
    const servers = scan({
      [`${HOME}/.config/opencode/opencode.json`]: JSON.stringify({
        mcp: {
          local: { type: 'local', command: ['npx', '-y', 'srv'], enabled: false },
          remote: { type: 'remote', url: 'https://example.com/mcp' },
        },
      }),
      [`${HOME}/.config/opencode/opencode.jsonc`]: JSON.stringify({ mcp: { skipped: { type: 'local', command: ['x'] } } }),
    })
    expect(servers.map(s => [s.name, s.transport, s.command, s.enabled])).toEqual([
      ['local', 'stdio', 'npx', false],
      ['remote', 'remote', undefined, true],
    ])
    expect(servers[0].args).toEqual(['-y', 'srv'])
  })

  it('falls through to .jsonc and reads project config', () => {
    const servers = scan({
      [`${HOME}/.config/opencode/opencode.jsonc`]: '{ // user config\n "mcp": { "u": { "type": "local", "command": ["u"] } } }',
      '/repo/opencode.json': JSON.stringify({ mcp: { p: { type: 'local', command: ['p'] } } }),
    }, { workingDir: '/repo' })
    expect(servers.map(s => [s.name, s.scope])).toEqual([['p', 'project'], ['u', 'user']])
  })

  it('honours XDG_CONFIG_HOME', () => {
    const servers = scan(
      { '/home/u/xdg/opencode/opencode.json': JSON.stringify({ mcp: { x: { type: 'local', command: ['x'] } } }) },
      { agentEnv: { opencode: { XDG_CONFIG_HOME: '/home/u/xdg' } } },
    )
    expect(servers.map(s => s.name)).toEqual(['x'])
  })
})

describe('stripJsonComments', () => {
  it('leaves comment-like text inside strings alone', () => {
    expect(JSON.parse(stripJsonComments('{"url": "https://a/b" /* c */, "p": "a//b" // t\n}')))
      .toEqual({ url: 'https://a/b', p: 'a//b' })
  })

  it('keeps escaped quotes from ending a string', () => {
    expect(JSON.parse(stripJsonComments('{"a": "x\\"//y"}'))).toEqual({ a: 'x"//y' })
  })
})

describe('scanAgentMcpServers', () => {
  it('returns nothing when no agent config exists', () => {
    expect(scan({}, { workingDir: '/repo' })).toEqual([])
  })
})
