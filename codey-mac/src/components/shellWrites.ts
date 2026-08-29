/**
 * Finds the files a shell command writes to.
 *
 * The Files panel is built from Edit/Write/apply_patch tool calls, so a file the
 * agent rewrote with `sed -i`, a heredoc, or a redirect used to leave no trace
 * there at all — the panel read "No file activity" while the working tree had
 * changed. This recovers those paths from the command text so they can be listed
 * (no diff is available for them — only the fact that they were touched).
 *
 * Heuristics, not a shell parser: it errs toward missing an exotic write rather
 * than inventing a path that was never touched.
 */

/** Verbs whose non-flag arguments are all write targets. */
const ALL_ARGS_WRITE = new Set(['rm', 'touch', 'tee', 'unlink', 'rmdir'])
/** Verbs whose *last* non-flag argument is the write target. */
const LAST_ARG_WRITE = new Set(['cp', 'mv', 'install', 'ln'])

/** Command text as the adapters report it: a string, or codex's argv array. */
export const shellCommandText = (input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>
  const raw = i.command ?? i.cmd ?? i.script
  if (Array.isArray(raw)) return raw.map(v => String(v)).join(' ')
  return typeof raw === 'string' ? raw : ''
}

/**
 * Drops heredoc bodies. `cat > f <<'EOF' … EOF` bodies are data, not shell, and
 * routinely contain `>` and quotes that would derail everything downstream.
 */
const stripHeredocs = (command: string): string => {
  const lines = command.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    out.push(line)
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (!m) continue
    const delim = m[2]
    // Skip forward to the terminator line (or to the end, if unterminated).
    while (i + 1 < lines.length && lines[i + 1].trim() !== delim) i++
    i++ // consume the terminator itself
  }
  return out.join('\n')
}

/** Splits on command separators that live outside quotes. */
const splitSegments = (command: string): string[] => {
  const segments: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      current += ch
      if (ch === quote && command[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue }
    if (ch === '\n' || ch === ';') { segments.push(current); current = ''; continue }
    if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
      segments.push(current); current = ''; i++; continue
    }
    if (ch === '|') { segments.push(current); current = ''; continue }
    current += ch
  }
  segments.push(current)
  return segments.map(s => s.trim()).filter(Boolean)
}

type Token = { text: string; quoted: boolean }

/** Splits a segment into tokens, keeping `>`/`>>` as their own tokens. */
const tokenize = (segment: string): Token[] => {
  const tokens: Token[] = []
  let current = ''
  let quoted = false
  let quote: string | null = null
  const flush = () => {
    if (current || quoted) tokens.push({ text: current, quoted })
    current = ''
    quoted = false
  }
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (quote) {
      if (ch === quote && segment[i - 1] !== '\\') quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; quoted = true; continue }
    if (ch === ' ' || ch === '\t') { flush(); continue }
    if (ch === '>') {
      // `2>` / `&>` keep their prefix so the redirect check can see it.
      const prefix = current
      current = ''
      let op = '>'
      if (segment[i + 1] === '>') { op = '>>'; i++ }
      if (prefix && !/^[0-9&]+$/.test(prefix)) tokens.push({ text: prefix, quoted: false })
      tokens.push({ text: `${/^[0-9&]+$/.test(prefix) ? prefix : ''}${op}`, quoted: false })
      continue
    }
    if (ch === '<') { flush(); continue } // input redirect — never a write
    current += ch
  }
  flush()
  return tokens
}

const isFlag = (t: Token): boolean => !t.quoted && t.text.startsWith('-') && t.text !== '-'

/** Paths we never want to surface as "changed". */
const isNoise = (path: string): boolean =>
  !path
  || path === '-'
  || path.startsWith('/dev/')
  || path.startsWith('&')
  // Unexpanded variables/globs/substitutions resolve to something we can't name.
  || /[$*?`]/.test(path)

const basename = (cmd: string): string => {
  const name = cmd.split('/').pop() ?? cmd
  return name.toLowerCase()
}

/** Files `sed -i` rewrites in place: everything after the script argument. */
const sedTargets = (tokens: Token[]): string[] => {
  const flags = tokens.slice(1).filter(isFlag)
  if (!flags.some(f => f.text === '-i' || f.text.startsWith('-i'))) return []
  // `sed -i '' 's/a/b/' f` (BSD) leaves an empty suffix token — drop it, then the
  // first survivor is the script and the rest are files.
  const rest = tokens.slice(1).filter(t => !isFlag(t) && t.text !== '')
  return rest.slice(1).map(t => t.text)
}

/**
 * Absolute or workspace-relative paths the command writes to, in first-seen
 * order. Returns paths exactly as written — resolve them against the working
 * directory at the call site.
 */
export const parseShellWriteTargets = (command: string): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (raw: string) => {
    const path = raw.trim().replace(/^['"]|['"]$/g, '')
    if (isNoise(path) || seen.has(path)) return
    seen.add(path)
    out.push(path)
  }

  for (const segment of splitSegments(stripHeredocs(command))) {
    const tokens = tokenize(segment)
    if (tokens.length === 0) continue

    // Redirects, wherever they appear in the segment.
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.quoted) continue
      if (!/^[0-9&]*>>?$/.test(t.text)) continue
      const target = tokens[i + 1]
      if (target) add(target.text)
    }

    const words = tokens.filter(t => t.quoted || !/^[0-9&]*>>?$/.test(t.text))
    if (words.length === 0) continue
    // Step past `sudo`/`env` and `FOO=bar` prefixes to the real verb.
    let head = 0
    while (head < words.length
      && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[head].text)
        || ['sudo', 'env', 'command', 'nohup'].includes(basename(words[head].text)))) head++
    const verbTokens = words.slice(head)
    if (verbTokens.length === 0) continue
    const verb = basename(verbTokens[0].text)
    const args = verbTokens.slice(1).filter(t => !isFlag(t) && t.text !== '')

    if (verb === 'sed') { sedTargets(verbTokens).forEach(add); continue }
    // `-i` may be bundled into a combined short flag, as in `perl -pi -e`.
    if (verb === 'perl' && verbTokens.slice(1).some(t => isFlag(t) && /^-[a-zA-Z]*i/.test(t.text))) {
      // `perl -pi -e '…' file` — the -e script is a flag value, not a path.
      const eIdx = verbTokens.findIndex(t => t.text === '-e')
      const files = eIdx >= 0 ? verbTokens.slice(eIdx + 2) : verbTokens.slice(1)
      files.filter(t => !isFlag(t)).forEach(t => add(t.text))
      continue
    }
    if (ALL_ARGS_WRITE.has(verb)) { args.forEach(t => add(t.text)); continue }
    if (LAST_ARG_WRITE.has(verb) && args.length >= 2) { add(args[args.length - 1].text); continue }
  }

  return out
}
