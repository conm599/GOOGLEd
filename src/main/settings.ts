import { app, nativeTheme, safeStorage } from 'electron'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DEFAULT_SETTINGS, type Settings, type AuthUserInfo } from '../shared/types'
import { logger } from './logger'

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json')
const AUTH_FILE = () => path.join(app.getPath('userData'), 'auth.json')

interface StoredTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  user?: AuthUserInfo
}

let cache: Settings | null = null

export function loadSettings(): Settings {
  if (cache) return cache
  let s: Settings = { ...DEFAULT_SETTINGS }
  try {
    if (fs.existsSync(SETTINGS_FILE())) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf-8')) as Partial<Settings>
      s = { ...DEFAULT_SETTINGS, ...raw }
    }
  } catch (e) {
    logger.warn('settings.json 读取失败，使用默认配置', e)
  }
  if (!s.downloadDir) {
    try {
      s.downloadDir = app.getPath('downloads')
    } catch {
      s.downloadDir = ''
    }
  }
  cache = s
  return s
}

export function saveSettings(s: Settings): void {
  cache = s
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true })
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2), 'utf-8')
  logger.info('设置已保存', { netMode: s.netMode, workerBase: s.workerBase })
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

/** token 用 safeStorage（Windows DPAPI）加密落盘，绝不明文保存 */
export function loadTokens(): StoredTokens | null {
  try {
    if (!fs.existsSync(AUTH_FILE())) return null
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE(), 'utf-8')) as { enc?: string; plain?: StoredTokens }
    if (raw.enc && safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.decryptString(Buffer.from(raw.enc, 'base64'))
      return JSON.parse(buf) as StoredTokens
    }
    if (raw.plain) return raw.plain
    return null
  } catch (e) {
    logger.error('auth.json 读取失败', e)
    return null
  }
}

export function saveTokens(t: StoredTokens): void {
  const file = AUTH_FILE()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(JSON.stringify(t))
    fs.writeFileSync(file, JSON.stringify({ enc: enc.toString('base64') }), 'utf-8')
  } else {
    logger.warn('safeStorage 不可用，token 将以明文保存在本机（仅本机可读）')
    fs.writeFileSync(file, JSON.stringify({ plain: t }), 'utf-8')
  }
}

export function clearTokens(): void {
  try {
    fs.rmSync(AUTH_FILE(), { force: true })
  } catch {
    /* ignore */
  }
}

export type { StoredTokens }
