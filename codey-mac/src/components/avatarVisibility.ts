// One observer/listener for all avatars, without scroll handlers or React updates.
const avatars = new Map<Element, boolean>()
let observer: IntersectionObserver | undefined

function update(element: Element, intersects: boolean) {
  element.setAttribute('data-motion-visible', String(intersects && !document.hidden))
}
function onVisibilityChange() {
  avatars.forEach((intersects, element) => update(element, intersects))
}

export function observeAvatarVisibility(element: Element): () => void {
  update(element, false)
  // Keep the face static in environments without visibility observation.
  if (typeof IntersectionObserver === 'undefined') return () => {}
  if (!observer) {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!avatars.has(entry.target)) continue
        const visible = entry.isIntersecting && entry.intersectionRatio > 0
        avatars.set(entry.target, visible)
        update(entry.target, visible)
      }
    }, { threshold: [0, 0.001] })
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  avatars.set(element, false)
  observer.observe(element)
  return () => {
    observer?.unobserve(element)
    avatars.delete(element)
    update(element, false)
    if (!avatars.size) {
      observer?.disconnect()
      observer = undefined
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }
}
