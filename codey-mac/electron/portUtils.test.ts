import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'net'
import { isPortAvailable, findAvailablePort } from './portUtils'

const servers: Server[] = []

function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(port, '127.0.0.1', () => {
      servers.push(s)
      resolve()
    })
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
})

describe('isPortAvailable', () => {
  it('returns true for a free port', async () => {
    expect(await isPortAvailable(3999)).toBe(true)
  })

  it('returns false for an occupied port', async () => {
    await occupy(3987)
    expect(await isPortAvailable(3987)).toBe(false)
  })
})

describe('findAvailablePort', () => {
  it('returns the preferred port when it is free', async () => {
    expect(await findAvailablePort(3995, 4000)).toBe(3995)
  })

  it('skips an occupied port and returns the next free one', async () => {
    await occupy(3990)
    const port = await findAvailablePort(3990, 4000)
    expect(port).toBeGreaterThan(3990)
    expect(port).toBeLessThanOrEqual(4000)
  })

  it('throws when no port is available in range', async () => {
    await occupy(3992)
    await expect(findAvailablePort(3992, 3992)).rejects.toThrow(/No available port/)
  })
})
