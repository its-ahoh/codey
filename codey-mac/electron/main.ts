import { app, BrowserWindow, Menu, ipcMain, Tray, nativeImage, shell, dialog } from 'electron'
import { join } from 'path'
import { WorkerManager, WorkspaceManager } from '@codey/core'
import { Codey } from '@codey/gateway/dist/gateway'
import { ConfigManager } from '@codey/gateway/dist/config'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let inProcessGateway: Codey | null = null
let workerManager: WorkerManager | null = null
let workspaceManager: WorkspaceManager | null = null
let coreConfigManager: ConfigManager | null = null

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 580,
    minWidth: 600,
    minHeight: 400,
    show: false,
    backgroundColor: '#141414',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Hide the window initially (menu bar app style)
  mainWindow.hide()

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function sendToRenderer(channel: string, ...args: any[]) {
  mainWindow?.webContents.send(channel, ...args)
}

function createTray() {
  const trayIconPath = app.isPackaged
    ? join(process.resourcesPath, 'trayIconTemplate.png')
    : join(__dirname, '..', 'build', 'trayIconTemplate.png')
  const icon = nativeImage.createFromPath(trayIconPath)
  icon.setTemplateImage(true)
  tray = new Tray(icon)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Codey',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      }
    },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setToolTip('Codey - Gateway Control')
  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

function resolveDataRoot(): string {
  // Dev (unpacked): use the monorepo root so the app picks up existing
  // gateway.json, workers/, and workspaces/ from the repo.
  // Packaged: use ~/.codey/ so a real gateway.json / workers / workspaces
  // directory can be edited in place.
  if (isDev) return join(__dirname, '..', '..')
  const home = app.getPath('home')
  const root = join(home, '.codey')
  try {
    const fs = require('fs')
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true })
    if (!fs.existsSync(join(root, 'workers'))) fs.mkdirSync(join(root, 'workers'), { recursive: true })
    if (!fs.existsSync(join(root, 'workspaces'))) fs.mkdirSync(join(root, 'workspaces'), { recursive: true })
  } catch { /* best-effort */ }
  return root
}

function buildRuntimeConfig(json: any): any {
  // Flatten the on-disk GatewayConfigJson into the runtime GatewayConfig
  // the Codey class expects (defaultAgent at top level, channels pruned
  // to enabled-only).
  return {
    port: json?.gateway?.port,
    defaultAgent: json?.gateway?.defaultAgent,
    agents: json?.agents,
    channels: {
      telegram: json?.channels?.telegram?.enabled
        ? { botToken: json.channels.telegram.botToken, notifyChatId: json.channels.telegram.notifyChatId }
        : undefined,
      discord: json?.channels?.discord?.enabled
        ? { botToken: json.channels.discord.botToken }
        : undefined,
      imessage: json?.channels?.imessage?.enabled ? { enabled: true } : undefined,
    },
    planner: json?.planner,
    context: json?.context,
    memory: json?.memory,
  }
}

async function bootInProcessCore() {
  const root = resolveDataRoot()
  try {
    coreConfigManager = new ConfigManager(join(root, 'gateway.json'))
    workerManager = new WorkerManager(join(root, 'workers'))
    await workerManager.loadWorkers()
    workspaceManager = new WorkspaceManager(workerManager, join(root, 'workspaces'))
    let existing = workspaceManager.listWorkspaces()
    if (existing.length === 0) {
      // Cold start (or user deleted every workspace): seed a "default"
      // workspace pointing at the user's home directory so chats can be
      // created without first picking a folder.
      const fsMod = await import('fs')
      const defaultDir = join(root, 'workspaces', 'default')
      fsMod.mkdirSync(defaultDir, { recursive: true })
      fsMod.writeFileSync(
        join(defaultDir, 'workspace.json'),
        JSON.stringify({ workingDir: app.getPath('home'), teams: {} }, null, 2)
      )
      fsMod.writeFileSync(join(defaultDir, 'memory.md'), '# default — Project Memory\n')
      existing = workspaceManager.listWorkspaces()
    }
    if (existing.length > 0) {
      await workspaceManager.switchWorkspace(existing[0])
    }
    const runtimeCfg = buildRuntimeConfig(coreConfigManager.get())
    inProcessGateway = new Codey(runtimeCfg, undefined, join(root, 'workspaces'), coreConfigManager, workerManager)
    // Apply config changes to the running gateway when the renderer edits them.
    // applyConfig is async so a missing await would swallow channel-start errors.
    coreConfigManager.on('change', (updated: any) => {
      inProcessGateway?.applyConfig(buildRuntimeConfig(updated)).catch((err: any) => {
        sendToRenderer('gateway-log', `[core] applyConfig failed: ${err?.message ?? err}`)
      })
    })
    sendToRenderer('gateway-log', `[core] In-process core booted (root: ${root}, workers: ${workerManager.getAllWorkers().length}, agent: ${runtimeCfg.defaultAgent})`)
    // Boot the gateway in the background so configured channels (telegram,
    // discord, imessage) connect. Done after returning so IPC handler
    // registration in app.whenReady() isn't blocked by network I/O
    // (e.g. Telegram setMyCommands hanging).
    void inProcessGateway.start().catch((err: any) => {
      sendToRenderer('gateway-log', `[core] gateway.start failed: ${err?.message ?? err}`)
    })
  } catch (err: any) {
    sendToRenderer('gateway-log', `[core] Boot failed: ${err?.message ?? err}`)
  }
}

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function wrap<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try { return { ok: true, data: await fn() } }
  catch (e: any) { return { ok: false, error: e?.message ?? String(e) } }
}

function createAppMenu() {
  // Minimal Mac menu so Cmd+Q, Cmd+W, Cmd+R, Cmd+Option+I etc. work.
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit Codey', accelerator: 'Cmd+Q', click: () => { isQuitting = true; app.quit() } },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  createAppMenu()
  createWindow()
  createTray()
  await bootInProcessCore()

  // ── Gateway status IPC ────────────────────────────────────────────
  ipcMain.handle('gateway:status', async () =>
    wrap(async () => inProcessGateway?.getHealthStatus() ?? null)
  )

  // ── Workers IPC ──────────────────────────────────────────────────
  ipcMain.handle('workers:list', async () =>
    wrap(async () => workerManager?.getAllWorkers() ?? [])
  )

  ipcMain.handle('workers:get', async (_e, name: string) =>
    wrap(async () => {
      const w = workerManager?.getWorker(name)
      if (!w) throw new Error(`Worker not found: ${name}`)
      return w
    })
  )

  ipcMain.handle('workers:save', async (_e, name: string, personality: any, config: any) =>
    wrap(async () => {
      await workerManager?.saveWorker(name, personality, config)
    })
  )

  ipcMain.handle('workers:delete', async (_e, name: string) =>
    wrap(async () => {
      await workerManager?.deleteWorker(name)
      // cascade: remove from all teams
      if (workspaceManager) {
        const teams = workspaceManager.getTeams()
        let changed = false
        for (const team of Object.keys(teams)) {
          const filtered = teams[team].filter((m: string) => m !== name)
          if (filtered.length !== teams[team].length) { teams[team] = filtered; changed = true }
        }
        if (changed) await workspaceManager.setTeams(teams)
      }
    })
  )

  // ── Workspaces IPC ────────────────────────────────────────────────
  ipcMain.handle('workspaces:list', async () =>
    wrap(async () => workspaceManager?.listWorkspaces() ?? [])
  )

  ipcMain.handle('workspaces:current', async () =>
    wrap(async () => workspaceManager?.getCurrentWorkspace() ?? '')
  )

  ipcMain.handle('workspaces:switch', async (_e, name: string) =>
    wrap(async () => {
      await workspaceManager?.switchWorkspace(name)
    })
  )

  ipcMain.handle('workspaces:memory:get', async (_e, name: string) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const root = workspaceManager.getWorkspacesRoot()
      const memPath = pathMod.join(root, name, 'memory.md')
      if (!fsMod.existsSync(memPath)) return ''
      return fsMod.readFileSync(memPath, 'utf-8')
    })
  )

  ipcMain.handle('workspaces:memory:set', async (_e, name: string, content: string) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      if (typeof content !== 'string') throw new Error('Content must be a string')
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const root = workspaceManager.getWorkspacesRoot()
      const wsDir = pathMod.join(root, name)
      if (!fsMod.existsSync(wsDir) || !fsMod.statSync(wsDir).isDirectory()) {
        throw new Error(`Workspace "${name}" does not exist`)
      }
      const memPath = pathMod.join(wsDir, 'memory.md')
      await fsMod.promises.writeFile(memPath, content, 'utf-8')
    })
  )

  ipcMain.handle('workspaces:info', async (_e, name: string) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const root = workspaceManager.getWorkspacesRoot()
      const configPath = pathMod.join(root, name, 'workspace.json')
      if (!fsMod.existsSync(configPath)) return { workingDir: '' }
      const data = JSON.parse(fsMod.readFileSync(configPath, 'utf-8'))
      return { workingDir: data.workingDir || '' }
    })
  )

  ipcMain.handle('workspaces:create', async (_e, dir: string) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      if (!dir || typeof dir !== 'string') throw new Error('A directory is required')
      const fsMod = await import('fs')
      if (!fsMod.existsSync(dir) || !fsMod.statSync(dir).isDirectory()) {
        throw new Error(`Not a directory: ${dir}`)
      }
      return workspaceManager.findOrCreateByDir(dir)
    })
  )

  ipcMain.handle('workspaces:delete', async (_e, name: string) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      await workspaceManager.deleteWorkspace(name)
      inProcessGateway?.getChatManager().cascadeDeleteWorkspace(name)
    })
  )

  ipcMain.handle('dialog:pickDirectory', async () =>
    wrap(async () => {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined as any, {
        title: 'Select project folder',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    })
  )

  // ── Teams IPC ─────────────────────────────────────────────────────
  ipcMain.handle('teams:get', async (_e, name?: string) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      const target = name || workspaceManager.getCurrentWorkspace()
      if (!target) return {} as Record<string, string[]>
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const configPath = pathMod.join(workspaceManager.getWorkspacesRoot(), target, 'workspace.json')
      if (!fsMod.existsSync(configPath)) return {} as Record<string, string[]>
      const data = JSON.parse(fsMod.readFileSync(configPath, 'utf-8'))
      return (data.teams || {}) as Record<string, string[]>
    })
  )

  ipcMain.handle('teams:set', async (_e, nameOrTeams: string | Record<string, string[]>, maybeTeams?: Record<string, string[]>) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      // Backward-compat: support both (teams) and (name, teams) call shapes.
      let target: string
      let teams: Record<string, string[]>
      if (typeof nameOrTeams === 'string') {
        target = nameOrTeams || workspaceManager.getCurrentWorkspace()
        teams = maybeTeams || {}
      } else {
        target = workspaceManager.getCurrentWorkspace()
        teams = nameOrTeams || {}
      }
      if (!target) throw new Error('No workspace specified')

      if (target === workspaceManager.getCurrentWorkspace()) {
        await workspaceManager.setTeams(teams)
        return
      }
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const configPath = pathMod.join(workspaceManager.getWorkspacesRoot(), target, 'workspace.json')
      if (!fsMod.existsSync(configPath)) throw new Error(`Workspace "${target}" does not exist`)
      const existing = JSON.parse(await fsMod.promises.readFile(configPath, 'utf-8'))
      existing.teams = teams
      await fsMod.promises.writeFile(configPath, JSON.stringify(existing, null, 2), 'utf-8')
    })
  )

  // ── Workers generate IPC ──────────────────────────────────────────
  ipcMain.handle('workers:generate', async (_e, prompt: string) =>
    wrap(async () => {
      const { generateWorker, AgentFactory } = await import('@codey/core')
      const factory = new AgentFactory()
      const root = resolveDataRoot()
      const activeAgent = (inProcessGateway as any)?.config?.defaultAgent ?? 'claude-code'
      // Reuse the gateway's credential-aware resolver so apiKey+baseUrl
      // from the active profile flow through. Without this, MiniMax
      // (or any custom-endpoint routing) never receives its auth and
      // the spawned CLI exits 1 hitting the default endpoint.
      const activeModel = (inProcessGateway as any)?.getDefaultModelConfig?.(activeAgent)
        ?? { provider: 'anthropic', model: 'claude-sonnet-4-5' }
      const result = await generateWorker(
        {
          agentFactory: factory,
          workerManager: workerManager!,
          workersDir: join(root, 'workers'),
          activeAgent,
          activeModel,
          workingDir: root,
        },
        prompt,
      )
      if (!result.ok) throw new Error(result.error)
      return result.worker
    })
  )

  // ── Config IPC ────────────────────────────────────────────────────
  ipcMain.handle('config:get', async () =>
    wrap(async () => coreConfigManager?.get() ?? {})
  )

  ipcMain.handle('config:set', async (_e, updates: any) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.update(updates)
    })
  )

  // ── Models IPC ────────────────────────────────────────────────────
  ipcMain.handle('models:list', async () =>
    wrap(async () => coreConfigManager?.listModels() ?? [])
  )

  ipcMain.handle('models:save', async (_e, entry: any) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      if (!entry?.model) throw new Error('Model id is required')
      if (entry.apiType !== 'anthropic' && entry.apiType !== 'openai') {
        throw new Error('Model apiType must be "anthropic" or "openai"')
      }
      coreConfigManager.saveModel(entry)
    })
  )

  ipcMain.handle('models:delete', async (_e, name: string) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.deleteModel(name)
    })
  )

  ipcMain.handle('models:rename', async (_e, oldName: string, newName: string) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.renameModel(oldName, newName)
    })
  )

  // ── Fallback IPC ──────────────────────────────────────────────────
  ipcMain.handle('fallback:get', async () =>
    wrap(async () => coreConfigManager?.getFallback() ?? { enabled: true, order: [] })
  )

  ipcMain.handle('fallback:set', async (_e, fb: any) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.setFallback({ enabled: !!fb?.enabled, order: Array.isArray(fb?.order) ? fb.order : [] })
    })
  )

  // ── Agents IPC ────────────────────────────────────────────────────
  ipcMain.handle('agents:get', async () =>
    wrap(async () => {
      const cfg = coreConfigManager?.get()
      return cfg?.agents ?? {}
    })
  )

  ipcMain.handle('agents:set', async (_e, updates: any) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.update({ agents: updates })
    })
  )

  // ── Conversations IPC ─────────────────────────────────────────────
  ipcMain.handle('conversations:list', async () =>
    wrap(async () => {
      const cm = (inProcessGateway as any)?.contextManager
      return cm?.listConversationIds?.() ?? []
    })
  )

  // ── Chat IPC ──────────────────────────────────────────────────────
  ipcMain.handle('chat:send', async (_e, payload: {
    conversationId: string
    text: string
    sender?: string
  }) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      const convId = payload.conversationId
      const sse = (event: string, data: string) => {
        if (event === 'stream' || event === 'plan') {
          sendToRenderer('chat:token', { conversationId: convId, token: data })
        } else if (event === 'status') {
          sendToRenderer('chat:status', { conversationId: convId, update: data })
        }
      }
      const result = await inProcessGateway.processPromptHttp(payload.text, sse, convId)
      // Always deliver the final response — some agent paths skip streaming
      if (result?.response) {
        sendToRenderer('chat:done', {
          conversationId: convId,
          response: result.response,
          tokens: result.tokens,
          durationSec: result.durationSec,
        })
      }
      return result
    })
  )

  // ── Chats IPC (multi-chat) ────────────────────────────────────────
  ipcMain.handle('chats:list', async (_e, workspaceName?: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.getChatManager().list(workspaceName)
    })
  )

  ipcMain.handle('chats:get', async (_e, id: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      const c = inProcessGateway.getChatManager().get(id)
      if (!c) throw new Error(`Chat not found: ${id}`)
      return c
    })
  )

  ipcMain.handle('chats:create', async (_e, input: { workspaceName: string; selection?: any; title?: string }) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.getChatManager().create(input)
    })
  )

  ipcMain.handle('chats:rename', async (_e, id: string, title: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.getChatManager().rename(id, title)
    })
  )

  ipcMain.handle('chats:delete', async (_e, id: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      inProcessGateway.getChatManager().delete(id)
      return null
    })
  )

  ipcMain.handle('chats:updateSelection', async (_e, id: string, selection: any) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.getChatManager().updateSelection(id, selection)
    })
  )

  ipcMain.handle('chats:send', async (_e, payload: { chatId: string; text: string }) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      const sink = (ev: any) => {
        // Mirror each event to the renderer as a single `chats:event` channel
        // so the frontend can route by chatId without sniffing event names.
        sendToRenderer('chats:event', ev)
      }
      return inProcessGateway.sendToChat(payload.chatId, payload.text, sink)
    })
  )

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      mainWindow?.show()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  isQuitting = true
})

// IPC handlers
ipcMain.handle('show-window', () => {
  mainWindow?.show()
  mainWindow?.focus()
})

ipcMain.handle('open-external', (_event, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url)
  }
})

ipcMain.handle('shell:openPath', async (_event, p: string) => {
  if (typeof p !== 'string' || !p) return ''
  return await shell.openPath(p)
})
