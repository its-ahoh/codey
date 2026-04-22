import { app, BrowserWindow, Menu, ipcMain, Tray, nativeImage } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { execSync, spawn, ChildProcess } from 'child_process'
import { homedir } from 'os'
import { WorkerManager, WorkspaceManager } from '@codey/core'
import { Codey } from '@codey/gateway/dist/gateway'
import { ConfigManager } from '@codey/gateway/dist/config'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let gatewayProcess: ChildProcess | null = null
let isGatewayRunning = false
let inProcessGateway: Codey | null = null
let workerManager: WorkerManager | null = null
let workspaceManager: WorkspaceManager | null = null
let coreConfigManager: ConfigManager | null = null

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

function getGatewayPath(): string {
  // 1. Check persisted settings first (user-configured path)
  const settingsPath = join(app.getPath('userData'), 'settings.json')
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      if (settings.gatewayPath && existsSync(join(settings.gatewayPath, 'dist', 'index.js'))) {
        return settings.gatewayPath
      }
    }
  } catch { /* ignore */ }

  // 2. In dev, use the parent of the codey-mac directory
  if (isDev) {
    const devPath = join(__dirname, '..', '..')
    if (existsSync(join(devPath, 'dist', 'index.js'))) {
      return devPath
    }
  }

  // 3. Check common install locations
  const candidates = [
    join(homedir(), '.codey'),
    join(homedir(), 'codey'),
    join(homedir(), 'Documents', 'projects', 'codey'),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'dist', 'index.js'))) {
      return candidate
    }
  }

  // 4. Return empty string to signal "not found"
  return ''
}

function setGatewayPath(gatewayPath: string): void {
  const settingsPath = join(app.getPath('userData'), 'settings.json')
  let settings: Record<string, any> = {}
  try {
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    }
  } catch { /* ignore */ }
  settings.gatewayPath = gatewayPath
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    show: false,
    backgroundColor: '#1a1a1a',
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

function startGateway() {
  if (gatewayProcess) return

  sendToRenderer('gateway-log', 'Starting gateway...')

  // Set up environment with paths needed by the gateway and its child processes.
  // Electron apps inherit a minimal PATH, so resolve the user's full login shell PATH.
  const env = { ...process.env }
  try {
    const shell = env.SHELL || '/bin/zsh'
    const loginPath = execSync(`${shell} -ilc 'echo $PATH'`, { encoding: 'utf-8', timeout: 5000 }).trim()
    if (loginPath) {
      env.PATH = loginPath
    }
  } catch {
    // Fallback: add common bin directories
    const home = homedir()
    const extraPaths = [
      join(home, '.local', 'bin'),
      join(home, '.nvm', 'versions', 'node', 'current', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]
    env.PATH = extraPaths.join(':') + ':' + (env.PATH || '')
  }

  // Run the built gateway
  const gatewayPath = getGatewayPath()
  if (!gatewayPath) {
    sendToRenderer('gateway-log', 'ERROR: Gateway not found. Set the gateway path in Settings.')
    sendToRenderer('gateway-status', { running: false })
    return
  }

  const entryPoint = join(gatewayPath, 'dist', 'index.js')
  if (!existsSync(entryPoint)) {
    sendToRenderer('gateway-log', `ERROR: Gateway entry point not found at ${entryPoint}. Run "npm run build" in the gateway directory, or update the gateway path in Settings.`)
    sendToRenderer('gateway-status', { running: false })
    return
  }

  sendToRenderer('gateway-log', `Using gateway at: ${gatewayPath}`)

  gatewayProcess = spawn('node', ['dist/index.js'], {
    cwd: gatewayPath,
    env: env,
    shell: true
  })

  gatewayProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean)
    lines.forEach(line => {
      sendToRenderer('gateway-log', line)
    })
  })

  gatewayProcess.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean)
    lines.forEach(line => {
      sendToRenderer('gateway-log', `ERROR: ${line}`)
    })
  })

  gatewayProcess.on('error', (error) => {
    sendToRenderer('gateway-log', `Process error: ${error.message}`)
    isGatewayRunning = false
    gatewayProcess = null
    sendToRenderer('gateway-status', { running: false })
  })

  gatewayProcess.on('exit', (code) => {
    sendToRenderer('gateway-log', `Process exited with code ${code}`)
    isGatewayRunning = false
    gatewayProcess = null
    sendToRenderer('gateway-status', { running: false })
  })

  isGatewayRunning = true
  sendToRenderer('gateway-status', { running: true })
  sendToRenderer('gateway-log', 'Gateway process spawned')
}

function stopGateway() {
  if (!gatewayProcess) return

  // Remove the exit handler so we don't double-report
  gatewayProcess.removeAllListeners('exit')
  gatewayProcess.kill('SIGTERM')
  gatewayProcess = null
  isGatewayRunning = false

  sendToRenderer('gateway-status', { running: false })
  sendToRenderer('gateway-log', 'Gateway stopped')
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
      label: 'Start Gateway',
      click: () => {
        if (!isGatewayRunning) startGateway()
      }
    },
    {
      label: 'Stop Gateway',
      click: () => {
        if (isGatewayRunning) stopGateway()
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        if (gatewayProcess) stopGateway()
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

function bootInProcessCore() {
  const cwd = process.cwd()
  try {
    coreConfigManager = new ConfigManager()
    workerManager = new WorkerManager(join(cwd, 'workers'))
    workspaceManager = new WorkspaceManager(workerManager, join(cwd, 'workspaces'))
    inProcessGateway = new Codey(coreConfigManager.get() as any, undefined, join(cwd, 'workspaces'), coreConfigManager, workerManager)
    sendToRenderer('gateway-log', '[core] In-process core booted successfully.')
  } catch (err: any) {
    sendToRenderer('gateway-log', `[core] Boot failed: ${err?.message ?? err}`)
  }
}

app.whenReady().then(() => {
  createWindow()
  createTray()
  bootInProcessCore()

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
  if (gatewayProcess) {
    stopGateway()
  }
})

// IPC handlers
ipcMain.handle('get-app-path', () => {
  return app.getAppPath()
})

ipcMain.handle('show-window', () => {
  mainWindow?.show()
  mainWindow?.focus()
})

ipcMain.handle('start-gateway', () => {
  startGateway()
})

ipcMain.handle('stop-gateway', () => {
  stopGateway()
})

ipcMain.handle('get-gateway-path', () => {
  return getGatewayPath()
})

ipcMain.handle('set-gateway-path', (_event, gatewayPath: string) => {
  setGatewayPath(gatewayPath)
})
