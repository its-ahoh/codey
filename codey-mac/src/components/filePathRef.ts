// Decide whether an inline-code span in a message is a file path worth
// turning into a clickable link.
//
// This is deliberately a *candidate* filter, not a verdict: agents write
// plenty of backticked things that look path-ish (`npm run build`, `a/b`
// branch names, `text/plain`). Being liberal here is safe because the
// renderer only styles a candidate as a link after the main process confirms
// the path actually exists on disk — so a false positive costs one `stat`,
// never a dead link.

export interface FileRef {
  /** The path as written, minus any trailing `:line[:col]` and punctuation. */
  path: string
  /** 1-based line number when the reference carried one. */
  line?: number
}

/** `https://`, `file://`, `mailto:` … — links, not paths. */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:(\/\/|\S*@)/

/** Characters that never appear in a path we would open. */
const ILLEGAL_RE = /[\s*?<>|"'`$\\]/

/** A file extension: `.ts`, `.tsx`, `.json`, `.md` … */
const EXT_RE = /\.[A-Za-z0-9_]{1,10}$/

/** Sentence punctuation that got swept into the span. */
const TRAILING_RE = /[.,;:!?)\]}]+$/
const LEADING_RE = /^[(\[{]+/

/** Longest path we bother considering; anything longer is prose. */
const MAX_LEN = 400

/**
 * Parse one inline-code span into a file reference, or null when it does not
 * look like a path at all.
 */
export function parseFileRef(raw: string): FileRef | null {
  const text = raw.trim()
  if (!text || text.length > MAX_LEN) return null
  if (SCHEME_RE.test(text)) return null
  if (ILLEGAL_RE.test(text)) return null

  // `src/app.ts:42` and `src/app.ts:42:7` both point at line 42.
  const lineMatch = /^(.*?):(\d+)(?::\d+)?$/.exec(text)
  let path = lineMatch ? lineMatch[1] : text
  const line = lineMatch ? Number(lineMatch[2]) : undefined

  // Drop a trailing "." or ")" only when it is not part of the name — a bare
  // dotfile like ".env" and a directory like "dist/" must survive.
  path = path.replace(LEADING_RE, '')
  if (!EXT_RE.test(path)) path = path.replace(TRAILING_RE, '')
  path = path.replace(/\/+$/, '') || '/'
  if (!path || path.length > MAX_LEN) return null

  const looksAnchored = /^(\/|~\/|\.{1,2}\/)/.test(path)
  const hasSeparator = path.includes('/')
  const hasExtension = EXT_RE.test(path) || /^\.[A-Za-z0-9_.-]+$/.test(path)
  if (!looksAnchored && !hasSeparator && !hasExtension) return null

  return line !== undefined ? { path, line } : { path }
}

/**
 * Formats that are not text: a code editor either refuses them or shows bytes,
 * so these go to the macOS default app instead (Preview for a PDF or an image,
 * QuickTime for a clip, Numbers for a spreadsheet…). Anything not listed —
 * including unknown extensions — is assumed to be text and opens in the
 * editor, which is the safe default for source files.
 */
const SYSTEM_APP_EXTENSIONS = new Set([
  'pdf', 'epub',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pages', 'numbers', 'key', 'rtf',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'tiff', 'tif', 'bmp', 'ico', 'avif',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'rar', '7z', 'dmg', 'pkg', 'app',
  'psd', 'ai', 'sketch', 'fig', 'xcf',
  'ttf', 'otf', 'woff', 'woff2',
])

/** True when the path should be handed to the OS rather than to an editor. */
export function opensInSystemApp(path: string): boolean {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase()
  return !!ext && SYSTEM_APP_EXTENSIONS.has(ext)
}
