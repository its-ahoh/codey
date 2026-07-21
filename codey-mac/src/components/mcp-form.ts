/** "KEY=VALUE" lines → env record. Blank lines are skipped; bad lines throw. */
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq <= 0) throw new Error(`Env lines must look like KEY=VALUE (got "${line}")`)
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return env
}

/** Space-separated args line → argv array. */
export function parseArgsLine(text: string): string[] {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/) : []
}
