import { describe, expect, it } from 'vitest'
import { validateExternalMcp } from './external-mcp'

describe('validateExternalMcp', () => {
  it('accepts a valid stdio server and coerces enabled', () => {
    const result = validateExternalMcp({
      name: ' github ',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      env: { TOKEN: 't' },
      enabled: 'yes' as any,
    })
    expect(result).toEqual({
      ok: true,
      name: 'github',
      config: { transport: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 't' }, enabled: false },
    })
  })

  it('accepts a valid remote server', () => {
    const result = validateExternalMcp({ name: 'linear', transport: 'remote', url: 'https://mcp.linear.app/sse', enabled: true })
    expect(result).toEqual({
      ok: true,
      name: 'linear',
      config: { transport: 'remote', url: 'https://mcp.linear.app/sse', enabled: true },
    })
  })

  it('rejects bad names, reserved names, and missing fields', () => {
    expect(validateExternalMcp({ name: '', transport: 'stdio', command: 'x' }).ok).toBe(false)
    expect(validateExternalMcp({ name: 'has space', transport: 'stdio', command: 'x' }).ok).toBe(false)
    expect(validateExternalMcp({ name: '-lead', transport: 'stdio', command: 'x' }).ok).toBe(false)
    expect(validateExternalMcp({ name: 'codey-browser', transport: 'stdio', command: 'x' }).ok).toBe(false)
    expect(validateExternalMcp({ name: 'a', transport: 'stdio', command: '  ' }).ok).toBe(false)
    expect(validateExternalMcp({ name: 'a', transport: 'remote', url: 'ftp://x' }).ok).toBe(false)
    expect(validateExternalMcp({ name: 'a', transport: 'remote', url: '' }).ok).toBe(false)
    expect(validateExternalMcp({ name: 'a', transport: 'weird' as any }).ok).toBe(false)
  })
})
