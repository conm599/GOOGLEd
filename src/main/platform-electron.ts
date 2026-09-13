import { app, BrowserWindow, dialog, nativeTheme, net, safeStorage, session, shell } from 'electron'
import { spawn } from 'node:child_process'
import { setPlatform, type Platform, type ProxyConfig, type FetchInit } from '@core/platform'
import { logger } from '@core/logger'
import type { Settings, UpdateInfo } from '@core/types'

/** 常见本机代理端口（v2rayN 10808/10809、clash 7890/7897、通用 socks 1080） */
const PROBE_PORTS = [10808, 7890, 10809, 7897, 1080]

/**
 * Windows/Electron 平台实现：core 里的平台钩子在这里全部用 Electron 原生能力落地。
 * 逻辑与抽离前完全一致（DPAPI 加密、Chromium 网络栈 + persist:googled 会话、
 * 内嵌登录窗口、注册表自启动、NSIS 安装器拉起）。
 */
class ElectronPlatform implements Platform {
  version(): string {
    return app.getVersion()
  }

  isPackaged(): boolean {
    return app.isPackaged
  }

  userDataDir(): string {
    return app.getPath('userData')
  }

  downloadsDir(): string {
    return app.getPath('downloads')
  }

  /** token 用 safeStorage（Windows DPAPI）加密 */
  encryptString(plain: string): string | null {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.encryptString(plain).toString('base64')
  }

  decryptString(enc: string): string | null {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      return null
    }
  }

  async applyProxy(conf: ProxyConfig): Promise<void> {
    const ses = session.fromPartition('persist:googled')
    await ses.setProxy(conf as Electron.ProxyConfig)
  }

  fetch(url: string, init: FetchInit): Promise<Response> {
    return net.fetch(url, {
      ...init,
      useSession: true,
      session: 'persist:googled'
    } as RequestInit)
  }

  async fetchViaProxy(rules: string, url: string, init: FetchInit): Promise<Response> {
    const ses = session.fromPartition('update-dl')
    await ses.setProxy({ proxyRules: rules })
    return net.fetch(url, { ...init, session: ses } as RequestInit)
  }

  /** 探测本机常见代理端口（连接被拒=秒失败；有响应即视为可用） */
  async probeLocalProxies(): Promise<string[]> {
    const probeSes = session.fromPartition('update-dl-probe')
    const found: string[] = []
    for (const port of PROBE_PORTS) {
      for (const rules of [`http=127.0.0.1:${port};https=127.0.0.1:${port}`, `socks5://127.0.0.1:${port}`]) {
        try {
          await probeSes.setProxy({ proxyRules: rules })
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 2500)
          try {
            const res = await net.fetch('https://github.com', {
              session: probeSes,
              signal: controller.signal,
              cache: 'no-store'
            } as RequestInit)
            void res.body?.cancel()
            if (res.status > 0) {
              found.push(rules)
              break
            }
          } finally {
            clearTimeout(timer)
          }
        } catch {
          /* 该端口/协议不通，继续探测 */
        }
        if (found.length) break
      }
      if (found.length) break
    }
    return found
  }

  pickUpdateAsset(assets: { name: string; browser_download_url: string }[]): { name: string; url: string } | null {
    const asset =
      assets.find((a) => a.name.endsWith('.exe') && a.name.includes('Setup')) || assets.find((a) => a.name.endsWith('.exe'))
    return asset ? { name: asset.name, url: asset.browser_download_url } : null
  }

  /** 下载完成后分离进程拉起 NSIS 安装器，退出应用让安装向导接管 */
  async applyUpdate(filePath: string, _info: UpdateInfo): Promise<void> {
    logger.info(`启动安装器：${filePath}`)
    const child = spawn(filePath, [], { detached: true, stdio: 'ignore', cwd: app.getPath('userData') })
    child.unref()
    setTimeout(() => app.quit(), 800)
  }

  /** 状态推送给所有渲染窗口 */
  broadcast(channel: string, payload?: unknown): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  }

  openExternal(url: string): void {
    void shell.openExternal(url)
  }

  private authWindow: BrowserWindow | null = null

  /**
   * 应用内独立登录窗口：
   * - 使用独立 session 分区（persist:googled-auth），与用户浏览器 / 其他配置文件完全隔离，
   *   多账号用户不会被默认浏览器的登录态带偏，窗口里自己选账号
   * - Google 回调到本地 127.0.0.1 时，成功页直接显示在本窗口里
   */
  async openAuthWindow(url: string): Promise<void> {
    const ses = session.fromPartition('persist:googled-auth')
    const win = new BrowserWindow({
      width: 500,
      height: 760,
      title: '登录 Google 账号',
      autoHideMenuBar: true,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })
    this.authWindow = win
    win.on('closed', () => {
      this.authWindow = null
    })
    await win.loadURL(url)
  }

  closeAuthWindow(): void {
    const win = this.authWindow
    if (!win) return
    if (!win.isDestroyed()) win.close()
    this.authWindow = null
  }

  async clearAuthSession(): Promise<void> {
    await session.fromPartition('persist:googled-auth').clearStorageData()
  }

  async pickFiles(title: string): Promise<string[]> {
    const win = BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title,
      properties: ['openFile', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  }

  async pickFolder(title: string): Promise<string | null> {
    const win = BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  }

  /** 设置保存后联动：原生主题 + 自启动注册表 */
  onSettingsApplied(s: Settings): void {
    applyNativeTheme(s)
    void applyAutoStart(s)
  }
}

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

/** 删掉启动项里指向本应用的所有残留条目（不同 Electron 版本写的值名不同，会重复导致开机双开） */
async function removeStaleRunEntries(): Promise<void> {
  const query = await new Promise<string>((resolve) => {
    const c = spawn('reg', ['query', RUN_KEY], { stdio: ['ignore', 'pipe', 'ignore'] })
    let buf = ''
    c.stdout?.on('data', (d) => (buf += String(d)))
    c.on('exit', () => resolve(buf))
    c.on('error', () => resolve(''))
  })
  const names = query
    .split(/\r?\n/)
    .filter((l) => l.includes('REG_SZ') && l.toLowerCase().includes('googled.exe'))
    .map((l) => l.trim().split(/\s{2,}/)[0])
    .filter(Boolean)
  await Promise.all(
    names.map(
      (n) =>
        new Promise<void>((resolve) => {
          const c = spawn('reg', ['delete', RUN_KEY, '/v', n, '/f'], { stdio: 'ignore' })
          c.on('exit', () => resolve())
          c.on('error', () => resolve())
        })
    )
  )
  if (names.length) logger.info(`清理重复启动项 ${names.length} 条`)
}

/** 把原生窗口标题栏/系统控件主题与应用内设置联动（否则暗色模式下原生标题栏还是系统默认的白色） */
export function applyNativeTheme(s: Settings): void {
  nativeTheme.themeSource = s.theme === 'dark' ? 'dark' : 'light'
}

/** 应用开机自启动到系统登录项。仅打包版写入（dev 模式不把 electron.exe 注册成开机启动）；
 * 静默模式通过 --hidden 参数传递，主进程据此决定是否弹主窗口 */
export async function applyAutoStart(s: Settings): Promise<void> {
  if (!app.isPackaged) return
  await removeStaleRunEntries()
  app.setLoginItemSettings({
    openAtLogin: !!s.autoStart,
    path: process.execPath,
    args: s.autoStartHidden ? ['--hidden'] : []
  })
}

/** 主进程入口最先调用：注入平台实现 */
export function initPlatform(): void {
  setPlatform(new ElectronPlatform())
}
