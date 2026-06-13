import { createServer } from 'net'

function canBind(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    // Any bind error means "not available". EADDRINUSE is the common case;
    // a privileged-port EACCES would also land here and be skipped, which is
    // fine for the 3000–4000 range we search.
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    if (host) server.listen(port, host)
    else server.listen(port)
  })
}

/**
 * Resolves true if `port` can be bound right now. Probes by actually
 * listening (then immediately closing) so we catch the same EADDRINUSE the
 * real server would hit.
 *
 * Probes the wildcard address (what ApiServer's host-less `listen(port)`
 * binds) AND loopback: with SO_REUSEADDR (Node's default), a 127.0.0.1 bind
 * can succeed while another process holds wildcard `::` on the same port —
 * which is exactly how a stale dev instance slipped past a loopback-only
 * probe and crashed the new one with EADDRINUSE.
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return (await canBind(port)) && (await canBind(port, '127.0.0.1'))
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
