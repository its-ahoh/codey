import { useEffect, useState, type RefObject } from 'react'

/** Dialogs that sit on top of the whole app mark themselves with aria-modal. */
export const APP_MODAL_SELECTOR = '[aria-modal="true"]'

interface ModalQueryRoot {
  querySelectorAll(selector: string): ArrayLike<unknown>
}

/**
 * True when some app-wide modal is open that is not inside `own`. The embedded
 * browser is a native view drawn above all HTML, so it has to step aside for
 * these or it covers them.
 */
export function hasAppModalOpen(doc: ModalQueryRoot, own: { contains(node: unknown): boolean } | null): boolean {
  return Array.from(doc.querySelectorAll(APP_MODAL_SELECTOR)).some(node => !own?.contains(node))
}

/** Tracks whether an app-wide modal outside `ownRef` is currently open. */
export function useAppModalOpen(ownRef: RefObject<HTMLElement | null>): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const update = () => setOpen(hasAppModalOpen(document, ownRef.current))
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] })
    update()
    return () => observer.disconnect()
  }, [ownRef])
  return open
}
