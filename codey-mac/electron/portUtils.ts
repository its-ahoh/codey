import { createServer } from 'net'

/**
 * Resolves true if `port` can be bound on localhost right now. Probes by
 * actually listening (then immediately closing) so we catch the same
 * EADDRINUSE the real server would hit.
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    // Any bind error means "not available". EADDRINUSE is the common case;
    // a privileged-port EACCES would also land here and be skipped, which is
    // fine for the 3000–4000 range we search.
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Returns the first available port at or after `preferred`, up to and
 * including `max`. Throws if every port in the range is occupied.
 */
export async function findAvailablePort(preferred: number, max = 4000): Promise<number> {
  for (let port = preferred; port <= max; port++) {
    if (await isPortAvailable(port)) return port
  }
  throw new Error(`No available port between ${preferred} and ${max}`)
}
