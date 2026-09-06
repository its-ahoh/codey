import React, { useEffect, useState } from 'react'
import { C } from '../theme'
import { UIIcon } from './UIIcons'
import { extractPreviewUrls } from './linkPreviewUrls'
import type { LinkPreview } from '../codey-api'

/** Small cards under a reply for the pages it links to: thumbnail, title and
 *  blurb, opening in the user's default browser on click. Metadata comes from
 *  main (`window.codey.linkPreview`), which caches per URL, so re-rendering a
 *  long chat does not refetch. A URL whose page yields nothing usable is
 *  simply dropped — a card with only a hostname on it is noise. */

const usePreviews = (urls: string[]): LinkPreview[] => {
  const [previews, setPreviews] = useState<LinkPreview[]>([])
  const key = urls.join('\n')

  useEffect(() => {
    if (!key) { setPreviews([]); return }
    let live = true
    void (async () => {
      const fetched = await Promise.all(
        key.split('\n').map(async url => {
          try { return await window.codey?.linkPreview?.(url) ?? null } catch { return null }
        }),
      )
      if (!live) return
      setPreviews(fetched.filter((p): p is LinkPreview => !!p && !!p.title))
    })()
    return () => { live = false }
  }, [key])

  return previews
}

const Thumb: React.FC<{ preview: LinkPreview }> = ({ preview }) => {
  const [broken, setBroken] = useState(false)
  if (!preview.image || broken) {
    return <div style={styles.thumbFallback}><UIIcon name="globe" size={16} /></div>
  }
  return (
    <img
      src={preview.image}
      alt=""
      style={styles.thumb}
      onError={() => setBroken(true)}
    />
  )
}

export const LinkPreviewCards: React.FC<{ text: string }> = ({ text }) => {
  const previews = usePreviews(extractPreviewUrls(text))
  if (previews.length === 0) return null
  return (
    <div style={styles.list}>
      {previews.map(preview => (
        <button
          key={preview.url}
          type="button"
          style={styles.card}
          title={`Open ${preview.url} in your browser`}
          onClick={() => void window.codey?.openExternal?.(preview.url)}
        >
          <Thumb preview={preview} />
          <span style={styles.body}>
            <span style={styles.title}>{preview.title}</span>
            {preview.description && <span style={styles.desc}>{preview.description}</span>}
            <span style={styles.site}>
              <UIIcon name="globe" size={11} />
              <span style={styles.siteText}>{preview.siteName || preview.url}</span>
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  list: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 },
  card: {
    display: 'flex', alignItems: 'stretch', gap: 10, textAlign: 'left',
    padding: 8, borderRadius: 10, cursor: 'pointer', maxWidth: 420,
    background: C.surface2, border: `1px solid ${C.border2}`, color: C.fg,
    font: 'inherit',
  },
  thumb: {
    width: 56, height: 56, flexShrink: 0, borderRadius: 7,
    objectFit: 'cover', background: C.surface3,
  },
  thumbFallback: {
    width: 56, height: 56, flexShrink: 0, borderRadius: 7,
    background: C.surface3, color: C.fg3,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  body: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, justifyContent: 'center' },
  title: {
    fontSize: 12.5, fontWeight: 600, color: C.fg, lineHeight: 1.3,
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  desc: {
    fontSize: 11.5, color: C.fg2, lineHeight: 1.35,
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  site: { display: 'flex', alignItems: 'center', gap: 4, color: C.fg3, fontSize: 11, minWidth: 0 },
  siteText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
}
