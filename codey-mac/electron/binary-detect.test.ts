import { describe, expect, it } from 'vitest'
import { isBinaryBuffer } from './binary-detect'

describe('isBinaryBuffer', () => {
  it('treats plain ASCII as text', () => {
    expect(isBinaryBuffer(Buffer.from('const a = 1\n'))).toBe(false)
  })

  it('treats UTF-8 with multibyte characters as text', () => {
    expect(isBinaryBuffer(Buffer.from('naïve — café ✓\n', 'utf-8'))).toBe(false)
  })

  it('treats an empty file as text', () => {
    expect(isBinaryBuffer(Buffer.alloc(0))).toBe(false)
  })

  it('flags a NUL byte in the head as binary', () => {
    expect(isBinaryBuffer(Buffer.from('Bud1\0\0\0\0setsph1S'))).toBe(true)
  })

  it('flags invalid UTF-8 as binary', () => {
    expect(isBinaryBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]))).toBe(true)
  })

  it('flags a NUL past the sniff window only if decode fails', () => {
    const buf = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])])
    // NUL is valid UTF-8, so a text file with a stray NUL far in still shows.
    expect(isBinaryBuffer(buf)).toBe(false)
  })
})
