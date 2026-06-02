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
    // Discover a truly-free port via OS assignment (bind 0, read it back, close)
    // rather than guessing a hardcoded number that another process might hold.
    const assigned = await new Promise<number>((res, rej) => {
      const s = createServer()
      s.once('error', rej)
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as { port: number }).port
        s.close(() => res(port))
      })
    })
    expect(await isPortAvailable(assigned)).toBe(true)
  })

  it('returns false for an occupied port', async () => {
    await occupy(3987)
    expect(await isPortAvailable(3987)).toBe(false)
  })
})

describe('findAvailablePort', () => {
  it('returns the preferred port when it is free', async () => {
    const assigned = await new Promise<number>((res, rej) => {
      const s = createServer()
      s.once('error', rej)
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as { port: number }).port
        s.close(() => res(port))
      })
    })
    expect(await findAvailablePort(assigned, assigned)).toBe(assigned)
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
