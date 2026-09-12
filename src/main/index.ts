import { app, BrowserWindow, Menu, shell, Tray } from 'electron'
import * as path from 'node:path'
import { loadSettings, applyAutoStart } from './settings'
import { netClient } from './net/NetClient'
import { transferEngine } from './transfer/TransferEngine'
import { registerIpc } from './ipc'
import { registerStreamScheme, registerStreamHandler } from './media/StreamProtocol'
import { backupManager } from './backup/BackupManager'
import { updateService } from './update/UpdateService'
import * as diskCache from './storage/DiskCache'
import { logger } from './logger'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** 托盘「退出」或系统退出时置真，之后 close 事件不再拦截 */
let quitting = false
let trayTipShown = false
/** 静默自启动（开机自启 + 静默模式会带 --hidden 参数）：不弹主窗口，直接进托盘 */
const SILENT_START = process.argv.includes('--hidden')

function iconPath(): string {
  // 开发环境取项目 build/，打包后由 extraResources 复制到 resources/
  return app.isPackaged
    ? path.join(process.resourcesPath!, 'icon.ico')
    : path.join(app.getAppPath(), 'build', 'icon.ico')
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

function createTray(): void {
  tray = new Tray(iconPath())
  tray.setToolTip('GOOGLEd 云盘（备份与传输后台运行中）')
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showWindow() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
  // Windows 习惯：左键唤出主窗口，右键弹菜单
  tray.on('click', () => showWindow())
  tray.on('right-click', () => tray?.popUpContextMenu(menu))
  tray.on('double-click', () => showWindow())
  logger.info('系统托盘已创建')
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  registerStreamScheme() // 必须在 ready 之前注册特权协议
  app.on('second-instance', () => showWindow())

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null) // 移除默认菜单栏（File/Edit/View/Window/Help）
    logger.info('GOOGLEd 启动', { version: app.getVersion(), silent: SILENT_START })
    await netClient.applySettings(loadSettings())
    applyAutoStart(loadSettings())
    registerStreamHandler()
    registerIpc()
    transferEngine.start()
    backupManager.start()
    updateService.startAutoCheck()
    createWindow()
    createTray()
    // 缓存自动清理：启动 30 秒后评估一次，之后每 30 分钟检查
    setTimeout(() => void diskCache.maybeAutoClean(), 30_000)
    setInterval(() => void diskCache.maybeAutoClean(), 30 * 60_000)
  })

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('window-all-closed', () => {
    // 关闭窗口 = 最小化到托盘，应用保持运行（备份/传输继续）；只有托盘「退出」才会走到这里
    if (quitting) app.quit()
  })
}

function createWindow(): void {
  if (app.isPackaged) app.setAppUserModelId('com.googled.desktop')
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f7fa',
    title: 'GOOGLEd 云盘',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    // 静默自启动：不弹窗，留在托盘（托盘左键 / second-instance 可唤出）
    if (!SILENT_START) mainWindow?.show()
  })

  // 点关闭 = 隐藏到托盘，备份/传输静默继续；托盘「退出」才真正退出
  mainWindow.on('close', (e) => {
    if (quitting || !tray) return
    e.preventDefault()
    mainWindow?.hide()
    if (!trayTipShown && process.platform === 'win32') {
      trayTipShown = true
      tray.displayBalloon({
        iconType: 'info',
        title: 'GOOGLEd 仍在运行',
        content: '已最小化到系统托盘，备份与传输将继续进行。双击托盘图标可重新打开窗口。'
      })
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}
