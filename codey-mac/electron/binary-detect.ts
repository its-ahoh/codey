// Decide whether a file's bytes are text we can show, or binary we must not
// render as garbage. Mirrors git's heuristic: a NUL byte in the first 8 KB
// means binary. Bytes that are not valid UTF-8 are treated as binary too, so
// a .DS_Store, .png, or compiled artifact never lands in the code viewer.
const SNIFF_BYTES = 8000

export const isBinaryBuffer = (buf: Uint8Array): boolean => {
  const head = buf.subarray(0, SNIFF_BYTES)
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0) return true
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return false
  } catch {
    return true
  }
}
