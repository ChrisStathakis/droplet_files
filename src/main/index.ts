import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { join } from 'path'
import { registerIpc, setMainWindow } from './ipc'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(app.getAppPath(), 'build', 'icon.ico')
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * While scheduled actions are enabled the window can be closed to the tray,
 * so backups keep running in the background. Without actions, closing quits.
 */
function setTrayRequired(required: boolean): void {
  try {
    if (required && !tray) {
      const image = nativeImage.createFromPath(trayIconPath())
      tray = new Tray(image)
      tray.setToolTip('Droplet Files — scheduled backups are on')
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Show Droplet Files', click: () => showWindow() },
          { type: 'separator' },
          {
            label: 'Quit',
            click: () => {
              quitting = true
              app.quit()
            }
          }
        ])
      )
      tray.on('click', () => showWindow())
    } else if (!required && tray) {
      tray.destroy()
      tray = null
    }
  } catch (err) {
    console.error('[tray] could not create the tray icon:', err)
    tray = null
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 560,
    title: 'Droplet Files',
    backgroundColor: '#12151a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  setMainWindow(mainWindow)

  mainWindow.on('close', (event) => {
    if (!quitting && tray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    setMainWindow(null)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
    // Surface renderer errors/logs in the dev terminal
    mainWindow.webContents.on('console-message', (event) => {
      console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
    })
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.dropletfiles.app')
  registerIpc({ onActionsEnabledChange: setTrayRequired })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit()
})
