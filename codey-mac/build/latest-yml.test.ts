import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

// CJS module shared with the notarize-dist.js build script.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { updateLatestYmlText, regenerateLatestYml } = require('./latest-yml.js')

const STALE_YML = `version: 0.10.0
files:
  - url: Codey-0.10.0-arm64-mac.zip
    sha512: staleZipHash==
    size: 111
  - url: Codey-0.10.0-arm64.dmg
    sha512: staleDmgHash==
    size: 222
path: Codey-0.10.0-arm64-mac.zip
sha512: staleZipHash==
releaseDate: '2026-07-21T01:13:39.350Z'
`

function sha512b64(content: string): string {
  return createHash('sha512').update(content).digest('base64')
}

describe('updateLatestYmlText', () => {
  it('rewrites sha512 and size for listed files and the top-level sha512', () => {
    const updated = updateLatestYmlText(STALE_YML, {
      'Codey-0.10.0-arm64-mac.zip': { sha512: 'newZipHash==', size: 133058412 },
      'Codey-0.10.0-arm64.dmg': { sha512: 'newDmgHash==', size: 132416511 },
    })
    expect(updated).toBe(`version: 0.10.0
files:
  - url: Codey-0.10.0-arm64-mac.zip
    sha512: newZipHash==
    size: 133058412
  - url: Codey-0.10.0-arm64.dmg
    sha512: newDmgHash==
    size: 132416511
path: Codey-0.10.0-arm64-mac.zip
sha512: newZipHash==
releaseDate: '2026-07-21T01:13:39.350Z'
`)
  })

  it('leaves entries alone when no stats are provided for that file', () => {
    const updated = updateLatestYmlText(STALE_YML, {
      'Codey-0.10.0-arm64-mac.zip': { sha512: 'newZipHash==', size: 133058412 },
    })
    expect(updated).toContain('sha512: staleDmgHash==')
    expect(updated).toContain('size: 222')
    // top-level path entry points at the zip, so its hash still updates
    expect(updated).toContain('path: Codey-0.10.0-arm64-mac.zip\nsha512: newZipHash==')
  })

  it('is a no-op when no stats are given', () => {
    expect(updateLatestYmlText(STALE_YML, {})).toBe(STALE_YML)
  })
})

describe('regenerateLatestYml', () => {
  it('recomputes hashes and sizes from the artifacts on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latest-yml-test-'))
    try {
      const zipContent = 'stapled zip bytes'
      const dmgContent = 'stapled dmg bytes'
      fs.writeFileSync(path.join(dir, 'Codey-0.10.0-arm64-mac.zip'), zipContent)
      fs.writeFileSync(path.join(dir, 'Codey-0.10.0-arm64.dmg'), dmgContent)
      fs.writeFileSync(path.join(dir, 'latest-mac.yml'), STALE_YML)

      const changed = regenerateLatestYml(dir, 'latest-mac.yml')
      expect(changed).toEqual([
        'Codey-0.10.0-arm64-mac.zip',
        'Codey-0.10.0-arm64.dmg',
      ])

      const updated = fs.readFileSync(path.join(dir, 'latest-mac.yml'), 'utf8')
      expect(updated).toContain(`sha512: ${sha512b64(zipContent)}`)
      expect(updated).toContain(`sha512: ${sha512b64(dmgContent)}`)
      expect(updated).toContain(`size: ${Buffer.byteLength(zipContent)}`)
      expect(updated).toContain(`size: ${Buffer.byteLength(dmgContent)}`)
      expect(updated).not.toContain('staleZipHash==')
      expect(updated).not.toContain('staleDmgHash==')
      expect(updated).toContain(`path: Codey-0.10.0-arm64-mac.zip\nsha512: ${sha512b64(zipContent)}`)
      expect(updated).toContain("releaseDate: '2026-07-21T01:13:39.350Z'")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips files listed in the yml that are missing on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latest-yml-test-'))
    try {
      const zipContent = 'only the zip exists'
      fs.writeFileSync(path.join(dir, 'Codey-0.10.0-arm64-mac.zip'), zipContent)
      fs.writeFileSync(path.join(dir, 'latest-mac.yml'), STALE_YML)

      const changed = regenerateLatestYml(dir, 'latest-mac.yml')
      expect(changed).toEqual(['Codey-0.10.0-arm64-mac.zip'])

      const updated = fs.readFileSync(path.join(dir, 'latest-mac.yml'), 'utf8')
      expect(updated).toContain(`sha512: ${sha512b64(zipContent)}`)
      expect(updated).toContain('sha512: staleDmgHash==')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns an empty list when there is no yml file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latest-yml-test-'))
    try {
      expect(regenerateLatestYml(dir, 'latest-mac.yml')).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
