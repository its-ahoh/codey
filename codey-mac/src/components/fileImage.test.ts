import { describe, expect, it } from 'vitest'
import { imageMimeForPath, isImageFilePath } from './fileImage'

describe('workspace image files', () => {
  it('recognises supported image extensions without caring about case', () => {
    expect(imageMimeForPath('/work/assets/Hero.PNG')).toBe('image/png')
    expect(imageMimeForPath('/work/photo.jpeg')).toBe('image/jpeg')
    expect(imageMimeForPath('/work/icon.svg')).toBe('image/svg+xml')
    expect(isImageFilePath('animation.GIF')).toBe(true)
  })

  it('does not classify code or extensionless files as images', () => {
    expect(imageMimeForPath('/work/image.ts')).toBeNull()
    expect(imageMimeForPath('/work/.image')).toBeNull()
    expect(isImageFilePath('/work/README')).toBe(false)
  })
})
