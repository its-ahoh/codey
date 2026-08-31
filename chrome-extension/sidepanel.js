const DEFAULT_ENDPOINT = 'http://127.0.0.1:49321'
const STATE_KEY = 'codeySidePanelState'
const AGENT_API_TYPE = { 'claude-code': 'anthropic', opencode: 'all', codex: 'openai', pi: 'all' }
const messagesNode = document.querySelector('#messages')
const welcomeNode = document.querySelector('#welcome')
const formNode = document.querySelector('#composer')
const inputNode = document.querySelector('#message')
const sendNode = document.querySelector('#send')
const includePageNode = document.querySelector('#include-page')
const pageContextNode = document.querySelector('#page-context')
const pageTitleNode = document.querySelector('#page-title')
const handoffNode = document.querySelector('#handoff')
const updateNoticeNode = document.querySelector('#update-notice')
const updateCopyNode = document.querySelector('#update-copy')
const updateOpenNode = document.querySelector('#update-open')
const handoffFormNode = document.querySelector('#handoff-form')
const handoffNameNode = document.querySelector('#handoff-name')
const handoffSaveNode = document.querySelector('#handoff-save')
const handoffCancelNode = document.querySelector('#handoff-cancel')
const chatSelectNode = document.querySelector('#chat-select')
const agentSelectNode = document.querySelector('#agent-select')
const modelSelectNode = document.querySelector('#model-select')
const settingsPopoverNode = document.querySelector('#settings-popover')
const settingsToggleNode = document.querySelector('#settings-toggle')
const modelLabelNode = document.querySelector('#model-label')
const statusNode = document.querySelector('#status')
const statusTextNode = document.querySelector('#status-text')
const attachmentsNode = document.querySelector('#attachments')
const fileInputNode = document.querySelector('#file-input')
const attachNode = document.querySelector('#attach')
const voiceNode = document.querySelector('#voice')
let state = { chatId: null, messages: [], agent: null, model: null, attachments: [] }
let busy = false
let voiceBusy = false
let activePage = null
let options = { agents: [], models: [], defaultAgent: null, defaultModel: null, defaultModels: {} }
let voiceRecording = false

async function connection() {
  let saved = await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, token: '' })
  if (!saved.token) {
    const result = await chrome.runtime.sendMessage({ type: 'codey:connect' })
    if (!result?.ok) throw new Error(result?.error || 'Keep Codey open, then try again')
    saved = await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, token: '' })
  }
  if (!saved.token) throw new Error('Keep Codey open, then try again')
  return saved
}

async function codeyApi(path, requestOptions = {}, retry = true) {
  const { endpoint, token } = await connection()
  const response = await fetch(`${endpoint}${path}`, {
    method: requestOptions.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
    cache: 'no-store',
  })
  const value = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
  if (response.status === 401 && retry) {
    await chrome.storage.local.remove('token')
    return await codeyApi(path, requestOptions, false)
  }
  if (!response.ok || value.ok === false) throw new Error(value.error || `HTTP ${response.status}`)
  return value
}

function setBusy(value) {
  busy = value
  sendNode.disabled = value
  chatSelectNode.disabled = value
  agentSelectNode.disabled = value
  modelSelectNode.disabled = value || modelSelectNode.options.length <= 1
  attachNode.setAttribute('aria-disabled', String(value))
  fileInputNode.disabled = value
  if (voiceNode) voiceNode.disabled = value || voiceBusy
  settingsToggleNode.disabled = value
}

function setVoiceBusy(value) {
  voiceBusy = value
  if (!voiceNode) return
  voiceNode.disabled = busy || value
  voiceNode.classList.toggle('processing', value)
  voiceNode.title = value ? 'Transcribing…' : 'Voice input'
}

function hideSettings() {
  settingsPopoverNode.hidden = true
  settingsToggleNode.setAttribute('aria-expanded', 'false')
}

function toggleSettings() {
  const willOpen = settingsPopoverNode.hidden
  settingsPopoverNode.hidden = !willOpen
  settingsToggleNode.setAttribute('aria-expanded', String(willOpen))
  if (willOpen) agentSelectNode.focus()
}

function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'Not found') return 'Restart Codey to finish updating the Chrome extension.'
  if (/failed to fetch/i.test(message)) return 'Open Codey Mac, then try again.'
  if (/unauthorized/i.test(message)) return 'Codey is reconnecting. Please try again.'
  return message
}

function showStatus(error) {
  statusNode.classList.remove('no-retry')
  statusTextNode.textContent = friendlyError(error)
  statusNode.hidden = false
}

function showVoiceStatus(error) {
  statusNode.classList.add('no-retry')
  statusTextNode.textContent = friendlyError(error)
  statusNode.hidden = false
}

function hideStatus() {
  statusNode.classList.remove('no-retry')
  statusNode.hidden = true
  statusTextNode.textContent = ''
}

function safeLink(value) {
  try {
    const url = new URL(value, 'https://codey.invalid')
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null
    return value
  } catch {
    return null
  }
}

function appendInlineMarkdown(parent, source) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\([^\s)]+(?:\s+"[^"]*")?\)|\*[^*\n]+\*|_[^_\n]+_|\n)/g
  let offset = 0
  for (const match of source.matchAll(pattern)) {
    if (match.index > offset) parent.append(document.createTextNode(source.slice(offset, match.index)))
    const token = match[0]
    let node
    if (token === '\n') {
      node = document.createElement('br')
    } else if (token.startsWith('`')) {
      node = document.createElement('code')
      node.textContent = token.slice(1, -1)
    } else if (token.startsWith('**') || token.startsWith('__')) {
      node = document.createElement('strong')
      appendInlineMarkdown(node, token.slice(2, -2))
    } else if (token.startsWith('~~')) {
      node = document.createElement('del')
      appendInlineMarkdown(node, token.slice(2, -2))
    } else if (token.startsWith('[')) {
      const parts = token.match(/^\[([^\]]+)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)$/)
      const href = parts ? safeLink(parts[2]) : null
      if (parts && href) {
        node = document.createElement('a')
        node.href = href
        node.target = '_blank'
        node.rel = 'noopener noreferrer'
        if (parts[3]) node.title = parts[3]
        node.textContent = parts[1]
      } else {
        node = document.createTextNode(token)
      }
    } else {
      node = document.createElement('em')
      appendInlineMarkdown(node, token.slice(1, -1))
    }
    parent.append(node)
    offset = match.index + token.length
  }
  if (offset < source.length) parent.append(document.createTextNode(source.slice(offset)))
}

function appendMarkdown(parent, source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n')
  let paragraph = []
  let list = null
  let quote = []
  let fence = null

  const flushParagraph = () => {
    if (!paragraph.length) return
    const p = document.createElement('p')
    appendInlineMarkdown(p, paragraph.join('\n'))
    parent.append(p)
    paragraph = []
  }
  const flushList = () => { list = null }
  const flushQuote = () => {
    if (!quote.length) return
    const block = document.createElement('blockquote')
    appendInlineMarkdown(block, quote.join('\n'))
    parent.append(block)
    quote = []
  }
  const flushOpenBlocks = () => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (fence) {
      if (/^\s*```/.test(line)) {
        const pre = document.createElement('pre')
        const code = document.createElement('code')
        if (fence.language) code.dataset.language = fence.language
        code.textContent = fence.lines.join('\n')
        pre.append(code)
        parent.append(pre)
        fence = null
      } else {
        fence.lines.push(line)
      }
      continue
    }

    const fenceStart = line.match(/^\s*```\s*([^\s`]*)?.*$/)
    if (fenceStart) {
      flushOpenBlocks()
      fence = { language: fenceStart[1] || '', lines: [] }
      continue
    }
    if (!line.trim()) {
      flushOpenBlocks()
      continue
    }

    const tableSeparator = lines[index + 1]
    if (line.includes('|') && tableSeparator
        && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(tableSeparator)) {
      flushOpenBlocks()
      const cells = value => value.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
      const headers = cells(line)
      const alignments = cells(tableSeparator).map(cell => (
        cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left'
      ))
      const table = document.createElement('table')
      const head = document.createElement('thead')
      const headRow = document.createElement('tr')
      headers.forEach((header, cellIndex) => {
        const th = document.createElement('th')
        th.style.textAlign = alignments[cellIndex] || 'left'
        appendInlineMarkdown(th, header)
        headRow.append(th)
      })
      head.append(headRow)
      table.append(head)
      const body = document.createElement('tbody')
      index += 2
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const row = document.createElement('tr')
        cells(lines[index]).forEach((cell, cellIndex) => {
          const td = document.createElement('td')
          td.style.textAlign = alignments[cellIndex] || 'left'
          appendInlineMarkdown(td, cell)
          row.append(td)
        })
        body.append(row)
        index += 1
      }
      table.append(body)
      parent.append(table)
      index -= 1
      continue
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/)
    if (heading) {
      flushOpenBlocks()
      const h = document.createElement(`h${heading[1].length}`)
      appendInlineMarkdown(h, heading[2])
      parent.append(h)
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushOpenBlocks()
      parent.append(document.createElement('hr'))
      continue
    }

    const quoted = line.match(/^\s*>\s?(.*)$/)
    if (quoted) {
      flushParagraph()
      flushList()
      quote.push(quoted[1])
      continue
    }
    flushQuote()

    const item = line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/)
    if (item) {
      flushParagraph()
      const ordered = /^\d/.test(item[1])
      if (!list || list.ordered !== ordered) {
        flushList()
        const element = document.createElement(ordered ? 'ol' : 'ul')
        parent.append(element)
        list = { ordered, element }
      }
      const li = document.createElement('li')
      const task = item[2].match(/^\[([ xX])\]\s+(.*)$/)
      if (task) {
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.checked = task[1].toLowerCase() === 'x'
        checkbox.disabled = true
        li.className = 'task-item'
        li.append(checkbox)
        appendInlineMarkdown(li, task[2])
      } else {
        appendInlineMarkdown(li, item[2])
      }
      list.element.append(li)
      continue
    }
    flushList()
    paragraph.push(line)
  }

  if (fence) {
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.textContent = fence.lines.join('\n')
    pre.append(code)
    parent.append(pre)
  }
  flushOpenBlocks()
}

function messageNode(role, text, extraClass = '') {
  const node = document.createElement('div')
  node.className = `message ${role}${extraClass ? ` ${extraClass}` : ''}`
  if (extraClass === 'error') node.textContent = text
  else {
    node.classList.add('markdown')
    appendMarkdown(node, text)
  }
  return node
}

function renderAttachments() {
  attachmentsNode.replaceChildren()
  attachmentsNode.hidden = state.attachments.length === 0
  for (const attachment of state.attachments) {
    const chip = document.createElement('div')
    chip.className = 'attachment'
    chip.title = `${attachment.name} · ${formatBytes(attachment.size)}`
    const name = document.createElement('span')
    name.className = 'attachment-name'
    name.textContent = attachment.name
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '×'
    remove.title = `Remove ${attachment.name}`
    remove.addEventListener('click', () => {
      if (busy) return
      state.attachments = state.attachments.filter(item => item.id !== attachment.id)
      void persist()
      renderAttachments()
    })
    chip.append(name, remove)
    attachmentsNode.appendChild(chip)
  }
}

function render() {
  messagesNode.querySelectorAll('.message').forEach(node => node.remove())
  welcomeNode.hidden = state.messages.length > 0
  for (const item of state.messages) messagesNode.appendChild(messageNode(item.role, item.text, item.error ? 'error' : ''))
  renderAttachments()
  messagesNode.scrollTop = messagesNode.scrollHeight
}

async function persist() {
  await chrome.storage.session.set({
    [STATE_KEY]: {
      chatId: state.chatId,
      messages: state.messages.slice(-30),
      agent: state.agent,
      model: state.model,
      attachments: state.attachments.slice(0, 10),
    },
  })
}

function modelFitsAgent(apiType, agent) {
  const wanted = AGENT_API_TYPE[agent]
  return !wanted || wanted === 'all' || apiType === 'all' || apiType === wanted
}

function populateModels() {
  const effectiveAgent = state.agent || options.defaultAgent
  const inherited = options.defaultModels[effectiveAgent] || options.defaultModel
  modelSelectNode.replaceChildren(new Option(inherited ? `${inherited} (default)` : 'Default model', ''))
  for (const entry of options.models) {
    if (!entry || typeof entry.model !== 'string' || !modelFitsAgent(entry.apiType, effectiveAgent)) continue
    if (entry.model === inherited && state.model !== entry.model) continue
    modelSelectNode.appendChild(new Option(entry.provider ? `${entry.model} · ${entry.provider}` : entry.model, entry.model))
  }
  modelSelectNode.value = state.model || ''
  if (state.model && modelSelectNode.value !== state.model) state.model = null
  const label = state.model || inherited || 'Model'
  modelLabelNode.textContent = label
  settingsToggleNode.title = `Model: ${label} · Click to change Agent or Model`
  modelSelectNode.disabled = busy || modelSelectNode.options.length <= 1
}

async function loadOptions() {
  const suffix = state.chatId ? `?chatId=${encodeURIComponent(state.chatId)}` : ''
  const result = await codeyApi(`/v1/chat/options${suffix}`)
  options = {
    agents: Array.isArray(result.agents) ? result.agents : [],
    models: Array.isArray(result.models) ? result.models : [],
    defaultAgent: result.defaultAgent || null,
    defaultModel: result.defaultModel || null,
    defaultModels: result.defaultModels && typeof result.defaultModels === 'object' ? result.defaultModels : {},
  }
  if (result.chat) {
    state.agent = result.chat.agent || null
    state.model = result.chat.model || null
  }
  agentSelectNode.replaceChildren(new Option(
    options.defaultAgent ? `${options.defaultAgent} (default)` : 'Default agent',
    '',
  ))
  for (const entry of options.agents) {
    if (!entry || typeof entry.id !== 'string') continue
    const option = new Option(entry.id, entry.id)
    option.disabled = entry.installed === false && state.agent !== entry.id
    agentSelectNode.appendChild(option)
  }
  agentSelectNode.value = state.agent || ''
  populateModels()
  await persist()
  hideStatus()
}

async function updateChatSettings() {
  if (!state.chatId) {
    await persist()
    return
  }
  await codeyApi('/v1/chat/settings', {
    method: 'POST',
    body: { chatId: state.chatId, agent: state.agent, model: state.model },
  })
  await persist()
}

async function loadChatList() {
  const result = await codeyApi('/v1/chats')
  const chats = Array.isArray(result.chats) ? result.chats : []
  chatSelectNode.replaceChildren(new Option('New chat', ''))
  for (const chat of chats) {
    if (!chat || typeof chat.id !== 'string') continue
    const title = typeof chat.title === 'string' && chat.title.trim() ? chat.title.trim() : 'Untitled chat'
    chatSelectNode.appendChild(new Option(title, chat.id))
  }
  if (state.chatId && chats.some(chat => chat?.id === state.chatId)) {
    chatSelectNode.value = state.chatId
  } else if (state.chatId) {
    state = { chatId: null, messages: [], agent: null, model: null, attachments: [] }
    chatSelectNode.value = ''
    await persist()
    render()
  }
  hideStatus()
}

async function selectChat(chatId) {
  hideSettings()
  if (!chatId) {
    state = { chatId: null, messages: [], agent: null, model: null, attachments: [] }
    chatSelectNode.value = ''
    await loadOptions()
    await persist()
    render()
    inputNode.focus()
    return
  }
  setBusy(true)
  try {
    const result = await codeyApi('/v1/chat/history', { method: 'POST', body: { chatId } })
    state = {
      chatId: result.chat?.id || chatId,
      agent: result.chat?.agent || null,
      model: result.chat?.model || null,
      attachments: [],
      messages: Array.isArray(result.messages)
        ? result.messages
          .filter(message => message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
          .map(message => ({
            role: message.role,
            text: message.content || (Array.isArray(message.attachments) && message.attachments.length
              ? `Attached ${message.attachments.map(attachment => attachment.name).join(', ')}`
              : ''),
          }))
        : [],
    }
    chatSelectNode.value = state.chatId
    await loadOptions()
    await persist()
    render()
    hideStatus()
  } catch (error) {
    state = { chatId: null, messages: [], agent: null, model: null, attachments: [] }
    chatSelectNode.value = ''
    await persist()
    render()
    showStatus(error)
  } finally {
    setBusy(false)
    inputNode.focus()
  }
}

function typingNode() {
  const node = document.createElement('div')
  node.className = 'message assistant typing'
  node.innerHTML = '<i></i><i></i><i></i>'
  return node
}

// Codey refreshes the extension's files on its own launch, but Chrome keeps
// running the build it loaded until the extension is reloaded. The service
// worker records the mismatch while polling; surfacing it here is the only
// thing that tells the user their Codey is newer than their Chrome extension.
async function refreshUpdateNotice() {
  const { updateAvailable } = await chrome.storage.local.get({ updateAvailable: '' })
  updateNoticeNode.hidden = !updateAvailable
  updateCopyNode.textContent = updateAvailable
    ? `Codey ${updateAvailable} is installed. Reload the extension to use it.`
    : ''
}

// Reloading from here re-reads the files Codey already staged, so the user
// never has to find chrome://extensions themselves.
function reloadExtension() {
  updateOpenNode.disabled = true
  chrome.runtime.reload()
}

// Copying the current site's signed-in session into a Codey Browser profile.
// Codey does the export and the import; the panel only reports the outcome,
// and it reports it on the button itself so nothing is added to the chat.
let handoffResetTimer = null
let handoffPageUrl = null

// The name is asked for rather than assumed, but the field arrives prefilled
// with a name Codey has already checked is free, so accepting the default is
// still a single extra keystroke.
async function openHandoffForm() {
  if (!activePage || handoffNode.disabled) return
  if (handoffResetTimer) clearTimeout(handoffResetTimer)
  handoffNode.disabled = true
  handoffNode.textContent = 'Naming\u2026'
  let suggestion = ''
  try {
    const hostname = new URL(activePage.url).hostname
    suggestion = (await codeyApi('/v1/session/handoff/name', { method: 'POST', body: { hostname } })).name
  } catch (error) {
    handoffNode.disabled = false
    handoffNode.textContent = 'Handoff failed'
    handoffNode.title = error instanceof Error ? error.message : String(error)
    handoffResetTimer = setTimeout(resetHandoffButton, 6000)
    return
  }
  handoffNode.textContent = 'Hand off login'
  handoffFormNode.hidden = false
  handoffNameNode.value = suggestion
  handoffNameNode.focus()
  handoffNameNode.select()
}

function closeHandoffForm() {
  handoffFormNode.hidden = true
  handoffNameNode.value = ''
  handoffSaveNode.disabled = false
  handoffNode.disabled = false
}

async function handOffSession() {
  const name = handoffNameNode.value.trim()
  if (!name) {
    handoffNameNode.focus()
    return
  }
  handoffSaveNode.disabled = true
  handoffSaveNode.textContent = 'Saving\u2026'
  try {
    const result = await codeyApi('/v1/session/handoff', { method: 'POST', body: { name } })
    closeHandoffForm()
    handoffNode.textContent = `Saved as ${result.profileName}`
    handoffNode.title = `${result.cookieCount} cookies from ${result.origin} are now in the Codey Browser profile "${result.profileName}"`
    handoffResetTimer = setTimeout(resetHandoffButton, 6000)
  } catch (error) {
    // The form stays open on failure so a rejected name can just be retyped.
    handoffSaveNode.disabled = false
    handoffNode.textContent = 'Handoff failed'
    handoffNode.title = error instanceof Error ? error.message : String(error)
    handoffNameNode.focus()
    handoffNameNode.select()
  } finally {
    handoffSaveNode.textContent = 'Save'
  }
}

function resetHandoffButton() {
  if (handoffResetTimer) clearTimeout(handoffResetTimer)
  handoffResetTimer = null
  closeHandoffForm()
  handoffNode.textContent = 'Hand off login'
  handoffNode.title = "Copy this site's signed-in session into a Codey Browser profile"
}

async function refreshActivePage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  activePage = tab && /^https?:\/\//i.test(tab.url || '')
    ? { title: tab.title || 'Untitled tab', url: tab.url }
    : null
  pageContextNode.hidden = !activePage
  pageTitleNode.textContent = activePage ? activePage.title : ''
  pageContextNode.title = activePage?.url || ''
  // A result from the previous site would be misleading here.
  if (activePage?.url !== handoffPageUrl) {
    handoffPageUrl = activePage?.url || null
    resetHandoffButton()
  }
}

async function ensurePreparedChat() {
  if (state.chatId) return state.chatId
  await refreshActivePage()
  const result = await codeyApi('/v1/chat/prepare', {
    method: 'POST',
    body: {
      page: includePageNode.checked ? activePage : null,
      agent: state.agent,
      model: state.model,
    },
  })
  state.chatId = result.chat.id
  chatSelectNode.value = state.chatId
  await loadChatList()
  await loadOptions()
  await persist()
  return state.chatId
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
  }
  return btoa(binary)
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

async function uploadFiles(files) {
  const selected = Array.from(files)
  if (!selected.length || busy) return
  hideStatus()
  setBusy(true)
  try {
    const room = 10 - state.attachments.length
    if (room <= 0) throw new Error('A maximum of 10 attachments is allowed')
    await ensurePreparedChat()
    for (const file of selected.slice(0, room)) {
      if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} exceeds 10 MB`)
      const result = await codeyApi('/v1/chat/upload', {
        method: 'POST',
        body: {
          chatId: state.chatId,
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          data: bufferToBase64(await file.arrayBuffer()),
        },
      })
      state.attachments.push(result.attachment)
      renderAttachments()
      await persist()
    }
    if (selected.length > room) showStatus('Only the first 10 attachments were added')
  } catch (error) {
    showStatus(error)
  } finally {
    setBusy(false)
    fileInputNode.value = ''
    inputNode.focus()
  }
}

async function submit() {
  const text = inputNode.value.trim()
  if ((!text && state.attachments.length === 0) || busy) return
  setBusy(true)
  hideSettings()
  hideStatus()
  inputNode.value = ''
  inputNode.style.height = '38px'
  const visibleText = text || `Attached ${state.attachments.map(item => item.name).join(', ')}`
  state.messages.push({ role: 'user', text: visibleText })
  render()
  const pending = typingNode()
  messagesNode.appendChild(pending)
  messagesNode.scrollTop = messagesNode.scrollHeight
  try {
    await refreshActivePage()
    const result = await codeyApi('/v1/chat', {
      method: 'POST',
      body: {
        chatId: state.chatId,
        text,
        agent: state.agent,
        model: state.model,
        attachmentIds: state.attachments.map(item => item.id),
        page: includePageNode.checked ? activePage : null,
      },
    })
    state.chatId = result.chatId
    state.attachments = []
    state.messages.push({ role: 'assistant', text: result.response || 'Done.' })
    try {
      await loadChatList()
      await loadOptions()
    } catch { /* the completed turn remains usable if settings refresh fails */ }
  } catch (error) {
    showStatus(error)
  } finally {
    pending.remove()
    setBusy(false)
    render()
    await persist()
    inputNode.focus()
  }
}

async function transcribeRecording(mimeType, data) {
  voiceNode.classList.remove('recording')
  voiceNode.title = 'Voice input'
  voiceNode.setAttribute('aria-label', 'Start voice input')
  if (!data) return
  hideStatus()
  try {
    voiceNode.title = 'Transcribing…'
    const result = await codeyApi('/v1/voice/transcribe', {
      method: 'POST',
      body: { mimeType, data },
    })
    if (result.text) {
      const spacer = inputNode.value && !/\s$/.test(inputNode.value) ? ' ' : ''
      inputNode.value += `${spacer}${result.text}`
      inputNode.dispatchEvent(new Event('input'))
    }
  } catch (error) {
    showStatus(error)
  } finally {
    voiceNode.title = 'Voice input'
    inputNode.focus()
  }
}

async function startVoiceRecording() {
  const result = await chrome.runtime.sendMessage({ type: 'codey:voice-start' })
  if (!result?.ok) {
    const error = new Error(result?.error || 'Chrome could not start voice input')
    if (result?.errorName) error.name = result.errorName
    throw error
  }
  voiceRecording = true
  voiceNode.classList.add('recording')
  voiceNode.title = 'Stop and transcribe'
  voiceNode.setAttribute('aria-label', 'Stop and transcribe')
  hideStatus()
}

function isMicrophonePermissionError(error) {
  const value = `${error?.name || ''} ${error?.message || error || ''}`
  return /NotAllowedError|Permission denied|Permission dismissed|not allowed/i.test(value)
}

async function openMicrophonePermission() {
  const permissionUrl = chrome.runtime.getURL('microphone.html')
  const existing = await chrome.tabs.query({ url: permissionUrl }).catch(() => [])
  if (existing[0]?.id) await chrome.tabs.update(existing[0].id, { active: true })
  else await chrome.tabs.create({ url: permissionUrl, active: true })
  showVoiceStatus('Allow microphone access in the Codey tab. It will close automatically when permission is granted.')
}

async function toggleVoice() {
  if (voiceRecording) {
    voiceRecording = false
    voiceNode.classList.remove('recording')
    voiceNode.setAttribute('aria-label', 'Start voice input')
    setVoiceBusy(true)
    try {
      voiceNode.title = 'Transcribing…'
      const result = await chrome.runtime.sendMessage({ type: 'codey:voice-stop' })
      if (!result?.ok) throw new Error(result?.error || 'Chrome could not finish voice input')
      await transcribeRecording(result.mimeType || 'audio/webm', result.data)
    } catch (error) {
      showVoiceStatus(error)
    } finally {
      setVoiceBusy(false)
    }
    return
  }
  hideStatus()
  try {
    let permissionState = 'prompt'
    try {
      const permission = await navigator.permissions.query({ name: 'microphone' })
      permissionState = permission.state
    } catch { /* Permissions API may not expose microphone; getUserMedia still requests it. */ }
    if (permissionState !== 'granted') {
      await openMicrophonePermission()
      return
    }
    await startVoiceRecording()
  } catch (error) {
    if (isMicrophonePermissionError(error)) await openMicrophonePermission()
    else showVoiceStatus(error)
  }
}

formNode.addEventListener('submit', event => { event.preventDefault(); void submit() })
inputNode.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() }
})
inputNode.addEventListener('input', () => {
  inputNode.style.height = 'auto'
  inputNode.style.height = `${Math.max(42, Math.min(inputNode.scrollHeight, 140))}px`
})
settingsToggleNode.addEventListener('click', () => { if (!busy) toggleSettings() })
updateOpenNode.addEventListener('click', reloadExtension)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.updateAvailable) void refreshUpdateNotice()
})
void refreshUpdateNotice()
handoffNode.addEventListener('click', () => { void openHandoffForm() })
handoffFormNode.addEventListener('submit', event => { event.preventDefault(); void handOffSession() })
handoffCancelNode.addEventListener('click', () => resetHandoffButton())
handoffNameNode.addEventListener('keydown', event => { if (event.key === 'Escape') resetHandoffButton() })
chatSelectNode.addEventListener('change', () => {
  if (!busy) void selectChat(chatSelectNode.value)
})
agentSelectNode.addEventListener('change', () => {
  if (busy) return
  state.agent = agentSelectNode.value || null
  state.model = null
  populateModels()
  void updateChatSettings().catch(showStatus)
})
modelSelectNode.addEventListener('change', () => {
  if (busy) return
  state.model = modelSelectNode.value || null
  void updateChatSettings().catch(showStatus)
})
fileInputNode.addEventListener('change', () => { void uploadFiles(fileInputNode.files || []) })
document.addEventListener('click', event => {
  if (settingsPopoverNode.hidden) return
  if (settingsPopoverNode.contains(event.target) || settingsToggleNode.contains(event.target)) return
  hideSettings()
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !settingsPopoverNode.hidden) {
    hideSettings()
    settingsToggleNode.focus()
  }
})
chrome.tabs.onActivated.addListener(() => void refreshActivePage())
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.title || changeInfo.url || changeInfo.status === 'complete') void refreshActivePage()
})
document.querySelector('#status-retry').addEventListener('click', () => {
  if (busy) return
  void (async () => {
    setBusy(true)
    try {
      await loadChatList()
      if (state.chatId) await selectChat(state.chatId)
      else await loadOptions()
    } catch (error) {
      showStatus(error)
    } finally {
      setBusy(false)
    }
  })()
})
window.addEventListener('beforeunload', () => {
  if (voiceRecording) void chrome.runtime.sendMessage({ type: 'codey:voice-cancel' }).catch(() => undefined)
})

void (async () => {
  const saved = await chrome.storage.session.get({ [STATE_KEY]: state })
  if (saved[STATE_KEY] && typeof saved[STATE_KEY] === 'object') {
    state = { ...state, ...saved[STATE_KEY] }
  }
  state.messages = Array.isArray(state.messages) ? state.messages.filter(message => !message?.error) : []
  state.attachments = Array.isArray(state.attachments) ? state.attachments.slice(0, 10) : []
  render()
  await refreshActivePage()
  try {
    await loadChatList()
    if (state.chatId) await selectChat(state.chatId)
    else await loadOptions()
  } catch (error) {
    showStatus(error)
  }
  inputNode.focus()
})()
