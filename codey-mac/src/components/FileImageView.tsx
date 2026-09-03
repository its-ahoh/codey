import React from 'react'
import { C } from '../theme'

export const FileImageView: React.FC<{
  dataUrl: string | null | undefined
  filePath: string
}> = ({ dataUrl, filePath }) => {
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => setFailed(false), [dataUrl, filePath])

  if (dataUrl === undefined) return <div style={styles.note}>Loading image…</div>
  if (dataUrl === null || failed) {
    return <div style={styles.note}>Can’t preview this image — it may be missing, unsupported, or over 25 MB.</div>
  }

  const name = filePath.split(/[\\/]/).pop() || filePath
  return (
    <div style={styles.wrap}>
      <img src={dataUrl} alt={name} style={styles.image} onError={() => setFailed(true)} />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: 180, maxHeight: '70vh', overflow: 'auto',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: `1px solid ${C.border2}`, borderRadius: 6,
    backgroundColor: C.surface,
    backgroundImage: 'linear-gradient(45deg, rgba(127,127,127,.08) 25%, transparent 25%), linear-gradient(-45deg, rgba(127,127,127,.08) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(127,127,127,.08) 75%), linear-gradient(-45deg, transparent 75%, rgba(127,127,127,.08) 75%)',
    backgroundSize: '20px 20px',
    backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
  },
  image: { display: 'block', maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' },
  note: { color: C.fg3, fontSize: 11, fontStyle: 'italic', padding: '12px 10px' },
}
