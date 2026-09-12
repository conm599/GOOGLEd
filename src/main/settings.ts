import { app, safeStorage } from 'electron'
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

/** 应用开机自启动到系统登录项。仅打包版写入（dev 模式不把 electron.exe 注册成开机启动）；
 * 静默模式通过 --hidden 参数传递，主进程据此决定是否弹主窗口 */
export function applyAutoStart(s: Settings): void {
  if (!app.isPackaged) return
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
