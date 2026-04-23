import { app, BrowserWindow, Menu, ipcMain, Tray, nativeImage, shell } from 'electron'
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
  // Create a simple 16x16 icon programmatically (green square)
  const size = 16
  const iconBuffer = Buffer.alloc(size * size * 4) // RGBA
  for (let i = 0; i < size * size; i++) {
    iconBuffer[i * 4] = 76     // R (green)
    iconBuffer[i * 4 + 1] = 175 // G
    iconBuffer[i * 4 + 2] = 80  // B
    iconBuffer[i * 4 + 3] = 255 // A
  }
  const icon = nativeImage.createFromBuffer(iconBuffer, { width: size, height: size })
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
  // In dev (unpacked), use the monorepo root so the app picks up existing
  // gateway.json, workers/, and workspaces/ from the repo.
  // In production, fall back to Electron's per-user data directory.
  if (isDev) return join(__dirname, '..', '..')
  return app.getPath('userData')
}

function bootInProcessCore() {
  const root = resolveDataRoot()
  try {
    coreConfigManager = new ConfigManager(join(root, 'gateway.json'))
    workerManager = new WorkerManager(join(root, 'workers'))
    workspaceManager = new WorkspaceManager(workerManager, join(root, 'workspaces'))
    inProcessGateway = new Codey(coreConfigManager.get() as any, undefined, join(root, 'workspaces'), coreConfigManager, workerManager)
    sendToRenderer('gateway-log', `[core] In-process core booted (root: ${root})`)
  } catch (err: any) {
    sendToRenderer('gateway-log', `[core] Boot failed: ${err?.message ?? err}`)
  }
}

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function wrap<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try { return { ok: true, data: await fn() } }
  catch (e: any) { return { ok: false, error: e?.message ?? String(e) } }
}

app.whenReady().then(async () => {
  createWindow()
  createTray()
  bootInProcessCore()

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

  // ── Teams IPC ─────────────────────────────────────────────────────
  ipcMain.handle('teams:get', async () =>
    wrap(async () => workspaceManager?.getTeams() ?? {})
  )

  ipcMain.handle('teams:set', async (_e, teams: Record<string, string[]>) =>
    wrap(async () => {
      await workspaceManager?.setTeams(teams)
    })
  )

  // ── Workers generate IPC ──────────────────────────────────────────
  ipcMain.handle('workers:generate', async (_e, prompt: string) =>
    wrap(async () => {
      const { generateWorker, AgentFactory } = await import('@codey/core')
      const factory = new AgentFactory()
      const root = resolveDataRoot()
      const cfg = coreConfigManager?.get() as any
      const result = await generateWorker(
        {
          agentFactory: factory,
          workerManager: workerManager!,
          workersDir: join(root, 'workers'),
          activeAgent: cfg?.gateway?.defaultAgent ?? 'claude-code',
          activeModel: { provider: 'anthropic', model: cfg?.agents?.['claude-code']?.defaultModel ?? 'claude-sonnet-4-5' },
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
      // Gateway processes the message. Agent spawn will likely fail in dev
      // (no real agent configured). User turn is still recorded in context.
      try {
        await inProcessGateway.processPromptHttp(
          payload.text,
          undefined, // no SSE callback
          payload.conversationId
        )
      } catch { /* agent spawn failure expected in dev */ }
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
