const messageNode = document.querySelector('#message')
const allowNode = document.querySelector('#allow')
let requesting = false
let blocked = false

function errorMessage(error) {
  const name = error?.name || ''
  if (name === 'NotAllowedError') {
    return 'Microphone access is blocked. Use Chrome’s permission prompt or microphone settings, then click again.'
  }
  if (name === 'NotFoundError') return 'Chrome could not find a microphone.'
  return error?.message || 'Chrome could not enable the microphone.'
}

async function requestMicrophone() {
  if (blocked) {
    try { await chrome.tabs.create({ url: 'chrome://settings/content/microphone' }) } catch { /* guidance remains visible */ }
    return
  }
  if (requesting) return
  requesting = true
  allowNode.disabled = true
  messageNode.textContent = 'Waiting for Chrome microphone permission…'
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach(track => track.stop())
    await chrome.runtime.sendMessage({ type: 'codey:microphone-granted' }).catch(() => undefined)
    const currentTab = await chrome.tabs.getCurrent().catch(() => null)
    if (typeof currentTab?.id === 'number') await chrome.tabs.remove(currentTab.id)
    else window.close()
  } catch (error) {
    messageNode.textContent = errorMessage(error)
    try {
      const permission = await navigator.permissions.query({ name: 'microphone' })
      blocked = permission.state === 'denied'
    } catch { blocked = false }
    allowNode.textContent = blocked ? 'Open Chrome settings' : 'Try again'
    allowNode.disabled = false
    requesting = false
  }
}

allowNode.addEventListener('click', () => { void requestMicrophone() })
// The window itself was opened by the user's microphone-button click. Try
// immediately; the visible button remains as a gesture-backed retry if Chrome
// declines to show the prompt on navigation.
void requestMicrophone()
